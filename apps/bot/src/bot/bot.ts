import { Input, Telegraf, type Context } from 'telegraf';
import { message } from 'telegraf/filters';
import type { InlineKeyboardButton } from 'telegraf/types';
import type { AppConfig } from '@tg-games/core/config.js';
import type { ILLMProvider } from '@tg-games/core/llm/ILLMProvider.js';
import type { IMediaProvider, MediaCallMeta } from '@tg-games/core/media/IMediaProvider.js';
import { MediaGenerationError } from '@tg-games/core/media/IMediaProvider.js';
import type { TurnHistoryEntry } from '@tg-games/core/types.js';
import {
  buildInitialState,
  type GameManifest,
} from '@tg-games/core/games/manifests.js';
import {
  getGameManifest,
  getGameTitleMap,
  listGameManifests,
} from '@tg-games/core/db/repositories/gameManifests.js';
import { calcLLMCost, getHintsWithLog, processTurn } from '@tg-games/core/engine/reducer.js';
import { MissingActiveSchemaError } from '@tg-games/core/engine/schemaEngine.js';
import { generateIllustrationViaSchema } from '@tg-games/core/media/illustrationSchema.js';
import { findModelPricing, type TokenUsage } from '@tg-games/core/llm/pricing.js';
import type { LLMCallLogEntry } from '@tg-games/core/llm/trace.js';
import { createModelRouter, type ModelRouter } from '@tg-games/core/llm/router.js';
import { createDefaultEmbeddingProvider } from '@tg-games/core/llm/factory.js';
import {
  buildLlmRequestLogInputs,
  insertLlmRequestLogsSafely,
} from '@tg-games/core/db/repositories/llmLogs.js';
import { upsertUser, setActiveSession, type UserRow } from '@tg-games/core/db/repositories/users.js';
import {
  addUserGroup,
  getGameGroup,
  isValidGroupId,
} from '@tg-games/core/db/repositories/gameGroups.js';
import {
  acquireProcessingLock,
  addAllocatedMillicents,
  addTokenUsageAndCost,
  addUsedCredits,
  countUserSessions,
  createSession,
  finishSession,
  getActiveSession,
  getSessionById,
  listUserSessions,
  releaseProcessingLock,
  updateSessionState,
  type SessionRow,
} from '@tg-games/core/db/repositories/sessions.js';
import {
  cancelLastStep,
  getStepWithOwner,
  insertStep,
  listSteps,
  type StepRow,
} from '@tg-games/core/db/repositories/steps.js';
import {
  insertMemoryCellsSafely,
  listActiveMemoryCells,
} from '@tg-games/core/db/repositories/memoryCells.js';
import { createPayment, markPaymentPaid } from '@tg-games/core/db/repositories/payments.js';
import {
  getUserMediaConfig,
  setUserImageModel,
  setUserImageSize,
  setUserTtsModel,
  setUserTtsVoice,
  userMediaConfigValues,
} from '@tg-games/core/db/repositories/userMediaConfig.js';
import {
  findImageModelOption,
  findTtsModelOption,
  mediaOptionsForProvider,
  resolveEffectiveMediaConfig,
  type MediaConfigSubject,
  type UserMediaConfigValues,
} from '@tg-games/core/media/userConfig.js';
import {
  BTN,
  BUY_STARS_HELP,
  BUY_STARS_URL,
  CONFIG_HOME_CALLBACK,
  DRAW_PREFIX,
  TOP_UP_STEPS,
  TTS_PREFIX,
  activeGamesKeyboard,
  characterPresetsKeyboard,
  finishedGamesKeyboard,
  gameListKeyboard,
  gameMenuKeyboard,
  helpKeyboard,
  hintsKeyboard,
  locationPresetsKeyboard,
  mainMenuKeyboard,
  mediaConfigModelsKeyboard,
  mediaConfigSizesKeyboard,
  mediaConfigSubjectsKeyboard,
  mediaConfigVoicesKeyboard,
  sceneActionsKeyboard,
  topUpKeyboard,
  topUpStepsForBalance,
  type SceneActionCaps,
} from './menus.js';
import {
  formatCharacterPresets,
  formatHints,
  formatHistory,
  formatLocationPresets,
  formatStatus,
} from './format.js';
import {
  formatMediaTesterReport,
  type MediaTesterReport,
} from './testerLog.js';
import {
  clearPendingTopUpAction,
  getHint,
  getPendingTopUpAction,
  setLastHints,
  setPendingTopUpAction,
} from './userState.js';
import {
  sendProgress,
  sendMediaProgress,
  sendVoiceProgress,
  HINT_IN_PROGRESS_TEXT,
  SCHEMA_UNAVAILABLE_TEXT,
} from './progress.js';

const HELP_TEXT = [
  '🎮 *Telegram LLM RPG Bot*',
  '',
  'Это текстовая RPG, где каждый ваш ход обрабатывает ИИ.',
  '',
  '*Команды:*',
  '/start — начать и зарегистрироваться',
  '/menu — показать меню',
  '/config — настройки озвучки и иллюстраций',
  '/cancel — отменить последний ход',
  '/help — эта справка',
  '',
  '*Как играть:*',
  '1. «Начать новую игру» — выбрать и купить сценарий за Telegram Stars ⭐️.',
  '2. «Действие» — ввести, что вы делаете, текстом.',
  '3. «Подсказка» — получить варианты действий от ИИ.',
  '4. «Статус» — посмотреть характеристики персонажа.',
].join('\n');

const NO_ACTIVE_GAME = 'У вас нет активной игры. Нажмите «Начать новую игру».';

const CREDITS_EXHAUSTED_MESSAGE =
  'Кредиты для этой игры исчерпаны. Выберите сумму пополнения, чтобы продолжить.';

const NO_TOP_UP_OPTIONS_MESSAGE =
  'Кредиты для этой игры исчерпаны. Доступных ступеней пополнения нет: перерасход больше 10 ⭐️.';

const NO_AVAILABLE_GAMES =
  'В ваших группах пока нет доступных сценариев. Используйте /mygroups, чтобы посмотреть группы.';

const GAME_UNAVAILABLE_MESSAGE = 'Сценарий недоступен для ваших групп.';

/**
 * Создаёт и настраивает экземпляр Telegraf-бота.
 *
 * Все зависимости (конфиг, LLM-провайдер, провайдер медиа) передаются явно,
 * что упрощает тестирование и не завязывает обработчики на глобальное
 * состояние. `media` необязателен: при `null` кнопки «Озвучить»/«Нарисовать
 * иллюстрацию» не показываются и медиа-обработчики не срабатывают (issue #71).
 */
