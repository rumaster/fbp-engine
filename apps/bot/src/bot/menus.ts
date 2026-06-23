import { Markup } from 'telegraf';
import type { CharacterPreset, GameManifest, LocationPreset } from '@tg-games/core/games/manifests.js';
import type { SessionRow } from '@tg-games/core/db/repositories/sessions.js';
import type { GameTitleMap } from '@tg-games/core/db/repositories/gameManifests.js';
import type {
  ImageModelOption,
  MediaConfigSubject,
  MediaSelectOption,
  TtsModelOption,
} from '@tg-games/core/media/userConfig.js';

/** callback_data inline-кнопки «Как купить TG звёзды». */
export const BUY_STARS_HELP = 'buy_stars_help';

/** Ссылка-инструкция «Как купить TG звёзды». */
export const BUY_STARS_URL = 'https://teletype.in/@mirra_vpn/SPVriB7xnA6';

/** Текстовые подписи кнопок нижнего меню (Reply Keyboard). */
export const BTN = {
  newGame: 'Начать новую игру',
  myGames: 'Мои игры',
  help: 'Помощь',
  action: 'Действие',
  hint: 'Подсказка',
  status: 'Статус',
} as const;

export const CONFIG_HOME_CALLBACK = 'cfg:home';
export const CONFIG_SUBJECT_PREFIX = 'cfg:subject:';
export const CONFIG_TTS_MODEL_PREFIX = 'cfg:tts:model:';
export const CONFIG_TTS_VOICE_PREFIX = 'cfg:tts:voice:';
export const CONFIG_IMAGE_MODEL_PREFIX = 'cfg:image:model:';
export const CONFIG_IMAGE_SIZE_PREFIX = 'cfg:image:size:';

/**
 * Основное меню (когда НЕТ активной игры).
 *
 * [ Начать новую игру ] [ Мои игры ]
 * [ Помощь ]
 */
export function mainMenuKeyboard() {
  return Markup.keyboard([
    [BTN.newGame, BTN.myGames],
    [BTN.help],
  ]).resize();
}

/**
 * Игровое меню (когда ЕСТЬ активная игра).
 *
 * [ Действие ] [ Подсказка ] [ Статус ]
 * [ Начать новую игру ] [ Мои игры ] [ Помощь ]
 */
export function gameMenuKeyboard() {
  return Markup.keyboard([
    [BTN.action, BTN.hint, BTN.status],
    [BTN.newGame, BTN.myGames, BTN.help],
  ]).resize();
}

/** Inline-кнопки со списком доступных игр (callback_data: `game:<id>`). */
export function gameListKeyboard(games: GameManifest[]) {
  return Markup.inlineKeyboard(
    games.map((g) => [Markup.button.callback(`${g.name} — ${g.priceStars} ⭐️`, `game:${g.id}`)]),
  );
}

/**
 * Inline-кнопки выбора персонажа (issue #60).
 * callback_data: `char:<gameId>:<index>` — индекс пресета в манифесте.
 */
export function characterPresetsKeyboard(gameId: string, presets: CharacterPreset[]) {
  return Markup.inlineKeyboard(
    presets.map((p, i) => [Markup.button.callback(`${i + 1}. ${p.name}`, `char:${gameId}:${i}`)]),
  );
}

/**
 * Inline-кнопки выбора стартовой локации (issue #60).
 * callback_data: `loc:<gameId>:<characterIndex>:<locationIndex>` — выбранный
 * персонаж переносится дальше, чтобы собрать стартовое состояние целиком.
 */
export function locationPresetsKeyboard(
  gameId: string,
  characterIndex: number,
  presets: LocationPreset[],
) {
  return Markup.inlineKeyboard(
    presets.map((p, i) => [
      Markup.button.callback(`${i + 1}. ${p.location}`, `loc:${gameId}:${characterIndex}:${i}`),
    ]),
  );
}

/** Inline-кнопка покупки конкретной игры (callback_data: `buy:<id>`). */
export function buyKeyboard(game: GameManifest) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`Купить за ${game.priceStars} ⭐️`, `buy:${game.id}`)],
  ]);
}

