import { describe, it, expect } from 'vitest';
import { formatHints, formatHistory, formatStatus, type SessionBudget } from '../src/bot/format.js';
import {
  BUY_STARS_HELP,
  activeGamesKeyboard,
  finishedGamesKeyboard,
  helpKeyboard,
  hintsKeyboard,
} from '../src/bot/menus.js';
import { buildInitialState } from '@tg-games/core/games/manifests.js';
import { TEST_GAMES as GAMES, testGameTitleMap } from './fixtures/gameManifests.js';
import type { GameState } from '@tg-games/core/types.js';
import type { SessionRow } from '@tg-games/core/db/repositories/sessions.js';
import type { StepRow } from '@tg-games/core/db/repositories/steps.js';

const state: GameState = buildInitialState(GAMES.bomj);

/** Достаёт inline_keyboard из результата Markup-хелпера. */
function inlineKeyboard(markup: { reply_markup?: { inline_keyboard?: unknown[][] } }) {
  return markup.reply_markup?.inline_keyboard ?? [];
}

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    game_id: 'bomj',
    user_id: 'user-1',
    is_active: true,
    is_processing: false,
    current_state: { ...state, turn_count: 7 },
    allocated_millicents: 200,
    used_credits: 0,
    token_usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    cost_millicents: 0,
    created_at: new Date(),
    ...overrides,
  };
}

describe('formatStatus (#7)', () => {
  it('содержит последний нарратив, который пойдёт в промпт следующего хода', () => {
    const text = formatStatus(state);
    expect(text).toContain(state.location);
    expect(text).toContain(`${state.character.hp}/${state.character.max_hp}`);
    expect(text).toContain('Инвентарь');
    // Время мира выводится в статусе (issue #67).
    expect(text).toContain('08:00 (утро), 14 октября, осень');
    // Ключевое требование #7 — нарратив присутствует в статусе.
    expect(text).toContain(state.narrative);
  });

  it('не содержит строку кредитов без бюджета сессии', () => {
    const text = formatStatus(state);
    expect(text).not.toContain('Кредиты');
  });

  it('отображает кредитный бюджет сессии (#37)', () => {
    const budget: SessionBudget = { cost_millicents: 1603, allocated_millicents: 2000 };
    const text = formatStatus(state, budget);
    expect(text).toContain('Кредиты: 1603 из 2000');
  });

  it('отображает нулевой расход кредитов в начале сессии', () => {
    const budget: SessionBudget = { cost_millicents: 0, allocated_millicents: 2000 };
    const text = formatStatus(state, budget);
    expect(text).toContain('Кредиты: 0 из 2000');
  });
});

describe('formatHints (#3)', () => {
  it('нумерует действия списком 1) 2) 3)', () => {
    const text = formatHints(['осмотреться', 'идти на север', 'обыскать мусорку']);
    expect(text).toContain('1) осмотреться');
    expect(text).toContain('2) идти на север');
    expect(text).toContain('3) обыскать мусорку');
  });
});

describe('hintsKeyboard (#3)', () => {
  it('возвращает один ряд кнопок с номерами и callback hint:<index>', () => {
    const kb = inlineKeyboard(hintsKeyboard(['a', 'b', 'c']));
    expect(kb).toHaveLength(1); // все кнопки в одном ряду
    expect(kb[0]).toHaveLength(3);
    expect(kb[0][0]).toMatchObject({ text: '1', callback_data: 'hint:0' });
    expect(kb[0][2]).toMatchObject({ text: '3', callback_data: 'hint:2' });
  });
});

describe('helpKeyboard (#5)', () => {
  it('содержит кнопку «Как купить TG звёзды» с нужным callback', () => {
    const kb = inlineKeyboard(helpKeyboard());
    expect(kb[0][0]).toMatchObject({ callback_data: BUY_STARS_HELP });
    expect(kb[0][0]).toHaveProperty('text');
    expect(String((kb[0][0] as { text: string }).text)).toContain('звёзды');
  });
});

describe('keyboards для «Мои игры» (#6)', () => {
  it('активные игры → callback session:<id> с именем сценария', () => {
    const kb = inlineKeyboard(activeGamesKeyboard([session({ id: 'a1' })], testGameTitleMap(['bomj'])));
    expect(kb[0][0]).toMatchObject({ callback_data: 'session:a1' });
    expect(String((kb[0][0] as { text: string }).text)).toContain(GAMES.bomj.name);
  });

  it('завершённые игры → callback history:<id>', () => {
    const kb = inlineKeyboard(
      finishedGamesKeyboard([session({ id: 'f1', is_active: false })], testGameTitleMap(['bomj'])),
    );
    expect(kb[0][0]).toMatchObject({ callback_data: 'history:f1' });
  });
});

describe('formatHistory (#6)', () => {
  it('сообщает об отсутствии ходов для пустой истории', () => {
    expect(formatHistory([])).toContain('не было ходов');
  });

  it('перечисляет ходы с действиями и их исходами', () => {
    const steps: StepRow[] = [
      {
        id: 's1',
        session_id: 'sess-1',
        action_text: 'осмотреться',
        llm_raw_response: null,
        changes_summary: 'Вы нашли монету',
        step_credits: 0,
        token_usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        cost_millicents: 0,
        created_at: new Date(),
      },
      {
        id: 's2',
        session_id: 'sess-1',
        action_text: 'идти на север',
        llm_raw_response: null,
        changes_summary: 'Вы пришли к реке',
        step_credits: 0,
        token_usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        cost_millicents: 0,
        created_at: new Date(),
      },
    ];
    const text = formatHistory(steps);
    expect(text).toContain('Ход 1');
    expect(text).toContain('осмотреться');
    expect(text).toContain('Вы нашли монету');
    expect(text).toContain('Ход 2');
    expect(text).toContain('идти на север');
  });
});