export function createBot(
  config: AppConfig,
  provider: ILLMProvider,
  media: IMediaProvider | null = null,
): Telegraf {
  const bot = new Telegraf(config.telegramBotToken);

  // Какие кнопки сцены показывать — по возможностям медиа-провайдера (issue #71).
  const sceneCaps: SceneActionCaps = {
    canSpeak: Boolean(media?.canSpeak),
    canDraw: Boolean(media?.canDraw),
  };

  // ===== Команды =====

  bot.start(async (ctx) => {
    await upsertUser(ctx.from.id, ctx.from.username);
    await ctx.reply(
      'Добро пожаловать в текстовую RPG! 🎲\nНажмите «Начать новую игру», чтобы выбрать сценарий.',
      await menuFor(ctx.from.id),
    );
  });

  bot.command('menu', async (ctx) => {
    await ctx.reply('Меню:', await menuFor(ctx.from.id));
  });

  bot.command('config', async (ctx) => {
    await replyMediaConfigHome(ctx, config, sceneCaps);
  });

  bot.command('group', async (ctx) => {
    const groupId = parseCommandArgument(ctx.message.text);
    if (!groupId) {
      await ctx.reply('Укажите группу: /group group_name');
      return;
    }
    if (!isValidGroupId(groupId)) {
      await ctx.reply('Некорректный group_name. Используйте латиницу, цифры, "-" или "_".');
      return;
    }
    const group = await getGameGroup(groupId);
    if (!group) {
      await ctx.reply('Группа не найдена.');
      return;
    }
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const updated = await addUserGroup(user.id, groupId);
    if (!updated) {
      await ctx.reply('Не удалось добавить группу. Попробуйте ещё раз.');
      return;
    }
    await ctx.reply(
      [
        `Группа ${groupId} добавлена.`,
        '',
        formatUserGroups(updated),
        '',
        await formatAvailableGames(updated),
      ].join('\n'),
    );
  });

  bot.command('mygroups', async (ctx) => {
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    await ctx.reply(formatUserGroups(user));
  });

  // Отмена последнего хода (issue #116). Ход помечается отменённым в истории,
  // а состояние мира откатывается к моменту до этого хода. Команду можно
  // повторять, отменяя ходы по одному.
  bot.command('cancel', async (ctx) => {
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const session = await getActiveSession(user.id);
    if (!session) {
      await ctx.reply(NO_ACTIVE_GAME);
      return;
    }
    // Не отменяем ход, пока выполняется другой ход: захватываем ту же блокировку.
    const locked = await acquireProcessingLock(session.id);
    if (!locked) {
      await ctx.reply('Предыдущее действие ещё обрабатывается. Подождите.');
      return;
    }
    try {
      const cancelled = await cancelLastStep(session.id);
      if (!cancelled) {
        await ctx.reply('Отменять нечего — в этой игре ещё нет ходов.', gameMenuKeyboard());
        return;
      }
      const action = cancelled.action_text?.trim() || '—';
      if (cancelled.state_before != null) {
        await ctx.reply(
          `↩️ Ход отменён: «${action}».\nСостояние игры восстановлено.`,
          gameMenuKeyboard(),
        );
        await ctx.reply(formatStatus(cancelled.state_before, session));
      } else {
        // Старый ход без снимка состояния: помечаем отменённым, но откатить
        // состояние не можем.
        await ctx.reply(
          `↩️ Ход отменён: «${action}».\nСостояние игры откатить не удалось (нет сохранённого снимка).`,
          gameMenuKeyboard(),
        );
      }
    } finally {
      await releaseProcessingLock(session.id);
    }
  });

  bot.help((ctx) =>
    ctx.reply(HELP_TEXT, { parse_mode: 'Markdown', ...helpKeyboard(config.support.botUsername) }),
  );
  bot.hears(BTN.help, (ctx) =>
    ctx.reply(HELP_TEXT, { parse_mode: 'Markdown', ...helpKeyboard(config.support.botUsername) }),
  );

  // ===== Кнопки нижнего меню =====

  bot.hears(BTN.newGame, async (ctx) => {
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const games = await availableGamesForUser(user);
    if (games.length === 0) {
      await ctx.reply(NO_AVAILABLE_GAMES);
      return;
    }
    await ctx.reply('Выберите игру:', gameListKeyboard(games));
  });

  bot.hears(BTN.myGames, async (ctx) => {
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const sessions = await listUserSessions(user.id);
    if (sessions.length === 0) {
      await ctx.reply('У вас пока нет игр. Нажмите «Начать новую игру».');
      return;
    }
    const active = sessions.filter((s) => s.is_active);
    const finished = sessions.filter((s) => !s.is_active);
    const gameTitles = await getGameTitleMap(sessions.map((s) => s.game_id));

    // Первое сообщение — активные игры (клик переключает текущую игру).
    if (active.length > 0) {
      await ctx.reply(
        '🟢 Активные игры (нажмите, чтобы продолжить):',
        activeGamesKeyboard(active, gameTitles),
      );
    } else {
      await ctx.reply('🟢 Активных игр нет. Нажмите «Начать новую игру».');
    }

    // Второе сообщение — завершённые игры (клик присылает историю ходов).
    if (finished.length > 0) {
      await ctx.reply(
        '⚪️ Завершённые игры (нажмите, чтобы посмотреть историю):',
        finishedGamesKeyboard(finished, gameTitles),
      );
    }
  });

  bot.hears(BTN.status, async (ctx) => {
    const session = await activeSessionFor(ctx.from.id, ctx.from.username);
    if (!session) {
      await ctx.reply(NO_ACTIVE_GAME);
      return;
    }
    await ctx.reply(formatStatus(session.current_state, session));
  });

  bot.hears(BTN.action, async (ctx) => {
    const session = await activeSessionFor(ctx.from.id, ctx.from.username);
    if (!session) {
      await ctx.reply(NO_ACTIVE_GAME);
      return;
    }
    await ctx.reply('Введите ваше следующее действие текстом:');
  });

  bot.hears(BTN.hint, async (ctx) => {
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const session = await getActiveSession(user.id);
    if (!session) {
      await ctx.reply(NO_ACTIVE_GAME);
      return;
    }
    if (session.is_processing) {
      await ctx.reply('Предыдущее действие ещё обрабатывается. Подождите.');
      return;
    }
    if (isCreditsExhausted(session)) {
      await replyCreditsExhausted(ctx, session, config);
      return;
    }
    // Сразу сообщаем игроку, что поиск начался. По завершении текст этого же
    // сообщения заменится на список подсказок (issue #43).
    const sent = await ctx.reply(HINT_IN_PROGRESS_TEXT);
    const chatId = sent.chat?.id ?? ctx.chat?.id;
    const messageId = sent.message_id;
    const updateHint = async (text: string, extra?: Parameters<typeof ctx.telegram.editMessageText>[4]) => {
      await ctx.telegram.editMessageText(chatId, messageId, undefined, text, extra);
    };

    await ctx.sendChatAction('typing');
    const steps = await listSteps(session.id);
    // Подсказки используют тот же глобальный default model, что и остальные
    // текстовые LLM-запросы (issue #345).
    const router = createModelRouter(config, provider);
    const hintRoute = await router.resolve();
    let hints: string[];
    let llmLog: LLMCallLogEntry[];
    let creditsUsed: number;
    let tokenUsage: TokenUsage;
    let costMillicents: number;
    try {
      ({ hints, llmLog, creditsUsed, tokenUsage, costMillicents } = await getHintsWithLog(
        hintRoute.provider,
        session.current_state,
        config.llm.maxRetries,
        turnHistoryFromSteps(steps),
        hintRoute.pricing,
        session.id,
        session.game_id,
      ));
    } catch (err) {
      // issue #238: подсказки генерирует ТОЛЬКО активная hint-схема. Legacy
      // удалён — при отсутствии схемы доставляем игроку ошибку вместо зависшего
      // «поиска…».
      if (err instanceof MissingActiveSchemaError) {
        console.error(`[schema-engine] hint: ${err.message}`);
        await updateHint(SCHEMA_UNAVAILABLE_TEXT);
        return;
      }
      throw err;
    }
    await addUsedCredits(session.id, creditsUsed);
    await addTokenUsageAndCost(session.id, tokenUsage, costMillicents);
    await saveRoutedTextLlmRequestLogs({
      entries: llmLog,
      config,
      router,
      userId: user.id,
      sessionId: session.id,
      label: 'подсказки',
    });
    if (hints.length === 0) {
      await updateHint('Не удалось придумать подсказки. Попробуйте ещё раз.');
      return;
    }
    setLastHints(ctx.from.id, hints);
    // Заменяем прогресс-сообщение нумерованным списком действий с кнопками.
    await updateHint(formatHints(hints), hintsKeyboard(hints));
  });

  // ===== Inline-кнопки =====

  bot.action(CONFIG_HOME_CALLBACK, async (ctx) => {
    await ctx.answerCbQuery();
    await editMediaConfigHome(ctx, config, sceneCaps);
  });

  bot.action(/^cfg:subject:(tts|image)$/, async (ctx) => {
    const subject = ctx.match[1] as MediaConfigSubject;
    await ctx.answerCbQuery();
    await editMediaConfigModelChoice(ctx, config, sceneCaps, subject);
  });

  bot.action(/^cfg:tts:model:(.+)$/, async (ctx) => {
    const model = ctx.match[1];
    const modelOption = findTtsModelOption(config.media.provider, model);
    if (!modelOption || !sceneCaps.canSpeak) {
      await ctx.answerCbQuery('Эта модель озвучки недоступна.', { show_alert: false });
      return;
    }
    await ctx.answerCbQuery();
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const saved = await setUserTtsModel(user.id, model);
    await editMediaConfigTtsVoiceChoice(
      ctx,
      config,
      modelOption,
      userMediaConfigValues(saved),
    );
  });

  bot.action(/^cfg:tts:voice:(.+)$/, async (ctx) => {
    const voice = ctx.match[1];
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const currentConfig = userMediaConfigValues(await getUserMediaConfig(user.id));
    const effective = resolveEffectiveMediaConfig(config.media, currentConfig);
    const modelOption = findTtsModelOption(config.media.provider, effective.tts.model);
    if (!sceneCaps.canSpeak || !modelOption?.voices.some((option) => option.id === voice)) {
      await ctx.answerCbQuery('Этот голос недоступен.', { show_alert: false });
      return;
    }
    await ctx.answerCbQuery();
    const saved = await setUserTtsVoice(user.id, voice);
    await editMediaConfigHome(ctx, config, sceneCaps, userMediaConfigValues(saved), 'Озвучка обновлена.');
  });

  bot.action(/^cfg:image:model:(.+)$/, async (ctx) => {
    const model = ctx.match[1];
    const modelOption = findImageModelOption(config.media.provider, model);
    if (!modelOption || !sceneCaps.canDraw) {
      await ctx.answerCbQuery('Эта модель иллюстраций недоступна.', { show_alert: false });
      return;
    }
    await ctx.answerCbQuery();
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const saved = await setUserImageModel(user.id, model);
    await editMediaConfigImageSizeChoice(
      ctx,
      config,
      modelOption,
      userMediaConfigValues(saved),
    );
  });

  bot.action(/^cfg:image:size:(.+)$/, async (ctx) => {
    const size = ctx.match[1];
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const currentConfig = userMediaConfigValues(await getUserMediaConfig(user.id));
    const effective = resolveEffectiveMediaConfig(config.media, currentConfig);
    const modelOption = findImageModelOption(config.media.provider, effective.image.model);
    if (!sceneCaps.canDraw || !modelOption?.sizes.some((option) => option.id === size)) {
      await ctx.answerCbQuery('Этот размер недоступен.', { show_alert: false });
      return;
    }
    await ctx.answerCbQuery();
    const saved = await setUserImageSize(user.id, size);
    await editMediaConfigHome(
      ctx,
      config,
      sceneCaps,
      userMediaConfigValues(saved),
      'Иллюстрации обновлены.',
    );
  });

  // Выбор игры из списка → предлагаем выбрать персонажа (issue #60).
  bot.action(/^game:(.+)$/, async (ctx) => {
    const gameId = ctx.match[1];
    const manifest = await getGameManifest(gameId);
    await ctx.answerCbQuery();
    if (!manifest) {
      await ctx.reply('Игра не найдена.');
      return;
    }
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    if (!canUserAccessGame(user, gameId)) {
      await ctx.reply(GAME_UNAVAILABLE_MESSAGE);
      return;
    }
    await ctx.reply(
      `🎮 Игра «${manifest.name}».\n\n${formatCharacterPresets(manifest.characterPresets)}`,
      characterPresetsKeyboard(gameId, manifest.characterPresets),
    );
  });

  // Выбор персонажа → предлагаем выбрать стартовую локацию (issue #60).
  bot.action(/^char:(.+):(\d+)$/, async (ctx) => {
    const gameId = ctx.match[1];
    const characterIndex = Number(ctx.match[2]);
    const manifest = await getGameManifest(gameId);
    await ctx.answerCbQuery();
    if (!manifest) {
      await ctx.reply('Игра не найдена.');
      return;
    }
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    if (!canUserAccessGame(user, gameId)) {
      await ctx.reply(GAME_UNAVAILABLE_MESSAGE);
      return;
    }
    const preset = manifest.characterPresets[characterIndex];
    if (!preset) {
      await ctx.reply('Персонаж не найден. Начните выбор заново.');
      return;
    }
    // Убираем кнопки выбора персонажа, чтобы исключить повторный выбор.
    await ctx.editMessageReplyMarkup(undefined);
    await ctx.reply(
      `Вы выбрали персонажа: ${preset.name}.\n\n${formatLocationPresets(manifest.locationPresets)}`,
      locationPresetsKeyboard(gameId, characterIndex, manifest.locationPresets),
    );
  });

  // Выбор локации → сразу триал (первая игра) или инвойс (остальные) (issue #60).
  bot.action(/^loc:(.+):(\d+):(\d+)$/, async (ctx) => {
    const gameId = ctx.match[1];
    const characterIndex = Number(ctx.match[2]);
    const locationIndex = Number(ctx.match[3]);
    const manifest = await getGameManifest(gameId);
    await ctx.answerCbQuery();
    if (!manifest) {
      await ctx.reply('Игра не найдена.');
      return;
    }
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    if (!canUserAccessGame(user, gameId)) {
      await ctx.reply(GAME_UNAVAILABLE_MESSAGE);
      return;
    }
    if (!manifest.characterPresets[characterIndex] || !manifest.locationPresets[locationIndex]) {
      await ctx.reply('Выбор устарел. Начните новую игру заново.');
      return;
    }
    // Убираем кнопки выбора локации, чтобы исключить повторный выбор.
    await ctx.editMessageReplyMarkup(undefined);

    const initialState = buildInitialState(manifest, characterIndex, locationIndex);

    // Первая игра — триал, тестер — бесплатный запуск без фактической оплаты.
    const sessionCount = await countUserSessions(user.id);
    if (sessionCount === 0 || user.is_tester) {
      const isTrial = sessionCount === 0;
      const allocatedMillicents = user.is_tester
        ? config.millicentsPerStar * manifest.priceStars
        : config.millicentsPerStar;
      const session = await createSession(
        user.id,
        manifest.id,
        initialState,
        allocatedMillicents,
      );
      await createPayment({
        userId: user.id,
        amount: 0,
        status: 'paid',
        payload: {
          gameId,
          characterIndex,
          locationIndex,
          trial: isTrial,
          tester: user.is_tester,
          sessionId: session.id,
        },
      });
      const label = user.is_tester ? 'режим тестировщика' : 'пробная версия';
      await ctx.reply(
        `🎮 Игра «${manifest.name}» началась! (${label})\n\n${initialState.narrative}`,
        gameMenuKeyboard(),
      );
      return;
    }

    // Не первая игра — выставляем счёт с выбранными пресетами.
    const payment = await createPayment({
      userId: user.id,
      amount: manifest.priceStars,
      payload: { gameId, characterIndex, locationIndex },
    });
    // payload счёта ограничен 128 байтами — храним компактно.
    const invoicePayload = JSON.stringify({
      p: payment.id,
      g: gameId,
      c: characterIndex,
      l: locationIndex,
    });
    await ctx.replyWithInvoice({
      title: manifest.name,
      description: manifest.description,
      payload: invoicePayload,
      provider_token: '', // для Telegram Stars токен провайдера не нужен
      currency: 'XTR',
      prices: [{ label: manifest.name, amount: manifest.priceStars }],
    });
  });

  // Клик по подсказке → скрываем кнопки в сообщении, отправляем действие в обработку.
  bot.action(/^hint:(\d+)$/, async (ctx) => {
    const index = Number(ctx.match[1]);
    const action = getHint(ctx.from.id, index);
    await ctx.answerCbQuery();
    if (!action) {
      await ctx.reply('Подсказка устарела. Запросите её заново.');
      return;
    }
    // Убираем inline-кнопки из сообщения сразу после клика, чтобы исключить повторный клик.
    await ctx.editMessageReplyMarkup(undefined);
    await handlePlayerAction(ctx, provider, config, sceneCaps, ctx.from.id, ctx.from.username, action);
  });

  // Кнопка «🔊 Озвучить» под результатом действия → присылаем озвучку сцены (issue #71).
  bot.action(/^tts:(.+)$/, async (ctx) => {
    await handleMediaCallback(ctx, media, config, 'tts', ctx.match[1]);
  });

  // Кнопка «🎨 Нарисовать иллюстрацию» → присылаем картинку по сцене (issue #71).
  bot.action(/^draw:(.+)$/, async (ctx) => {
    await handleMediaCallback(ctx, media, config, 'draw', ctx.match[1]);
  });

  // Кнопка пополнения → создаём инвойс на выбранную ступень кредитов.
  bot.action(/^topup:([^:]+)(?::(\d+))?$/, async (ctx) => {
    const sessionId = ctx.match[1];
    const topUpStars = parseTopUpStars(ctx.match[2]);
    await ctx.answerCbQuery();
    if (topUpStars === null) {
      await ctx.reply('Эта сумма пополнения недоступна. Выберите одну из предложенных кнопок.');
      return;
    }
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const session = await getSessionById(sessionId, user.id);
    if (!session) {
      await ctx.reply('Игра не найдена.');
      return;
    }
    const availableSteps = topUpStepsForBalance(session, config.millicentsPerStar);
    if (!availableSteps.includes(topUpStars)) {
      await ctx.reply(
        availableSteps.length > 0
          ? 'Эта сумма уже не покрывает перерасход по игре. Выберите актуальную ступень пополнения.'
          : NO_TOP_UP_OPTIONS_MESSAGE,
        topUpKeyboard(session.id, availableSteps),
      );
      return;
    }
    if (user.is_tester) {
      const addedMillicents = config.millicentsPerStar * topUpStars;
      await addAllocatedMillicents(session.id, addedMillicents);
      await createPayment({
        userId: user.id,
        amount: 0,
        status: 'paid',
        payload: { type: 'topup', sessionId, amount: topUpStars, tester: true },
      });
      if (
        await runPendingTopUpAction(
          ctx,
          provider,
          config,
          sceneCaps,
          user,
          ctx.from.id,
          sessionWithAdditionalBudget(session, addedMillicents),
        )
      ) {
        return;
      }
      await ctx.reply(
        `⭐️ Кредиты пополнены. Продолжайте игру!`,
        gameMenuKeyboard(),
      );
      return;
    }
    const payment = await createPayment({
      userId: user.id,
      amount: topUpStars,
      payload: { type: 'topup', sessionId, amount: topUpStars },
    });
    const invoicePayload = JSON.stringify({
      p: payment.id,
      type: 'topup',
      s: sessionId,
      a: topUpStars,
    });
    await ctx.replyWithInvoice({
      title: 'Продолжение игры',
      description: `Пополнение кредитов для продолжения игры на ${topUpStars} ⭐️`,
      payload: invoicePayload,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: 'Продолжение игры', amount: topUpStars }],
    });
  });

  // «Как купить TG звёзды» в сообщении «Помощь» → обновляем текст на инструкцию.
  // Без parse_mode: URL содержит «_», который ломает разбор Markdown; Telegram
  // и так делает ссылку кликабельной в обычном тексте.
  bot.action(BUY_STARS_HELP, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      ['⭐️ Как купить Telegram Stars', '', `Подробная инструкция: ${BUY_STARS_URL}`].join('\n'),
    );
  });

  // Клик по активной игре в «Мои игры» → делаем её текущей и шлём статус.
  bot.action(/^session:(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1];
    await ctx.answerCbQuery();
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const session = await getSessionById(sessionId, user.id);
    if (!session) {
      await ctx.reply('Игра не найдена.');
      return;
    }
    await setActiveSession(user.id, session.id);
    const manifest = await getGameManifest(session.game_id);
    await ctx.reply(
      `Вы продолжаете игру «${manifest?.name ?? session.game_id}».`,
      gameMenuKeyboard(),
    );
    await ctx.reply(formatStatus(session.current_state, session));
  });

  // Клик по завершённой игре в «Мои игры» → присылаем историю ходов.
  bot.action(/^history:(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1];
    await ctx.answerCbQuery();
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const session = await getSessionById(sessionId, user.id);
    if (!session) {
      await ctx.reply('Игра не найдена.');
      return;
    }
    const steps = await listSteps(session.id);
    const filename = `${session.game_id}_${session.id}_history.txt`;
    const document = Input.fromBuffer(Buffer.from(formatHistory(steps), 'utf8'), filename);
    await ctx.replyWithDocument(document);
  });

  // ===== Платежи =====

  // Telegram спрашивает подтверждение перед списанием — одобряем.
  bot.on('pre_checkout_query', async (ctx) => {
    await ctx.answerPreCheckoutQuery(true);
  });

  // Платёж прошёл — создаём активную сессию или пополняем кредиты.
  bot.on(message('successful_payment'), async (ctx) => {
    const sp = ctx.message.successful_payment;
    let parsed: { p?: string; g?: string; c?: number; l?: number; type?: string; s?: string; a?: number } = {};
    try {
      parsed = JSON.parse(sp.invoice_payload);
    } catch {
      // payload повреждён — ниже отработает проверка
    }

    const user = await upsertUser(ctx.from.id, ctx.from.username);

    // Пополнение кредитов для существующей игры.
    if (parsed.type === 'topup' && parsed.s) {
      const session = await getSessionById(parsed.s, user.id);
      if (!session) {
        await ctx.reply('Не удалось найти игру для пополнения. Обратитесь в поддержку.');
        return;
      }
      const topUpStars = paidTopUpStars(sp.total_amount, parsed.a);
      const addedMillicents = config.millicentsPerStar * topUpStars;
      await addAllocatedMillicents(session.id, addedMillicents);
      if (parsed.p) {
        await markPaymentPaid(parsed.p, sp.telegram_payment_charge_id, session.id);
      }
      if (
        await runPendingTopUpAction(
          ctx,
          provider,
          config,
          sceneCaps,
          user,
          ctx.from.id,
          sessionWithAdditionalBudget(session, addedMillicents),
        )
      ) {
        return;
      }
      await ctx.reply(
        `⭐️ Кредиты пополнены. Продолжайте игру!`,
        gameMenuKeyboard(),
      );
      return;
    }

    // Начало новой игры.
    const manifest = parsed.g ? await getGameManifest(parsed.g) : undefined;
    if (!manifest) {
      await ctx.reply('Не удалось определить купленную игру. Обратитесь в поддержку.');
      return;
    }
    if (!canUserAccessGame(user, manifest.id)) {
      await ctx.reply('Сценарий больше недоступен для ваших групп. Обратитесь в поддержку.');
      return;
    }
    const initialState = buildInitialState(manifest, parsed.c, parsed.l);
    const session = await createSession(user.id, manifest.id, initialState, config.millicentsPerStar * manifest.priceStars);
    if (parsed.p) {
      await markPaymentPaid(parsed.p, sp.telegram_payment_charge_id, session.id);
    }
    await ctx.reply(
      `🎮 Игра «${manifest.name}» началась!\n\n${initialState.narrative}`,
      gameMenuKeyboard(),
    );
  });

  // ===== Произвольный текст =====

  // Если у игрока есть активная игра, любое произвольное сообщение трактуется
  // как игровое действие — нажимать «Действие» предварительно не требуется.
  bot.on(message('text'), async (ctx) => {
    const session = await activeSessionFor(ctx.from.id, ctx.from.username);
    if (session) {
      await handlePlayerAction(
        ctx,
        provider,
        config,
        sceneCaps,
        ctx.from.id,
        ctx.from.username,
        ctx.message.text,
      );
      return;
    }
    await ctx.reply('Используйте кнопки меню. /menu — показать меню.', await menuFor(ctx.from.id));
  });

  // Голосовое сообщение игрока (STT, issue #118): если есть активная игра —
  // распознаём речь и выполняем полученный текст как игровое действие. Аудио
  // нигде не сохраняется: буфер живёт только в памяти на время распознавания.
  bot.on(message('voice'), async (ctx) => {
    const session = await activeSessionFor(ctx.from.id, ctx.from.username);
    if (!session) {
      await ctx.reply(
        'Используйте кнопки меню. /menu — показать меню.',
        await menuFor(ctx.from.id),
      );
      return;
    }
    await handleVoiceAction(ctx, media, provider, config, sceneCaps, {
      fileId: ctx.message.voice.file_id,
      mimeType: ctx.message.voice.mime_type,
    });
  });

  return bot;
}

