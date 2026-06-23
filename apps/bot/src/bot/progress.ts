import type { Context } from 'telegraf';

/**
 * Текст временного сообщения, которое отправляется сразу при получении
 * действия и затем заменяется на результат (issue #36).
 */
export const ACTION_IN_PROGRESS_TEXT = '⏳ Действие выполняется…';

/**
 * Текст временного сообщения, которое отправляется сразу при запросе
 * подсказки и затем заменяется на список действий (issue #43).
 */
export const HINT_IN_PROGRESS_TEXT = '🔍 Поиск возможных действий…';

/**
 * Текст временного сообщения, которое отправляется сразу при запросе генерации
 * медиа и затем заменяется на статус завершения (issue #89).
 */
export const MEDIA_IN_PROGRESS_TEXT = '⏳ Подождите, идёт генерация…';

/**
 * Сообщение игроку, когда ход/подсказку/иллюстрацию нельзя выполнить из-за
 * отсутствия активной схемы (issue #238). Schema engine — единственный путь
 * исполнения, legacy удалён, поэтому при отсутствии схемы вместо «тихого»
 * фолбэка доставляется честная ошибка (а «прогресс»-сообщение не зависает).
 */
export const SCHEMA_UNAVAILABLE_TEXT =
  '⚠️ Игровой движок временно недоступен из-за технической ошибки. ' +
  'Попробуйте повторить действие позже.';

/**
 * Текст временного сообщения, которое отправляется сразу при получении
 * голосового сообщения и заменяется на результат действия после распознавания
 * речи (STT, issue #118).
 */
export const VOICE_IN_PROGRESS_TEXT = '🎙️ Распознаю голосовое сообщение…';

/** Дополнительные параметры редактирования текста сообщения (parse_mode и т.п.). */
type EditExtra = Parameters<Context['telegram']['editMessageText']>[4];

/**
 * Ссылка на отправленное «прогресс»-сообщение, текст которого можно
 * обновить, когда действие завершится.
 */
export interface ProgressMessage {
  /** Заменяет текст «прогресс»-сообщения на итоговый результат действия. */
  update(text: string, extra?: EditExtra): Promise<void>;
}

/**
 * Отправляет сообщение «Действие выполняется…» и возвращает дескриптор, через
 * который позже можно заменить его текст на результат действия.
 *
 * Так пользователь сразу видит, что бот принял действие, а по завершении
 * обработки то же самое сообщение превращается в итоговый нарратив — вместо
 * отдельного нового сообщения.
 */
export async function sendProgress(ctx: Context): Promise<ProgressMessage> {
  return sendProgressMessage(ctx, ACTION_IN_PROGRESS_TEXT);
}

/**
 * Отправляет сообщение ожидания генерации медиа.
 *
 * Голос/аудио/фото всё равно приходят отдельным сообщением, поэтому после
 * завершения генерации этот progress стоит заменить коротким статусом.
 */
export async function sendMediaProgress(ctx: Context): Promise<ProgressMessage> {
  return sendProgressMessage(ctx, MEDIA_IN_PROGRESS_TEXT);
}

/**
 * Отправляет сообщение «Распознаю голосовое сообщение…» (STT, issue #118).
 * После распознавания речи его текст заменяется результатом игрового действия.
 */
export async function sendVoiceProgress(ctx: Context): Promise<ProgressMessage> {
  return sendProgressMessage(ctx, VOICE_IN_PROGRESS_TEXT);
}

async function sendProgressMessage(ctx: Context, text: string): Promise<ProgressMessage> {
  const sent = await ctx.reply(text);
  // sent.chat обычно присутствует; ctx.chat — надёжный запасной источник id чата.
  const chatId = sent.chat?.id ?? ctx.chat?.id;
  const messageId = sent.message_id;
  return {
    async update(text: string, extra?: EditExtra): Promise<void> {
      await ctx.telegram.editMessageText(chatId, messageId, undefined, text, extra);
    },
  };
}
