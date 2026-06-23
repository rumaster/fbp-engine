import { describe, it, expect } from 'vitest';
import {
  SUPPORT_START_TEXT,
  adminNotificationMessage,
  clientReplyMessage,
  formatUserLabel,
  messageAcceptedMessage,
  ticketAutoClosedMessage,
  ticketClosedMessage,
  ticketCreatedMessage,
} from '../src/botSupport/messages.js';
import {
  TOPIC_STATUS_SYMBOL,
  topicButtonLabel,
  topicStatus,
  ticketActionsKeyboard,
  topicsKeyboard,
} from '../src/botSupportAdmin/menus.js';
import {
  formatDateTime,
  formatIncomingMessage,
  replySentText,
  ticketClosedConfirmText,
  ticketOpenedHeader,
} from '../src/botSupportAdmin/format.js';
import { BUY_STARS_HELP, helpKeyboard, supportChatUrl } from '../src/bot/menus.js';
import type { TicketWithReadState } from '@tg-games/core/db/repositories/support.js';
import { parseSupportConsultation } from '../src/botSupport/supportLlm.js';

/** Достаёт inline_keyboard из результата Markup-хелпера. */
function inlineKeyboard(markup: { reply_markup?: { inline_keyboard?: unknown[][] } }) {
  return markup.reply_markup?.inline_keyboard ?? [];
}

function ticket(overrides: Partial<TicketWithReadState> = {}): TicketWithReadState {
  return {
    id: 'tic-1',
    number: '7',
    user_id: 'user-1',
    status: 'open',
    last_message_at: new Date('2026-05-29T11:30:00Z'),
    created_at: new Date('2026-05-29T11:00:00Z'),
    user_username: 'vasya',
    user_telegram_id: '123456',
    admin_last_read: null,
    has_unread: true,
    ...overrides,
  };
}

describe('formatUserLabel (#57)', () => {
  it('возвращает @username, если он задан', () => {
    expect(formatUserLabel('vasya', '123')).toBe('@vasya');
  });

  it('подставляет telegram_id, если username отсутствует', () => {
    expect(formatUserLabel(null, 123)).toContain('123');
  });
});

describe('тексты клиентского бота (#57)', () => {
  it('приветствие упоминает службу поддержки', () => {
    expect(SUPPORT_START_TEXT.toLowerCase()).toContain('служба поддержки');
  });

  it('сообщение о создании обращения содержит номер и слово «создано»', () => {
    const text = ticketCreatedMessage(7);
    expect(text).toContain('#7');
    expect(text.toLowerCase()).toContain('создано');
  });

  it('подтверждение добавления сообщения содержит номер обращения', () => {
    expect(messageAcceptedMessage(7)).toContain('#7');
  });

  it('уведомление администраторам содержит номер, клиента, превью и команду /topics', () => {
    const text = adminNotificationMessage({
      ticketNumber: 7,
      userLabel: '@vasya',
      preview: 'не работает оплата',
    });
    expect(text).toContain('#7');
    expect(text).toContain('@vasya');
    expect(text).toContain('не работает оплата');
    expect(text).toContain('/topics');
  });

  it('ответ службы поддержки содержит исходный текст администратора', () => {
    const text = clientReplyMessage('Проблема решена');
    expect(text).toContain('Проблема решена');
    expect(text.toLowerCase()).toContain('поддержк');
  });
});

describe('topicStatus (#57)', () => {
  it('«new» — администратор ещё не открывал обращение (нет отметки прочтения)', () => {
    expect(topicStatus({ admin_last_read: null, has_unread: true })).toBe('new');
    // Отсутствие отметки приоритетнее флага непрочитанных.
    expect(topicStatus({ admin_last_read: null, has_unread: false })).toBe('new');
  });

  it('«unread» — есть непрочитанные сообщения клиента', () => {
    expect(
      topicStatus({ admin_last_read: new Date('2026-05-29T11:00:00Z'), has_unread: true }),
    ).toBe('unread');
  });

  it('«read» — новых сообщений нет', () => {
    expect(
      topicStatus({ admin_last_read: new Date('2026-05-29T11:00:00Z'), has_unread: false }),
    ).toBe('read');
  });

  it('каждому статусу сопоставлен цветной символ', () => {
    expect(TOPIC_STATUS_SYMBOL.new).toBe('🔵');
    expect(TOPIC_STATUS_SYMBOL.unread).toBe('🔴');
    expect(TOPIC_STATUS_SYMBOL.read).toBe('⚪️');
  });
});