async function replyMediaConfigHome(
  ctx: Context,
  config: AppConfig,
  sceneCaps: SceneActionCaps,
): Promise<void> {
  const userConfig = await readUserMediaConfig(ctx);
  await ctx.reply(
    formatMediaConfigHome(config, sceneCaps, userConfig),
    mediaConfigSubjectsKeyboard(sceneCaps),
  );
}

async function editMediaConfigHome(
  ctx: Context,
  config: AppConfig,
  sceneCaps: SceneActionCaps,
  userConfig?: UserMediaConfigValues | null,
  notice?: string,
): Promise<void> {
  const currentConfig = userConfig === undefined ? await readUserMediaConfig(ctx) : userConfig;
  await ctx.editMessageText(
    formatMediaConfigHome(config, sceneCaps, currentConfig, notice),
    mediaConfigSubjectsKeyboard(sceneCaps),
  );
}

async function editMediaConfigModelChoice(
  ctx: Context,
  config: AppConfig,
  sceneCaps: SceneActionCaps,
  subject: MediaConfigSubject,
): Promise<void> {
  if (!canConfigureSubject(sceneCaps, subject)) {
    await ctx.editMessageText(formatMediaConfigHome(config, sceneCaps, null));
    return;
  }
  const options = mediaOptionsForProvider(config.media.provider);
  if (!options) {
    await ctx.editMessageText(formatMediaConfigHome(config, sceneCaps, null));
    return;
  }
  const userConfig = await readUserMediaConfig(ctx);
  const effective = resolveEffectiveMediaConfig(config.media, userConfig);
  const currentModel = subject === 'tts' ? effective.tts.model : effective.image.model;
  const models = subject === 'tts' ? options.tts.models : options.image.models;
  await ctx.editMessageText(
    formatMediaModelChoice(config, subject, currentModel),
    mediaConfigModelsKeyboard(subject, models, currentModel),
  );
}