/**
 * Inline-кнопки для выполнения подсказок: один ряд кнопок с номерами,
 * соответствующими нумерованному списку из {@link formatHints}.
 * callback_data: `hint:<index>` — текст хранится в эфемерном состоянии.
 */
export function hintsKeyboard(hints: string[]) {
  return Markup.inlineKeyboard([
    hints.map((_, i) => Markup.button.callback(String(i + 1), `hint:${i}`)),
  ]);
}

/** callback_data-префикс кнопки «Озвучить» (issue #71): `tts:<stepId>`. */
export const TTS_PREFIX = 'tts:';

/** callback_data-префикс кнопки «Нарисовать иллюстрацию» (issue #71): `draw:<stepId>`. */
export const DRAW_PREFIX = 'draw:';

/** Какие кнопки сцены показывать — по возможностям медиа-провайдера. */
export interface SceneActionCaps {
  /** Доступна ли озвучка (показать кнопку «Озвучить»). */
  canSpeak: boolean;
  /** Доступна ли иллюстрация (показать кнопку «Нарисовать иллюстрацию»). */
  canDraw: boolean;
}

/**
 * Inline-кнопки под сообщением-результатом действия (issue #71):
 * «🔊 Озвучить» (`tts:<stepId>`) и «🎨 Нарисовать иллюстрацию» (`draw:<stepId>`),
 * каждая в своём ряду.
 *
 * Кнопка появляется, только если соответствующая возможность включена у
 * медиа-провайдера. Если доступных кнопок нет — возвращает undefined, чтобы
 * не прикреплять пустую клавиатуру.
 */
export function sceneActionsKeyboard(stepId: string, caps: SceneActionCaps) {
  const rows = [
    ...(caps.canSpeak ? [[Markup.button.callback('🔊 Озвучить', `${TTS_PREFIX}${stepId}`)]] : []),
    ...(caps.canDraw
      ? [[Markup.button.callback('🎨 Нарисовать иллюстрацию', `${DRAW_PREFIX}${stepId}`)]]
      : []),
  ];
  return rows.length ? Markup.inlineKeyboard(rows) : undefined;
}

export const TOP_UP_STEPS = [1, 3, 10] as const;

/**
 * Возвращает ступени пополнения, которые выведут сессию из исчерпанного бюджета.
 *
 * Если перерасход уже равен стоимости ступени, такая ступень тоже скрывается:
 * после оплаты cost_millicents остался бы равен allocated_millicents, а игра
 * по-прежнему считалась бы недоступной.
 */
export function topUpStepsForBalance(
  session: Pick<SessionRow, 'allocated_millicents' | 'cost_millicents'>,
  millicentsPerStar: number,
): number[] {
  const starBudget = Number(millicentsPerStar);
  if (!Number.isFinite(starBudget) || starBudget <= 0) return [];

  const allocated = Number(session.allocated_millicents);
  const cost = Number(session.cost_millicents);
  const overrun = Math.max(0, cost - allocated);
  return TOP_UP_STEPS.filter((stars) => stars * starBudget > overrun);
}

/** Inline-кнопки пополнения кредитов ступенями x1/x3/x10. */
export function topUpKeyboard(sessionId: string, steps: readonly number[] = TOP_UP_STEPS) {
  const rows = steps.map((stars) => [
    Markup.button.callback(`x${stars} — ${stars} ⭐️`, `topup:${sessionId}:${stars}`),
  ]);
  return rows.length > 0 ? Markup.inlineKeyboard(rows) : undefined;
}

/** Формирует ссылку на чат бота поддержки по его username (без учёта ведущего @). */
export function supportChatUrl(botUsername: string): string {
  return `https://t.me/${botUsername.replace(/^@/, '')}`;
}

/**
 * Inline-кнопки под сообщением «Помощь».
 *
 * Если задан username бота поддержки, первой кнопкой добавляется ссылка
 * «Служба поддержки», открывающая чат с ботом поддержки (issue #57).
 * Без username (поддержка не настроена) кнопка не показывается.
 */