describe('topicButtonLabel / topicsKeyboard (#57)', () => {
  it('подпись содержит символ статуса, дату, номер и клиента', () => {
    const label = topicButtonLabel(ticket({ admin_last_read: null }));
    expect(label).toContain('🔵'); // не открывалось
    expect(label).toContain('29.05'); // дата последнего сообщения (МСК)
    expect(label).toContain('14:30');
    expect(label).toContain('#7');
    expect(label).toContain('@vasya');
  });

  it('без username показывает telegram_id клиента', () => {
    const label = topicButtonLabel(ticket({ user_username: null }));
    expect(label).toContain('123456');
  });

  it('для прочитанного обращения символ статуса — ⚪️', () => {
    const label = topicButtonLabel(
      ticket({ admin_last_read: new Date('2026-05-29T11:30:00Z'), has_unread: false }),
    );
    expect(label).toContain('⚪️');
  });

  it('клавиатура — по одной кнопке на обращение с callback topic:<id>', () => {
    const kb = inlineKeyboard(topicsKeyboard([ticket({ id: 'a' }), ticket({ id: 'b' })]));
    expect(kb).toHaveLength(2);
    expect(kb[0][0]).toMatchObject({ callback_data: 'topic:a' });
    expect(kb[1][0]).toMatchObject({ callback_data: 'topic:b' });
  });
});

describe('тексты бота администраторов (#57)', () => {
  it('formatDateTime форматирует дату в зоне Europe/Moscow', () => {
    const text = formatDateTime(new Date('2026-05-29T11:30:00Z'));
    expect(text).toContain('29.05');
    expect(text).toContain('14:30');
  });

  it('заголовок при открытии без новых сообщений сообщает об их отсутствии', () => {
    const text = ticketOpenedHeader({ ticketNumber: 7, userLabel: '@vasya', unreadCount: 0 });
    expect(text).toContain('#7');
    expect(text.toLowerCase()).toContain('новых сообщений нет');
  });

  it('заголовок при одном новом сообщении использует единственное число', () => {
    const text = ticketOpenedHeader({ ticketNumber: 7, userLabel: '@vasya', unreadCount: 1 });
    expect(text).toContain('1 новое сообщение');
  });

  it('заголовок при нескольких новых сообщениях использует множественное число', () => {
    const text = ticketOpenedHeader({ ticketNumber: 7, userLabel: '@vasya', unreadCount: 3 });
    expect(text).toContain('3 новых сообщений');
  });

  it('входящее сообщение содержит текст и дату', () => {
    const text = formatIncomingMessage({
      text: 'не приходит ответ',
      created_at: new Date('2026-05-29T11:30:00Z'),
    });
    expect(text).toContain('не приходит ответ');
    expect(text).toContain('14:30');
  });

  it('подтверждение отправки ответа содержит номер обращения', () => {
    expect(replySentText(7)).toContain('#7');
  });
});