async function editMediaConfigTtsVoiceChoice(
  ctx: Context,
  config: AppConfig,
  modelOption: NonNullable<ReturnType<typeof findTtsModelOption>>,
  userConfig: UserMediaConfigValues | null,
): Promise<void> {
  const effective = resolveEffectiveMediaConfig(config.media, userConfig);
  await ctx.editMessageText(
    [
      'Настройки озвучки',
      '',
      `Провайдер: ${config.media.provider}`,
      `Модель: ${modelOption.id}`,
      `Текущий голос: ${effective.tts.voice}`,
      '',
      'Выберите голос:',
    ].join('\n'),
    mediaConfigVoicesKeyboard(modelOption.voices, effective.tts.voice),
  );
}

async function editMediaConfigImageSizeChoice(
  ctx: Context,
  config: AppConfig,
  modelOption: NonNullable<ReturnType<typeof findImageModelOption>>,
  userConfig: UserMediaConfigValues | null,
): Promise<void> {
  const effective = resolveEffectiveMediaConfig(config.media, userConfig);
  await ctx.editMessageText(
    [
      'Настройки иллюстраций',
      '',
      `Провайдер: ${config.media.provider}`,
      `Модель: ${modelOption.id}`,
      `Текущий размер: ${effective.image.size}`,
      '',
      'Выберите размер:',
    ].join('\n'),
    mediaConfigSizesKeyboard(modelOption.sizes, effective.image.size),
  );
}

