import type { GameState } from '@tg-games/core/types.js';
import type { CharacterPreset, LocationPreset } from '@tg-games/core/games/manifests.js';
import { formatWorldTimeLine } from '@tg-games/core/games/manifests.js';
import type { StepRow } from '@tg-games/core/db/repositories/steps.js';

export interface SessionBudget {
  cost_millicents: number;
  allocated_millicents: number;
}

/** Форматирует навыки персонажа в читаемую строку. */
function formatSkills(skills: Record<string, number>): string {
  const entries = Object.entries(skills);
  if (entries.length === 0) return '—';
  return entries.map(([name, level]) => `${name} (${level})`).join(', ');
}

/** Форматирует инвентарь персонажа в читаемую строку. */
function formatInventory(inventory: string[]): string {
  return inventory.length ? inventory.join(', ') : 'пусто';
}

/**
 * Формирует сообщение со статусом игрока (команда/кнопка «Статус»).
 *
 * Включает последний нарратив: именно он попадёт в промпт следующего хода
 * (state сериализуется целиком), поэтому игрок видит актуальный контекст сцены.
 */
export function formatStatus(state: GameState, budget?: SessionBudget): string {
  const c = state.character;
  const lines = [
    `📍 Локация: ${state.location}`,
    `🕰 Время: ${formatWorldTimeLine(state.world_time)}`,
    `❤️ Здоровье: ${c.hp}/${c.max_hp}`,
    `🎯 Навыки: ${formatSkills(c.skills)}`,
    `🎒 Инвентарь: ${formatInventory(c.inventory)}`,
    `🔢 Ход: ${state.turn_count}`,
    '',
    '📖 Последняя сцена:',
    state.narrative,
  ];

  if (budget !== undefined) {
    lines.push('', `💰 Кредиты: ${budget.cost_millicents} из ${budget.allocated_millicents}`);
  }
  return lines.join('\n');
}

/**
 * Формирует сообщение со списком подсказок: нумерованное перечисление
 * действий. Кнопки для их выполнения добавляются отдельно (см. hintsKeyboard).
 */
export function formatHints(hints: string[]): string {
  const lines = hints.map((h, i) => `${i + 1}) ${h}`).join('\n\n');
  return ['Возможные действия:', '', lines].join('\n');
}

/**
 * Формирует сообщение с выбором персонажа: нумерованное перечисление пресетов
 * с описанием и стартовым инвентарём. Кнопки выбора добавляются отдельно
 * (см. characterPresetsKeyboard).
 */
export function formatCharacterPresets(presets: CharacterPreset[]): string {
  const lines = presets
    .map(
      (p, i) =>
        `${i + 1}. ${p.name}\n${p.description}\n🎒 Инвентарь: ${formatInventory(p.character.inventory)}`,
    )
    .join('\n\n');
  return ['Выберите персонажа:', '', lines].join('\n');
}

/**
 * Формирует сообщение с выбором стартовой локации: нумерованное перечисление
 * пресетов с вводным нарративом. Кнопки выбора добавляются отдельно
 * (см. locationPresetsKeyboard).
 */
export function formatLocationPresets(presets: LocationPreset[]): string {
  const lines = presets.map((p, i) => `${i + 1}. ${p.location}\n${p.narrative}`).join('\n\n');
  return ['Выберите стартовую локацию:', '', lines].join('\n');
}

/**
 * Формирует историю ходов завершённой игры (кнопка завершённой игры
 * в разделе «Мои игры»).
 *
 * Отменённые командой /cancel ходы (issue #116) выгружаются вместе с
 * остальными, но помечаются как отменённые.
 */
export function formatHistory(steps: StepRow[]): string {
  if (steps.length === 0) {
    return 'В этой игре не было ходов.';
  }
  const lines = steps.map((s, i) => {
    const action = s.action_text ?? '—';
    const outcome = s.changes_summary ?? '';
    const marker = s.is_cancelled ? '🚫 ' : '🎮 ';
    const suffix = s.is_cancelled ? ' (отменён)' : '';
    return `Ход ${i + 1}. ${marker}${action}${suffix}\n${outcome}`.trim();
  });
  return ['🗒 История ходов:', '', lines.join('\n\n')].join('\n');
}