describe('helpKeyboard + кнопка «Служба поддержки» (#57)', () => {
  it('supportChatUrl строит ссылку t.me и срезает ведущий @', () => {
    expect(supportChatUrl('mybot')).toBe('https://t.me/mybot');
    expect(supportChatUrl('@mybot')).toBe('https://t.me/mybot');
  });

  it('с username добавляет URL-кнопку «Служба поддержки» первой строкой', () => {
    const kb = inlineKeyboard(helpKeyboard('mybot'));
    expect(kb).toHaveLength(2);
    expect(kb[0][0]).toMatchObject({ url: 'https://t.me/mybot' });
    expect(String((kb[0][0] as { text: string }).text)).toContain('Служба поддержки');
    // Кнопка «Как купить TG звёзды» остаётся.
    expect(kb[1][0]).toMatchObject({ callback_data: BUY_STARS_HELP });
  });

  it('без username кнопки поддержки нет — остаётся только «Как купить TG звёзды»', () => {
    const kb = inlineKeyboard(helpKeyboard());
    expect(kb).toHaveLength(1);
    expect(kb[0][0]).toMatchObject({ callback_data: BUY_STARS_HELP });
  });

  it('пустой username не добавляет кнопку поддержки', () => {
    const kb = inlineKeyboard(helpKeyboard(''));
    expect(kb).toHaveLength(1);
    expect(kb[0][0]).toMatchObject({ callback_data: BUY_STARS_HELP });
  });
});

describe('закрытие обращения (#149)', () => {
  it('ticketClosedMessage содержит номер обращения и слово «закрыто»', () => {
    const text = ticketClosedMessage(7);
    expect(text).toContain('#7');
    expect(text.toLowerCase()).toContain('закрыт');
  });

  it('ticketClosedMessage упоминает возможность нового обращения', () => {
    const text = ticketClosedMessage(7);
    expect(text.toLowerCase()).toMatch(/вопрос|обращен/);
  });

  it('ticketClosedConfirmText содержит номер обращения и слово «закрыт»', () => {
    const text = ticketClosedConfirmText(7);
    expect(text).toContain('#7');
    expect(text.toLowerCase()).toContain('закрыт');
  });

  it('ticketClosedConfirmText упоминает клиента', () => {
    const text = ticketClosedConfirmText(7);
    expect(text.toLowerCase()).toContain('клиент');
  });

  it('ticketActionsKeyboard содержит кнопку закрытия с callback close_ticket:<id>', () => {
    const kb = inlineKeyboard(ticketActionsKeyboard('tic-1'));
    expect(kb).toHaveLength(1);
    expect(kb[0][0]).toMatchObject({ callback_data: 'close_ticket:tic-1' });
    expect(String((kb[0][0] as { text: string }).text).toLowerCase()).toContain('закрыт');
  });
});

describe('автоматическое закрытие обращения (#149)', () => {
  it('ticketAutoClosedMessage содержит номер обращения и слово «закрыто»', () => {
    const text = ticketAutoClosedMessage(12);
    expect(text).toContain('#12');
    expect(text.toLowerCase()).toContain('закрыт');
  });

  it('ticketAutoClosedMessage содержит предложение обратиться снова', () => {
    const text = ticketAutoClosedMessage(12);
    expect(text.toLowerCase()).toMatch(/помо|обращ|вопрос/);
  });

  it('parseSupportConsultation разбирает поле resolved=true', () => {
    const result = parseSupportConsultation(
      JSON.stringify({ escalate: false, resolved: true, reply: 'Рад помочь!' }),
    );
    expect(result).not.toBeNull();
    expect(result?.resolved).toBe(true);
    expect(result?.escalate).toBe(false);
  });

  it('parseSupportConsultation разбирает resolved="true" (строка от LLM)', () => {
    const result = parseSupportConsultation(
      JSON.stringify({ escalate: false, resolved: 'true', reply: 'Окей' }),
    );
    expect(result?.resolved).toBe(true);
  });

  it('parseSupportConsultation по умолчанию resolved=false', () => {
    const result = parseSupportConsultation(
      JSON.stringify({ escalate: false, resolved: false, reply: 'Продолжаем' }),
    );
    expect(result?.resolved).toBe(false);
  });

  it('parseSupportConsultation resolved отсутствует → false', () => {
    const result = parseSupportConsultation(
      JSON.stringify({ escalate: false, reply: 'Продолжаем' }),
    );
    expect(result?.resolved).toBe(false);
  });
});