async function readUserMediaConfig(ctx: Context): Promise<UserMediaConfigValues | null> {
  if (!ctx.from) return null;
  const user = await upsertUser(ctx.from.id, ctx.from.username);
  return userMediaConfigValues(await getUserMediaConfig(user.id));
}

function formatMediaConfigHome(
  config: AppConfig,
  sceneCaps: SceneActionCaps,
  userConfig: UserMediaConfigValues | null,
  notice?: string,
): string {
  const options = mediaOptionsForProvider(config.media.provider);
  const lines = notice ? [notice, ''] : [];
  lines.push('Настройки медиа', '', `Провайдер: ${config.media.provider}`, '');

  if (!options || (!sceneCaps.canSpeak && !sceneCaps.canDraw)) {
    lines.push('Медиа в проекте сейчас отключено или не поддерживается текущим провайдером.');
    return lines.join('\n');
  }

  const effective = resolveEffectiveMediaConfig(config.media, userConfig);
  lines.push(
    sceneCaps.canSpeak
      ? `Озвучка: ${effective.tts.model} / ${effective.tts.voice}`
      : 'Озвучка: выключена',
    sceneCaps.canDraw
      ? `Иллюстрации: ${effective.image.model} / ${effective.image.size}`
      : 'Иллюстрации: выключены',
    '',
    'Выберите, что настроить:',
  );
  return lines.join('\n');
}

function formatMediaModelChoice(
  config: AppConfig,
  subject: MediaConfigSubject,
  currentModel: string,
): string {
  return [
    subject === 'tts' ? 'Настройки озвучки' : 'Настройки иллюстраций',
    '',
    `Провайдер: ${config.media.provider}`,
    `Текущая модель: ${currentModel}`,
    '',
    'Выберите модель:',
  ].join('\n');
}

function canConfigureSubject(sceneCaps: SceneActionCaps, subject: MediaConfigSubject): boolean {
  return subject === 'tts' ? sceneCaps.canSpeak : sceneCaps.canDraw;
}

function parseCommandArgument(text: string): string | null {
  const parts = text.trim().split(/\s+/);
  return parts[1]?.trim() || null;
}

function userGameIds(user: Pick<UserRow, 'game_ids'>): Set<string> {
  return new Set(Array.isArray(user.game_ids) ? user.game_ids : []);
}

export async function availableGamesForUser(
  user: Pick<UserRow, 'game_ids'>,
): Promise<GameManifest[]> {
  return listGameManifests([...userGameIds(user)]);
}

export function canUserAccessGame(
  user: Pick<UserRow, 'game_ids'>,
  gameId: string,
): boolean {
  return userGameIds(user).has(gameId);
}

function formatUserGroups(user: Pick<UserRow, 'groups'>): string {
  const groups = Array.isArray(user.groups) ? user.groups : [];
  if (groups.length === 0) return 'Ваши группы: нет групп.';
  return ['Ваши группы:', ...groups.map((group) => `- ${group}`)].join('\n');
}

async function formatAvailableGames(user: Pick<UserRow, 'game_ids'>): Promise<string> {
  const games = await availableGamesForUser(user);
  if (games.length === 0) return 'Доступные сценарии: нет.';
  return ['Доступные сценарии:', ...games.map((game) => `- ${game.name}`)].join('\n');
}

/** Возвращает подходящее меню (игровое/основное) по наличию активной сессии. */
async function menuFor(telegramId: number) {
  const session = await activeSessionFor(telegramId);
  return session ? gameMenuKeyboard() : mainMenuKeyboard();
}

/** Возвращает активную сессию пользователя по telegram id (или null). */
async function activeSessionFor(telegramId: number, username?: string) {
  const user = await upsertUser(telegramId, username);
  return getActiveSession(user.id);
}

/**
 * Возвращает true, если бюджет сессии исчерпан.
 * Сравнивает накопленный cost_millicents с allocated_millicents (оба в миллицентах).
 * При allocated_millicents = 0 блокировки нет (кредиты не включены).
 */
function isCreditsExhausted(session: {
  allocated_millicents: number;
  cost_millicents: number;
}): boolean {
  // node-postgres возвращает BIGINT как строку — явное приведение к числу обязательно.
  const allocated = Number(session.allocated_millicents);
  const cost = Number(session.cost_millicents);
  return allocated > 0 && cost >= allocated;
}

function parseTopUpStars(raw: string | undefined): number | null {
  const amount = raw === undefined ? 1 : Number(raw);
  if (!Number.isInteger(amount) || !TOP_UP_STEPS.some((step) => step === amount)) {
    return null;
  }
  return amount;
}

function paidTopUpStars(totalAmount: number, payloadAmount: number | undefined): number {
  const fromTelegram = Number(totalAmount);
  if (Number.isFinite(fromTelegram) && fromTelegram > 0) {
    return Math.trunc(fromTelegram);
  }

  const fromPayload = Number(payloadAmount);
  if (Number.isFinite(fromPayload) && fromPayload > 0) {
    return Math.trunc(fromPayload);
  }

  return 1;
}

async function replyCreditsExhausted(
  ctx: Context,
  session: { id: string; allocated_millicents: number; cost_millicents: number },
  config: AppConfig,
  pendingAction?: { telegramId: number; actionText: string },
): Promise<void> {
  const steps = topUpStepsForBalance(session, config.millicentsPerStar);
  if (pendingAction) {
    if (steps.length > 0) {
      setPendingTopUpAction(pendingAction.telegramId, session.id, pendingAction.actionText);
    } else {
      clearPendingTopUpAction(pendingAction.telegramId, session.id);
    }
  }
  const keyboard = topUpKeyboard(session.id, steps);
  await ctx.reply(
    steps.length > 0 ? CREDITS_EXHAUSTED_MESSAGE : NO_TOP_UP_OPTIONS_MESSAGE,
    keyboard,
  );
}

function sessionWithAdditionalBudget(session: SessionRow, millicents: number): SessionRow {
  const allocated = Number(session.allocated_millicents);
  return {
    ...session,
    allocated_millicents: (Number.isFinite(allocated) ? allocated : 0) + millicents,
  };
}

async function runPendingTopUpAction(
  ctx: Context,
  provider: ILLMProvider,
  config: AppConfig,
  sceneCaps: SceneActionCaps,
  user: UserRow,
  telegramId: number,
  session: SessionRow,
): Promise<boolean> {
  const pending = getPendingTopUpAction(telegramId, session.id);
  if (!pending) return false;

  clearPendingTopUpAction(telegramId, session.id);
  await handleSessionAction(
    ctx,
    provider,
    config,
    sceneCaps,
    user,
    telegramId,
    session,
    pending.actionText,
  );
  return true;
}

/**
 * Общая логика обработки игрового действия (для введённого текста и для
 * клика по кнопке-подсказке).
 */
async function handlePlayerAction(
  ctx: Context,
  provider: ILLMProvider,
  config: AppConfig,
  sceneCaps: SceneActionCaps,
  telegramId: number,
  username: string | undefined,
  actionText: string,
): Promise<void> {
  const user = await upsertUser(telegramId, username);
  const session = await getActiveSession(user.id);
  if (!session) {
    await ctx.reply(NO_ACTIVE_GAME);
    return;
  }
  await handleSessionAction(ctx, provider, config, sceneCaps, user, telegramId, session, actionText);
}