export function helpKeyboard(supportBotUsername?: string) {
  const supportRow = supportBotUsername
    ? [[Markup.button.url('🛟 Служба поддержки', supportChatUrl(supportBotUsername))]]
    : [];
  return Markup.inlineKeyboard([
    ...supportRow,
    [Markup.button.callback('Как купить TG звёзды ⭐️', BUY_STARS_HELP)],
  ]);
}

/** Первый экран /config: пользователь выбирает, что настраивать. */
export function mediaConfigSubjectsKeyboard(caps: SceneActionCaps) {
  const rows = [
    ...(caps.canSpeak
      ? [[Markup.button.callback('🔊 Озвучка', `${CONFIG_SUBJECT_PREFIX}tts`)]]
      : []),
    ...(caps.canDraw
      ? [[Markup.button.callback('🎨 Иллюстрации', `${CONFIG_SUBJECT_PREFIX}image`)]]
      : []),
  ];
  return rows.length ? Markup.inlineKeyboard(rows) : undefined;
}

/** Экран выбора модели для озвучки или иллюстраций. */
export function mediaConfigModelsKeyboard(
  subject: MediaConfigSubject,
  models: Array<TtsModelOption | ImageModelOption>,
  currentModel: string,
) {
  const prefix = subject === 'tts' ? CONFIG_TTS_MODEL_PREFIX : CONFIG_IMAGE_MODEL_PREFIX;
  return Markup.inlineKeyboard([
    ...models.map((model) => [
      Markup.button.callback(
        selectedLabel(model.label, model.id === currentModel),
        `${prefix}${model.id}`,
      ),
    ]),
    [Markup.button.callback('Назад', CONFIG_HOME_CALLBACK)],
  ]);
}

/** Экран выбора голоса TTS после выбора модели. */
export function mediaConfigVoicesKeyboard(voices: MediaSelectOption[], currentVoice: string) {
  return Markup.inlineKeyboard([
    ...voices.map((voice) => [
      Markup.button.callback(
        selectedLabel(voice.label, voice.id === currentVoice),
        `${CONFIG_TTS_VOICE_PREFIX}${voice.id}`,
      ),
    ]),
    [Markup.button.callback('Назад', `${CONFIG_SUBJECT_PREFIX}tts`)],
  ]);
}

/** Экран выбора размера/соотношения иллюстрации после выбора модели. */
export function mediaConfigSizesKeyboard(sizes: MediaSelectOption[], currentSize: string) {
  return Markup.inlineKeyboard([
    ...sizes.map((size) => [
      Markup.button.callback(
        selectedLabel(size.label, size.id === currentSize),
        `${CONFIG_IMAGE_SIZE_PREFIX}${size.id}`,
      ),
    ]),
    [Markup.button.callback('Назад', `${CONFIG_SUBJECT_PREFIX}image`)],
  ]);
}

/** Человекочитаемое имя сценария сессии (имя манифеста либо его id). */
function sessionTitle(session: Pick<SessionRow, 'game_id'>, gameTitles: GameTitleMap): string {
  return gameTitles.get(session.game_id) ?? session.game_id;
}

function selectedLabel(label: string, selected: boolean): string {
  return selected ? `✓ ${label}` : label;
}

/**
 * Inline-кнопки активных (незавершённых) игр. Клик переключает текущую игру.
 * callback_data: `session:<id>`.
 */
export function activeGamesKeyboard(
  sessions: SessionRow[],
  gameTitles: GameTitleMap = new Map(),
) {
  return Markup.inlineKeyboard(
    sessions.map((s) => [
      Markup.button.callback(
        `🟢 ${sessionTitle(s, gameTitles)} — ход ${s.current_state.turn_count}`,
        `session:${s.id}`,
      ),
    ]),
  );
}

/**
 * Inline-кнопки завершённых игр. Клик присылает историю ходов.
 * callback_data: `history:<id>`.
 */
export function finishedGamesKeyboard(
  sessions: SessionRow[],
  gameTitles: GameTitleMap = new Map(),
) {
  return Markup.inlineKeyboard(
    sessions.map((s) => [
      Markup.button.callback(
        `⚪️ ${sessionTitle(s, gameTitles)} — ход ${s.current_state.turn_count}`,
        `history:${s.id}`,
      ),
    ]),
  );
}
