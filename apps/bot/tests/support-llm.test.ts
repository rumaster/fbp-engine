import { describe, it, expect } from 'vitest';
import {
  compactSupportText,
  formatSupportDialog,
  parseSupportConsultation,
  type SupportTurn,
} from '../src/botSupport/supportLlm.js';
import {
  SUPPORT_START_TEXT,
  botSupportMessage,
  ticketEscalatedMessage,
} from '../src/botSupport/messages.js';

// issue #238: оркестрация консультации (buildSupportSystemPrompt / buildSupportPrompt /
// runSupportConsultation) перенесена в schema engine, а legacy-функции удалены.
// Здесь остаются юнит-тесты переиспользуемых чистых помощников supportLlm.

describe('formatSupportDialog / compactSupportText (#238)', () => {
  it('подписывает роли по-русски и идёт от старых сообщений к новым', () => {
    const turns: SupportTurn[] = [
      { sender: 'user', text: 'не приходит ответ' },
      { sender: 'bot', text: 'в какой игре?' },
      { sender: 'user', text: 'в бомже' },
    ];
    const dialog = formatSupportDialog(turns);
    expect(dialog).toContain('Пользователь: не приходит ответ');
    expect(dialog).toContain('Бот СП: в какой игре?');
    expect(dialog.indexOf('не приходит ответ')).toBeLessThan(dialog.indexOf('в бомже'));
  });

  it('уплотняет длинный текст, заменяя пробелы и обрезая хвост', () => {
    const compacted = compactSupportText('  привет   мир  ');
    expect(compacted).toBe('привет мир');
  });
});

describe('parseSupportConsultation (#59)', () => {
  it('разбирает валидный ответ с escalate=false', () => {
    const r = parseSupportConsultation('{"escalate": false, "reply": "уточните детали", "summary": ""}');
    expect(r).toEqual({ escalate: false, resolved: false, reply: 'уточните детали', summary: undefined });
  });

  it('разбирает escalate=true со скомпилированным описанием', () => {
    const r = parseSupportConsultation(
      '{"escalate": true, "reply": "передал админу", "summary": "оплата не зачислилась"}',
    );
    expect(r?.escalate).toBe(true);
    expect(r?.summary).toBe('оплата не зачислилась');
  });

  it('принимает строковое "true" для escalate', () => {
    const r = parseSupportConsultation('{"escalate": "true", "reply": "ок", "summary": "проблема"}');
    expect(r?.escalate).toBe(true);
  });

  it('извлекает JSON из markdown-ограждения', () => {
    const r = parseSupportConsultation('```json\n{"escalate": false, "reply": "привет"}\n```');
    expect(r?.reply).toBe('привет');
  });

  it('возвращает null, если нет ни reply, ни summary', () => {
    expect(parseSupportConsultation('{"escalate": true}')).toBeNull();
  });

  it('возвращает null на не-JSON', () => {
    expect(parseSupportConsultation('совсем не json')).toBeNull();
  });
});

describe('тексты «Бота СП» (#59)', () => {
  it('приветствие упоминает Бота СП', () => {
    expect(SUPPORT_START_TEXT).toContain('Бот СП');
  });

  it('botSupportMessage маркирует сообщение как «Бот СП»', () => {
    const text = botSupportMessage('чем помочь?');
    expect(text).toContain('Бот СП');
    expect(text).toContain('чем помочь?');
  });

  it('сообщение о передаче содержит номер обращения и слово «администратору»', () => {
    const text = ticketEscalatedMessage(7);
    expect(text).toContain('#7');
    expect(text.toLowerCase()).toContain('администратору');
  });
});