async function handleSessionAction(
  ctx: Context,
  provider: ILLMProvider,
  config: AppConfig,
  sceneCaps: SceneActionCaps,
  user: UserRow,
  telegramId: number,
  session: SessionRow,
  actionText: string,
): Promise<void> {
  const manifest = await getGameManifest(session.game_id);
  if (!manifest) {
    await ctx.reply('Сценарий этой игры недоступен.');
    return;
  }

  if (isCreditsExhausted(session)) {
    await replyCreditsExhausted(ctx, session, config, { telegramId, actionText });
    return;
  }

  // Атомарно захватываем блокировку: если сессия уже обрабатывается — отказываем.
  const locked = await acquireProcessingLock(session.id);
  if (!locked) {
    await ctx.reply('Предыдущее действие ещё обрабатывается. Подождите.');
    return;
  }

  // Сразу сообщаем игроку, что действие принято в обработку. По завершении
  // текст этого же сообщения заменится на результат действия (issue #36).
  const progress = await sendProgress(ctx);

  try {
    await ctx.sendChatAction('typing');

    const steps = await listSteps(session.id);
    // Все текстовые LLM-запросы идут через глобальную default model (issue #345).
    const router = createModelRouter(config, provider);
    // Экспертиза игры (issue #154, фаза 0): включается, если задан
    // GAME_EXPERTISE_TOP_K > 0 и есть настроенный провайдер эмбеддингов.
    // Иначе ход идёт без справочных материалов, как раньше.
    const gameExpertiseTopK = config.embedding?.gameTopK ?? 0;
    const embeddingProvider =
      gameExpertiseTopK > 0 ? await createDefaultEmbeddingProvider(config) : null;
    // Долговременная память игры (issue #166): включается, если задан
    // GAME_MEMORY_TOP_K > 0. Тогда загружаем накопленные ячейки сессии для
    // подстановки в нарратив, а после хода извлекаем новые факты. При 0 —
    // память отключена и ход идёт ровно как раньше (обратная совместимость).
    const gameMemoryTopK = config.memory?.topK ?? 0;
    const memoryCells =
      gameMemoryTopK > 0 ? await listActiveMemoryCells(session.id) : [];
    const result = await processTurn({
      provider,
      router,
      manifest,
      state: session.current_state,
      action: actionText,
      history: turnHistoryFromSteps(steps),
      maxRetries: config.llm.maxRetries,
      cacheKey: session.id,
      embeddingProvider: embeddingProvider ?? undefined,
      expertiseTopK: gameExpertiseTopK,
      memoryCells,
      memoryTopK: gameMemoryTopK,
    });

    await addUsedCredits(session.id, result.creditsUsed);
    await addTokenUsageAndCost(session.id, result.tokenUsage, result.costMillicents);

    if (!result.ok) {
      // Состояние НЕ меняется. Логируем неудачную попытку.
      const step = await insertStep({
        sessionId: session.id,
        actionText,
        llmRawResponse: result.rawResponse ?? null,
        changesSummary: result.narrative,
        stepCredits: result.creditsUsed,
        tokenUsage: result.tokenUsage,
        costMillicents: result.costMillicents,
        stateBefore: session.current_state,
      });
      await saveRoutedTextLlmRequestLogs({
        entries: result.llmLog,
        config,
        router,
        userId: user.id,
        sessionId: session.id,
        stepId: step.id,
        label: 'игровой ход',
      });
      await progress.update(result.narrative);
      return;
    }

    const step = await insertStep({
      sessionId: session.id,
      actionText,
      llmRawResponse: result.rawResponse,
      changesSummary: result.narrative,
      stepCredits: result.creditsUsed,
      tokenUsage: result.tokenUsage,
      costMillicents: result.costMillicents,
      stateBefore: session.current_state,
    });
    await saveRoutedTextLlmRequestLogs({
      entries: result.llmLog,
      config,
      router,
      userId: user.id,
      sessionId: session.id,
      stepId: step.id,
      label: 'игровой ход',
    });
    await updateSessionState(session.id, result.newState);

    // Сохраняем новые ячейки долговременной памяти, выделенные фазой памяти
    // (issue #166). Привязка к шагу (step_id) позволяет откатить факты при
    // отмене хода: /cancel помечает шаг отменённым (не удаляя его) и явно чистит
    // ячейки этого шага (см. cancelLastStep), а каскад по FK срабатывает при
    // удалении сессии/шага. Best-effort: сбой записи не валит уже принятый ход.
    if (result.memoryUpdate && result.memoryUpdate.added.length > 0) {
      await insertMemoryCellsSafely(
        result.memoryUpdate.added.map((cell) => ({
          sessionId: session.id,
          stepId: step.id,
          content: cell.content,
          category: cell.category,
          importance: cell.importance,
          turnCreated: result.newState.turn_count,
        })),
      );
    }

    if (result.gameOver) {
      await finishSession(session.id);
      // Результат заменяет «прогресс»-сообщение, а смена нижнего меню
      // (Reply Keyboard) требует отдельного сообщения — её нельзя задать
      // при редактировании текста. Кнопки озвучки/иллюстрации (issue #71)
      // прикрепляются к самому результату — финальная сцена тоже «озвучивается».
      await progress.update(result.narrative, sceneActionsKeyboard(step.id, sceneCaps));
      await ctx.reply(
        '💀 Игра окончена. Возвращаю вас в главное меню.',
        mainMenuKeyboard(),
      );
      return;
    }

    // Прикрепляем кнопки «Озвучить»/«Нарисовать иллюстрацию» к результату хода
    // (issue #71). Если медиа недоступно, keyboard === undefined и кнопок нет.
    await progress.update(result.narrative, sceneActionsKeyboard(step.id, sceneCaps));
  } catch (err) {
    // issue #238: ход исполняет ТОЛЬКО активная action-схема. Legacy удалён —
    // при отсутствии схемы доставляем игроку честную ошибку вместо «зависшего»
    // прогресс-сообщения «Действие выполняется…».
    if (err instanceof MissingActiveSchemaError) {
      console.error(`[schema-engine] action: ${err.message}`);
      await progress.update(SCHEMA_UNAVAILABLE_TEXT);
      return;
    }
    throw err;
  } finally {
    await releaseProcessingLock(session.id);
  }
}

/** Параметры голосового/аудио-сообщения, нужные для распознавания речи. */
interface VoiceMessage {
  /** Telegram file_id для скачивания аудио. */
  fileId: string;
  /** MIME-тип аудио, если Telegram его прислал. */
  mimeType?: string;
}

/**
 * Распознаёт речь из голосового сообщения и выполняет её как игровое действие
 * (STT, issue #118).
 *
 * Аудио НИГДЕ не сохраняется: буфер скачивается в память, передаётся провайдеру
 * STT и теряется по выходе из функции — на диск и в БД не пишется. Сам факт
 * обращения к провайдеру (без аудио) логируется как медиа-запрос для учёта
 * стоимости и отчёта тестировщику, по аналогии с озвучкой/иллюстрацией.
 */
async function handleVoiceAction(
  ctx: Context,
  media: IMediaProvider | null,
  provider: ILLMProvider,
  config: AppConfig,
  sceneCaps: SceneActionCaps,
  voice: VoiceMessage,
): Promise<void> {
  if (!ctx.from) return;

  // Распознавание речи выключено или провайдер его не умеет.
  if (!media || !media.canTranscribe) {
    await ctx.reply(
      '🎙️ Распознавание голосовых сообщений сейчас недоступно. Напишите действие текстом.',
    );
    return;
  }

  const user = await upsertUser(ctx.from.id, ctx.from.username);
  const session = await getActiveSession(user.id);
  if (!session) {
    await ctx.reply(NO_ACTIVE_GAME);
    return;
  }

  const sttModel = config.media?.stt?.model ?? 'unknown';
  const progress = await sendVoiceProgress(ctx);
  let meta: MediaCallMeta | undefined;
  try {
    await ctx.sendChatAction('typing');
    const mimeType = voice.mimeType ?? 'audio/ogg';
    // Аудио живёт только здесь, в памяти, и никуда не сохраняется (issue #118).
    const audio = await downloadTelegramFile(ctx, voice.fileId);
    const transcription = await media.transcribe({
      audio,
      mimeType,
      filename: voiceFilename(mimeType),
    });
    meta = transcription.meta;
    await saveSttLlmRequestLog({
      providerName: media.name,
      model: sttModel,
      userId: user.id,
      sessionId: session.id,
      request: meta?.request ?? describeSttRequest(media.name, audio.length, mimeType),
      response: meta?.response ?? 'Речь распознана.',
      usage: meta?.usage,
    });
    await addMediaUsageToSession(session.id, sttModel, meta?.usage);
    if (user.is_tester) {
      await sendSttTesterReport(ctx, {
        kind: 'stt',
        request: meta?.request ?? describeSttRequest(media.name, audio.length, mimeType),
        response: meta?.response ?? 'Речь распознана.',
        usage: meta?.usage,
      });
    }

    const actionText = transcription.text.trim();
    if (!actionText) {
      await progress.update(
        '🎙️ Не удалось распознать речь. Попробуйте записать ещё раз или напишите действие текстом.',
      );
      return;
    }

    // Показываем игроку распознанный текст и выполняем его как игровое действие.
    await progress.update(`🎙️ Распознано: ${actionText}`);
    await handlePlayerAction(
      ctx,
      provider,
      config,
      sceneCaps,
      ctx.from.id,
      ctx.from.username,
      actionText,
    );
  } catch (err) {
    console.error('🎙️ Ошибка распознавания голосового сообщения:', err);
    await saveSttLlmRequestLog({
      providerName: media.name,
      model: sttModel,
      userId: user.id,
      sessionId: session.id,
      request: err instanceof MediaGenerationError ? err.request : describeSttRequest(media.name),
      error: err instanceof Error ? err.message : String(err),
      usage: err instanceof MediaGenerationError ? err.usage : undefined,
    });
    await progress.update(
      '🎙️ Не удалось распознать голосовое сообщение. Попробуйте ещё раз или напишите действие текстом.',
    );
    if (user.is_tester) {
      await sendSttTesterReport(ctx, {
        kind: 'stt',
        request: err instanceof MediaGenerationError ? err.request : describeSttRequest(media.name),
        error: err instanceof Error ? err.message : String(err),
        usage: err instanceof MediaGenerationError ? err.usage : undefined,
      });
    }
  }
}

