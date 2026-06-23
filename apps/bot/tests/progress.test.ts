/**
 * Тесты для «прогресс»-сообщения (issue #36).
 *
 * Проверяем, что:
 * 1. sendProgress сразу отправляет сообщение «Действие выполняется…».
 * 2. update заменяет текст того же сообщения на результат действия
 *    (по chat_id и message_id отправленного сообщения).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Context } from 'telegraf';
import { ACTION_IN_PROGRESS_TEXT, sendProgress } from '../src/bot/progress.js';

/** Создаёт мок Telegraf-контекста с фиксированными chat_id/message_id. */
function createFakeCtx(chatId = 555, messageId = 42) {
  const reply = vi.fn(async (text: string) => ({
    message_id: messageId,
    chat: { id: chatId },
    text,
  }));
  const editMessageText = vi.fn(async () => true);
  const ctx = {
    reply,
    telegram: { editMessageText },
  } as unknown as Context;
  return { ctx, reply, editMessageText, chatId, messageId };
}

describe('sendProgress / ProgressMessage (#36)', () => {
  it('сразу отправляет сообщение «Действие выполняется…»', async () => {
    const { ctx, reply } = createFakeCtx();

    await sendProgress(ctx);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(ACTION_IN_PROGRESS_TEXT);
  });

  it('update заменяет текст того же сообщения на результат', async () => {
    const { ctx, editMessageText, chatId, messageId } = createFakeCtx();

    const progress = await sendProgress(ctx);
    await progress.update('Вы нашли монету.');

    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenCalledWith(
      chatId,
      messageId,
      undefined,
      'Вы нашли монету.',
      undefined,
    );
  });

  it('update пробрасывает дополнительные параметры (parse_mode)', async () => {
    const { ctx, editMessageText, chatId, messageId } = createFakeCtx();

    const progress = await sendProgress(ctx);
    await progress.update('*Итог*', { parse_mode: 'Markdown' });

    expect(editMessageText).toHaveBeenCalledWith(
      chatId,
      messageId,
      undefined,
      '*Итог*',
      { parse_mode: 'Markdown' },
    );
  });
});
