/**
 * Чистые построители текстов клиентского бота поддержки.
 * Вынесены отдельно от обработчиков, чтобы покрывать их юнит-тестами.
 */

/** Приветствие при /start в клиентском боте поддержки. */
export const SUPPORT_START_TEXT = [
  '👋 Это служба поддержки.',
  '',
  'Опишите вашу проблему или вопрос — сначала вам поможет 🤖 Бот СП. ' +
    'Если потребуется, он соберёт детали и передаст обращение администратору. ' +
    'Мы обязательно ответим прямо здесь.',
].join('\n');

/**
 * Реплика «Бота СП» по умолчанию, когда модель не вернула текст ответа,
 * но обращение продолжает консультироваться (issue #59).
 */
export const SUPPORT_DEFAULT_REPLY =
  'Расскажите, пожалуйста, подробнее: что вы делали, что ожидали и что пошло не так?';

/**
 * Реплика «Бота СП» при передаче обращения администратору, когда модель
 * не вернула собственный текст ответа (issue #59).
 */
export const SUPPORT_ESCALATION_REPLY =
  'Спасибо за подробности! Я передал ваше обращение администратору — он ответит здесь же.';

/**
 * Сообщение клиенту, когда консультацию нельзя выполнить из-за отсутствия
 * активной схемы поддержки (issue #238). Schema engine — единственный путь
 * исполнения, legacy удалён, поэтому при отсутствии схемы вместо тихого
 * фолбэка доставляется честная ошибка.
 */
export const SUPPORT_ERROR_REPLY =
  '⚠️ Сервис поддержки временно недоступен из-за технической ошибки. ' +
  'Пожалуйста, попробуйте позже.';

/** Оборачивает текст «Бота СП» маркировкой автора (issue #59). */
export function botSupportMessage(text: string): string {
  return `🤖 Бот СП:\n\n${text}`;
}

/** Сообщение клиенту о передаче обращения администратору (issue #59). */
export function ticketEscalatedMessage(ticketNumber: string | number): string {
  return `✅ Обращение #${ticketNumber} передано администратору. Мы ответим здесь же.`;
}

/**
 * Скомпилированная формулировка проблемы для специалистов СП (стадия 3,
 * issue #147). Подшивается в обращение отдельным служебным сообщением, чтобы
 * остаться в истории; клиенту не отправляется.
 */
export function compiledProblemMessage(problem: string): string {
  return `📋 Сформулированная проблема для СП:\n\n${problem}`;
}

/**
 * Подпись пользователя для администратора: @username, либо telegram_id,
 * если username не задан.
 */
export function formatUserLabel(username: string | null, telegramId: string | number): string {
  return username ? `@${username}` : `пользователь ${telegramId}`;
}

/** Сообщение клиенту о создании нового обращения. */
export function ticketCreatedMessage(ticketNumber: string | number): string {
  return [
    `✅ Обращение #${ticketNumber} создано.`,
    '',
    'Мы получили ваше сообщение и обязательно ответим — следите за этим чатом. ' +
      'Можно дополнить детали следующими сообщениями.',
  ].join('\n');
}

/** Подтверждение клиенту, что сообщение добавлено в уже открытое обращение. */
export function messageAcceptedMessage(ticketNumber: string | number): string {
  return `✉️ Сообщение добавлено в обращение #${ticketNumber}. Мы ответим здесь же.`;
}

/** Уведомление администраторам о новом обращении (отправляется в бот администраторов). */
export function adminNotificationMessage(input: {
  ticketNumber: string | number;
  userLabel: string;
  preview: string;
}): string {
  return [
    `🆕 Новое обращение #${input.ticketNumber} от ${input.userLabel}.`,
    '',
    input.preview,
    '',
    'Список обращений — команда /topics.',
  ].join('\n');
}

/** Текст ответа администратора, который доставляется клиенту. */
export function clientReplyMessage(text: string): string {
  return `💬 Служба поддержки:\n\n${text}`;
}

/** Уведомление клиенту о закрытии обращения администратором. */
export function ticketClosedMessage(ticketNumber: string | number): string {
  return [
    `✅ Обращение #${ticketNumber} закрыто.`,
    '',
    'Если у вас возникнут новые вопросы, напишите нам — мы создадим новое обращение.',
  ].join('\n');
}

/** Уведомление клиенту об автоматическом закрытии обращения (issue #149). */
export function ticketAutoClosedMessage(ticketNumber: string | number): string {
  return [
    `✅ Обращение #${ticketNumber} закрыто.`,
    '',
    'Рады, что смогли помочь! Если понадобится помощь снова — просто напишите нам.',
  ].join('\n');
}