/**
 * Скачивает файл Telegram во временный буфер в памяти. Используется для аудио
 * голосовых сообщений (issue #118): на диск ничего не пишется.
 */
async function downloadTelegramFile(ctx: Context, fileId: string): Promise<Buffer> {
  const link = await ctx.telegram.getFileLink(fileId);
  const response = await fetch(link.toString());
  if (!response.ok) {
    throw new Error(`Не удалось скачать аудио из Telegram: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Подбирает имя файла с расширением по MIME-типу аудио (нужно SDK STT). */
function voiceFilename(mimeType: string): string {
  const ext = mimeType.includes('mpeg')
    ? 'mp3'
    : mimeType.includes('wav')
      ? 'wav'
      : mimeType.includes('mp4') || mimeType.includes('m4a')
        ? 'm4a'
        : mimeType.includes('webm')
          ? 'webm'
          : 'ogg';
  return `voice.${ext}`;
}

/** Запасное описание STT-запроса для логов/отчёта, когда провайдер не дал meta. */
function describeSttRequest(providerName: string, bytes?: number, mimeType?: string): string {
  const audio = bytes ? `${bytes} байт${mimeType ? ` (${mimeType})` : ''}` : 'голосовое сообщение';
  return [`Провайдер: ${providerName} (распознавание речи)`, `Аудио: ${audio}`].join('\n');
}

/** Логирует STT-обращение в llm_request_logs (без шага: распознавание идёт до хода). */
async function saveSttLlmRequestLog(input: {
  providerName: string;
  model: string;
  userId: string;
  sessionId: string;
  request: string;
  response?: string;
  error?: string;
  usage?: LLMCallLogEntry['usage'];
}): Promise<void> {
  const logs = buildLlmRequestLogInputs(
    [
      {
        request: input.request,
        response: input.error ? `Ошибка: ${input.error}` : (input.response ?? ''),
        error: input.error,
        usage: input.usage,
      },
    ],
    {
      userId: input.userId,
      sessionId: input.sessionId,
      provider: input.providerName,
      model: input.model,
      pricing: findModelPricing(input.model),
    },
  );
  await insertLlmRequestLogsSafely(logs, 'распознавание речи');
}

/** Отправляет тестировщику технический отчёт по STT-обращению (issue #75). */
async function sendSttTesterReport(ctx: Context, report: MediaTesterReport): Promise<void> {
  const document = Input.fromBuffer(
    Buffer.from(formatMediaTesterReport(report), 'utf8'),
    'stt_media_report.txt',
  );
  await ctx.replyWithDocument(document);
}

/**
 * Обрабатывает клик по кнопке озвучки/иллюстрации сцены (issue #71).
 *
 * Логика:
 *  1. Проверяем доступность медиа и нужной возможности (озвучка/рисование).
 *  2. Находим шаг и убеждаемся, что кликнул автор хода (нельзя озвучивать
 *     чужие сцены).
 *  3. Убираем из сообщения ТОЛЬКО нажатую кнопку — вторая (если есть) остаётся.
 *  4. Генерируем медиа и присылаем его НОВЫМ сообщением (голос/аудио или фото).
 *  5. При ошибке возвращаем нажатую кнопку обратно, чтобы можно было повторить.
 *
 * `answerCbQuery` вызывается ровно один раз на каждом пути (Telegram позволяет
 * ответить на callback лишь однажды).
 */
async function handleMediaCallback(
  ctx: Context,
  media: IMediaProvider | null,
  config: AppConfig,
  kind: 'tts' | 'draw',
  stepId: string,
): Promise<void> {
  const callbackData = `${kind === 'tts' ? TTS_PREFIX : DRAW_PREFIX}${stepId}`;

  // 1. Медиа выключено или нужная возможность недоступна.
  if (!media || (kind === 'tts' ? !media.canSpeak : !media.canDraw)) {
    await ctx.answerCbQuery(
      kind === 'tts' ? 'Озвучка сейчас недоступна.' : 'Иллюстрации сейчас недоступны.',
    );
    return;
  }
  if (!ctx.from) {
    await ctx.answerCbQuery();
    return;
  }

  // 2. Находим шаг и проверяем владельца.
  const step = await getStepWithOwner(stepId);
  if (!step || !step.changes_summary) {
    await ctx.answerCbQuery('Сцена устарела — её текст не найден.');
    return;
  }
  const user = await upsertUser(ctx.from.id, ctx.from.username);
  if (step.user_id !== user.id) {
    await ctx.answerCbQuery('Это сцена другого игрока.');
    return;
  }
  const effectiveMedia = resolveEffectiveMediaConfig(
    config.media,
    userMediaConfigValues(await getUserMediaConfig(user.id)),
  );
  const mediaModel = mediaModelName(effectiveMedia, kind);
  const modelParams = mediaModelParams(config, effectiveMedia, kind);

  // Подтверждаем callback (убираем «часики») — дальше идёт долгая генерация.
  await ctx.answerCbQuery();

  // 3. Убираем только нажатую кнопку (вторая, если есть, остаётся).
  const keyboard = callbackInlineKeyboard(ctx);
  await safeEditReplyMarkup(ctx, keyboardWithout(keyboard, callbackData));
  const progress = await sendMediaProgress(ctx);

  const sceneText = step.changes_summary;
  // Что фактически ушло провайдеру (нужно для отчёта тестировщику, issue #75).
  let requestInput = sceneText;
  try {
    // 4. Генерируем и присылаем медиа новым сообщением.
    let meta: MediaCallMeta | undefined;
    if (kind === 'tts') {
      await ctx.sendChatAction('record_voice');
      const speech = await media.generateSpeech({ text: requestInput, ...effectiveMedia.tts });
      meta = speech.meta;
      const file = Input.fromBuffer(speech.audio, `scene.${speech.extension}`);
      // Голосовое сообщение требует OGG/Opus; форматы вроде WAV шлём как аудио.
      if (speech.voiceNote) {
        await ctx.replyWithVoice(file);
      } else {
        await ctx.replyWithAudio(file);
      }
      await safeUpdateProgress(progress, '🔊 Озвучка готова.');
    } else {
      await ctx.sendChatAction('upload_photo');
      // issue #238: иллюстрация рисуется ТОЛЬКО через активную схему
      // illustration. Legacy-путь удалён: при отсутствии схемы
      // generateIllustrationViaSchema бросает MissingActiveSchemaError, и
      // ошибка доставляется игроку (catch ниже).
      const viaSchema = await generateIllustrationViaSchema({
        sceneText,
        gameId: step.game_id,
        mediaProvider: media,
        image: effectiveMedia.image,
        sessionId: step.session_id,
        maxRetries: config.llm.maxRetries,
      });
      requestInput = viaSchema.prompt;
      const image = { image: viaSchema.image, extension: viaSchema.extension, meta: viaSchema.meta };
      meta = image.meta;
      const file = Input.fromBuffer(image.image, `scene.${image.extension}`);
      await ctx.replyWithPhoto(file);
      await safeUpdateProgress(progress, '🎨 Иллюстрация готова.');
    }
    await saveMediaLlmRequestLog({
      kind,
      providerName: media.name,
      model: mediaModel,
      modelParams,
      userId: user.id,
      sessionId: step.session_id,
      stepId,
      request: meta?.request ?? describeMediaRequest(kind, media.name, requestInput),
      response: meta?.response ?? 'Медиа успешно сгенерировано.',
      usage: meta?.usage,
    });
    await addMediaUsageToSession(step.session_id, mediaModel, meta?.usage);
    // Следом за медиа шлём тестировщику технический отчёт (issue #75).
    if (user.is_tester) {
      await sendMediaTesterReport(ctx, stepId, {
        kind,
        request: meta?.request ?? describeMediaRequest(kind, media.name, requestInput),
        response: meta?.response ?? 'Медиа успешно сгенерировано.',
        usage: meta?.usage,
      });
    }
  } catch (err) {
    console.error(`🎬 Ошибка генерации медиа (${kind}) для шага ${stepId}:`, err);
    const errorText =
      kind === 'tts'
        ? '🔊 Не удалось озвучить сцену. Попробуйте ещё раз.'
        : '🎨 Не удалось нарисовать иллюстрацию. Попробуйте ещё раз.';
    await saveMediaLlmRequestLog({
      kind,
      providerName: media.name,
      model: mediaModel,
      modelParams,
      userId: user.id,
      sessionId: step.session_id,
      stepId,
      request:
        err instanceof MediaGenerationError
          ? err.request
          : describeMediaRequest(kind, media.name, requestInput),
      error: err instanceof Error ? err.message : String(err),
      usage: err instanceof MediaGenerationError ? err.usage : undefined,
    });
    // 5. Возвращаем кнопку, чтобы игрок мог повторить попытку.
    await safeEditReplyMarkup(ctx, keyboard);
    await safeUpdateProgress(progress, errorText);
    // Тестировщику шлём отчёт с информацией об ошибке API (issue #75).
    if (user.is_tester) {
      await sendMediaTesterReport(ctx, stepId, {
        kind,
        request:
          err instanceof MediaGenerationError
            ? err.request
            : describeMediaRequest(kind, media.name, requestInput),
        error: err instanceof Error ? err.message : String(err),
        usage: err instanceof MediaGenerationError ? err.usage : undefined,
      });
    }
  }
}

/**
 * Запасное описание запроса для отчёта тестировщику (issue #75), когда провайдер
 * не приложил собственную метаинформацию (например, в тестах или на ранней
 * ошибке): показываем вид операции, имя провайдера и что отправляли.
 */
function describeMediaRequest(
  kind: 'tts' | 'draw',
  providerName: string,
  input: string,
): string {
  const op = kind === 'tts' ? 'озвучка' : 'иллюстрация';
  const clipped = input.trim().slice(0, 800);
  return [`Провайдер: ${providerName} (${op})`, `Вход (${input.length} симв.): ${clipped}`].join(
    '\n',
  );
}

/**
 * Сохраняет аудит LLM с учётом маршрутизации (issue #345): записи группируются
 * по типу запроса (kind), и для каждой группы провайдер/модель/цена берутся из
 * роутера. При глобальном default все группы обычно указывают на одну модель,
 * но группировка сохраняет корректный kind в логе.
 */
async function saveRoutedTextLlmRequestLogs(input: {
  entries: LLMCallLogEntry[];
  config: AppConfig;
  router: ModelRouter;
  userId: string;
  sessionId?: string;
  stepId?: string;
  label: string;
}): Promise<void> {
  // Все текстовые запросы хода идут через один глобальный default model
  // (issue #345), поэтому модель и цену достаточно разрешить один раз.
  // Источник запроса (схема/узел) уже проставлен в каждой записи лога движком
  // схемы (issue #403) и сохраняется в аудит как есть.
  if (input.entries.length === 0) return;
  const routed = await input.router.resolve();
  const logs = buildLlmRequestLogInputs(input.entries, {
    userId: input.userId,
    sessionId: input.sessionId,
    stepId: input.stepId,
    provider: routed.provider.name,
    model: routed.model,
    modelParams: routedTextModelParams(input.config, routed.providerName),
    pricing: routed.pricing,
  });
  await insertLlmRequestLogsSafely(logs, input.label);
}

async function saveMediaLlmRequestLog(input: {
  kind: 'tts' | 'draw';
  providerName: string;
  model: string;
  modelParams: Record<string, unknown>;
  userId: string;
  sessionId: string;
  stepId: string;
  request: string;
  response?: string;
  error?: string;
  usage?: LLMCallLogEntry['usage'];
}): Promise<void> {
  const logs = buildLlmRequestLogInputs(
    [
      {
        request: input.request,
        response: input.error ? `Ошибка: ${input.error}` : (input.response ?? ''),
        error: input.error,
        usage: input.usage,
        modelParams: input.modelParams,
      },
    ],
    {
      userId: input.userId,
      sessionId: input.sessionId,
      stepId: input.stepId,
      provider: input.providerName,
      model: input.model,
      pricing: findModelPricing(input.model),
    },
  );
  await insertLlmRequestLogsSafely(
    logs,
    input.kind === 'tts' ? 'озвучка сцены' : 'иллюстрация сцены',
  );
}

/**
 * Параметры модели для аудита маршрутизированного запроса (issue #345):
 * провайдер берётся из активного конфига, а температура/ретраи — общие.
 */
function routedTextModelParams(
  config: AppConfig,
  providerName: AppConfig['llm']['provider'],
): Record<string, unknown> {
  return {
    provider: providerName,
    temperature: config.llm.temperature,
    maxRetries: config.llm.maxRetries,
  };
}

function mediaModelName(
  effectiveMedia: ReturnType<typeof resolveEffectiveMediaConfig>,
  kind: 'tts' | 'draw',
): string {
  if (kind === 'tts') return effectiveMedia.tts.model;
  return effectiveMedia.image.model;
}

function mediaModelParams(
  config: AppConfig,
  effectiveMedia: ReturnType<typeof resolveEffectiveMediaConfig>,
  kind: 'tts' | 'draw',
): Record<string, unknown> {
  if (kind === 'tts') {
    return {
      provider: config.media?.provider ?? 'unknown',
      voice: effectiveMedia.tts.voice,
      enabled: config.media?.tts?.enabled ?? true,
    };
  }
  return {
    provider: config.media?.provider ?? 'unknown',
    size: effectiveMedia.image.size,
    enabled: config.media?.image?.enabled ?? true,
  };
}

async function addMediaUsageToSession(
  sessionId: string,
  model: string,
  usage: LLMCallLogEntry['usage'],
): Promise<void> {
  if (!usage) return;
  const pricing = findModelPricing(model);
  const { creditsUsed, tokenUsage, costMillicents } = calcLLMCost(
    [{ request: '', response: '', usage }],
    pricing,
  );
  await addUsedCredits(sessionId, creditsUsed);
  await addTokenUsageAndCost(sessionId, tokenUsage, costMillicents);
}

/** Отправляет тестировщику технический отчёт по медиа-обращению текстовым файлом. */
async function sendMediaTesterReport(
  ctx: Context,
  stepId: string,
  report: MediaTesterReport,
): Promise<void> {
  const filename = `${stepId}_${report.kind}_media_report.txt`;
  const document = Input.fromBuffer(Buffer.from(formatMediaTesterReport(report), 'utf8'), filename);
  await ctx.replyWithDocument(document);
}

/** Текущие inline-кнопки сообщения из callback-запроса (или пустой список). */
function callbackInlineKeyboard(ctx: Context): InlineKeyboardButton[][] {
  const message = ctx.callbackQuery?.message;
  const replyMarkup = message && 'reply_markup' in message ? message.reply_markup : undefined;
  return replyMarkup?.inline_keyboard ?? [];
}

/**
 * Возвращает клавиатуру без кнопки с указанным callback_data. Опустевшие ряды
 * отбрасываются, чтобы не оставлять «дыр» в разметке.
 */
function keyboardWithout(
  keyboard: InlineKeyboardButton[][],
  callbackData: string,
): InlineKeyboardButton[][] {
  return keyboard
    .map((row) =>
      row.filter((btn) => !('callback_data' in btn && btn.callback_data === callbackData)),
    )
    .filter((row) => row.length > 0);
}

/**
 * Обновляет inline-клавиатуру сообщения, проглатывая ошибки Telegram
 * («message is not modified», устаревшее сообщение и т. п.) — они не критичны
 * для отправки самого медиа. Пустой список рядов убирает клавиатуру целиком.
 */
async function safeEditReplyMarkup(
  ctx: Context,
  rows: InlineKeyboardButton[][],
): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup(rows.length ? { inline_keyboard: rows } : undefined);
  } catch {
    // Клавиатуру не удалось изменить — не мешаем основному сценарию.
  }
}

/** Безопасно обновляет progress-сообщение, не ломая отправку медиа из-за UX-сбоя. */
async function safeUpdateProgress(
  progress: { update(text: string): Promise<void> },
  text: string,
): Promise<void> {
  try {
    await progress.update(text);
  } catch {
    // Если Telegram не дал отредактировать временное сообщение, медиа уже не
    // должно считаться неуспешным.
  }
}

/**
 * Переводит сохранённые ходы БД в компактную память для промптов LLM.
 *
 * Отменённые командой /cancel ходы (issue #116) исключаются из памяти, чтобы
 * LLM не учитывала откатанные действия. Оставшиеся ходы перенумеровываются
 * подряд.
 */
function turnHistoryFromSteps(steps: StepRow[] | undefined): TurnHistoryEntry[] {
  if (!steps?.length) return [];
  return steps
    .filter((step) => !step.is_cancelled)
    .map((step, index) => ({
      turn: index + 1,
      action: step.action_text?.trim() || '—',
      outcome: step.changes_summary?.trim() || '—',
    }));
}
