import { getPool } from '../pool.js';

/** Автор сообщения: клиент, администратор или бот-консультант (issue #59). */
export type SupportSender = 'user' | 'admin' | 'bot';
/**
 * Статус обращения (issue #59, #149, #244):
 *  - `open`        — обращение на консультации у LLM-бота первой линии;
 *  - `escalated`   — обращение передано оператору и видно администраторам (issue #244);
 *  - `closed`      — обращение закрыто администратором;
 *  - `auto_closed` — обращение автоматически закрыто ботом, проблема решена (issue #149).
 *
 * `open` и `escalated` — два активных состояния: пока обращение в одном из них,
 * новые сообщения клиента подшиваются в него, а не создают новое обращение.
 */
export type SupportTicketStatus = 'open' | 'escalated' | 'closed' | 'auto_closed';

/** Обращение клиента в службу поддержки («топик»). */
export interface SupportTicketRow {
  id: string;
  /** Человекочитаемый номер обращения (#nnn). node-postgres отдаёт BIGINT строкой. */
  number: string;
  user_id: string;
  status: SupportTicketStatus;
  /** Дата последнего сообщения в обращении. */
  last_message_at: Date;
  /**
   * Момент передачи обращения администратору (issue #59). Пока null, обращение
   * на консультации у LLM-бота первой линии и не видно администраторам.
   */
  escalated_at: Date | null;
  created_at: Date;
}

/** Одно сообщение внутри обращения. */
export interface SupportMessageRow {
  id: string;
  ticket_id: string;
  sender: SupportSender;
  sender_id: string | null;
  text: string;
  created_at: Date;
}

/** Обращение вместе с состоянием прочтения конкретным администратором. */
export interface TicketWithReadState {
  id: string;
  number: string;
  user_id: string;
  status: SupportTicketStatus;
  last_message_at: Date;
  created_at: Date;
  /** Username клиента (для отображения администратору) или null. */
  user_username: string | null;
  /** telegram_id клиента (строкой, как отдаёт node-postgres). */
  user_telegram_id: string;
  /** Момент, до которого администратор прочитал обращение, или null (не открывал). */
  admin_last_read: Date | null;
  /** Есть ли сообщения клиента, которые администратор ещё не видел. */
  has_unread: boolean;
}

/**
 * Возвращает активное обращение пользователя или создаёт новое.
 *
 * Активным считается обращение в статусе `open` (на консультации) или
 * `escalated` (передано оператору, issue #244) — в оба сообщения клиента
 * подшиваются, а не создают новое обращение.
 *
 * Флаг `created` равен true, только если обращение было создано в этом вызове —
 * по нему клиентский бот решает, отправлять ли приветственный текст и уведомлять
 * ли администраторов о новом обращении. Выполняется в одной транзакции.
 */
export async function getOrCreateActiveTicket(
  userId: string,
): Promise<{ ticket: SupportTicketRow; created: boolean }> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<SupportTicketRow>(
      `SELECT * FROM support_tickets
       WHERE user_id = $1 AND status IN ('open', 'escalated')
       LIMIT 1`,
      [userId],
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return { ticket: existing.rows[0], created: false };
    }
    const inserted = await client.query<SupportTicketRow>(
      `INSERT INTO support_tickets (user_id) VALUES ($1) RETURNING *`,
      [userId],
    );
    await client.query('COMMIT');
    return { ticket: inserted.rows[0], created: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Помечает обращение переданным оператору (issue #59, #244): переводит статус в
 * `escalated` и проставляет escalated_at, если он ещё не задан. Срабатывает
 * только для обращения на консультации (status = 'open'), поэтому идемпотентно —
 * повторный вызов на уже эскалированном обращении ничего не меняет и не сдвигает
 * момент эскалации.
 */
export async function markTicketEscalated(ticketId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE support_tickets
     SET status = 'escalated', escalated_at = COALESCE(escalated_at, now())
     WHERE id = $1 AND status = 'open'`,
    [ticketId],
  );
}

/**
 * Возвращает все сообщения обращения по возрастанию даты (issue #59).
 * Используется LLM-ботом-консультантом для восстановления контекста диалога.
 */
export async function listTicketMessages(ticketId: string): Promise<SupportMessageRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<SupportMessageRow>(
    'SELECT * FROM support_messages WHERE ticket_id = $1 ORDER BY created_at ASC',
    [ticketId],
  );
  return rows;
}

/** Возвращает обращение по id или null. */
export async function getTicketById(ticketId: string): Promise<SupportTicketRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<SupportTicketRow>(
    'SELECT * FROM support_tickets WHERE id = $1',
    [ticketId],
  );
  return rows[0] ?? null;
}

/**
 * Добавляет сообщение в обращение и обновляет дату последнего сообщения.
 * Обе записи выполняются в одной транзакции.
 */
export async function addSupportMessage(input: {
  ticketId: string;
  sender: SupportSender;
  senderId: string | null;
  text: string;
}): Promise<SupportMessageRow> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<SupportMessageRow>(
      `INSERT INTO support_messages (ticket_id, sender, sender_id, text)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.ticketId, input.sender, input.senderId, input.text],
    );
    await client.query('UPDATE support_tickets SET last_message_at = now() WHERE id = $1', [
      input.ticketId,
    ]);
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Возвращает переданные оператору обращения вместе с состоянием прочтения для
 * администратора. Показываются только обращения в статусе `escalated` (issue
 * #244) — обращения на стадии консультации (`open`) администраторам не видны.
 * Поле has_unread учитывает только сообщения клиента (sender = 'user'),
 * поскольку именно они ожидают ответа администратора.
 * Сортировка — по дате последнего сообщения (свежие сверху).
 */
export async function listActiveTicketsForAdmin(
  adminId: string,
): Promise<TicketWithReadState[]> {
  const pool = getPool();
  const { rows } = await pool.query<TicketWithReadState>(
    `SELECT
        t.id,
        t.number,
        t.user_id,
        t.status,
        t.last_message_at,
        t.created_at,
        u.username          AS user_username,
        u.telegram_id       AS user_telegram_id,
        r.last_message_date AS admin_last_read,
        EXISTS (
            SELECT 1 FROM support_messages m
            WHERE m.ticket_id = t.id
              AND m.sender = 'user'
              AND (r.last_message_date IS NULL OR m.created_at > r.last_message_date)
        ) AS has_unread
     FROM support_tickets t
     JOIN users u ON u.id = t.user_id
     LEFT JOIN support_admin_ticket_reads r
            ON r.ticket_id = t.id AND r.admin_id = $1
     WHERE t.status = 'escalated'
     ORDER BY t.last_message_at DESC`,
    [adminId],
  );
  return rows;
}

/**
 * Возвращает непрочитанные сообщения клиента в обращении: те, что созданы
 * позже момента `since` (или все сообщения клиента, если `since` равен null).
 */
export async function getUnreadUserMessages(
  ticketId: string,
  since: Date | null,
): Promise<SupportMessageRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<SupportMessageRow>(
    `SELECT * FROM support_messages
     WHERE ticket_id = $1 AND sender = 'user'
       AND ($2::timestamptz IS NULL OR created_at > $2)
     ORDER BY created_at ASC`,
    [ticketId, since],
  );
  return rows;
}

/** Возвращает дату прочтения обращения администратором (или null, если не открывал). */
export async function getAdminReadDate(
  adminId: string,
  ticketId: string,
): Promise<Date | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ last_message_date: Date | null }>(
    'SELECT last_message_date FROM support_admin_ticket_reads WHERE admin_id = $1 AND ticket_id = $2',
    [adminId, ticketId],
  );
  return rows[0]?.last_message_date ?? null;
}

/**
 * Помечает обращение прочитанным администратором до момента `date`.
 * Маркер прочтения никогда не сдвигается назад (GREATEST с текущим значением).
 */
export async function markTicketRead(
  adminId: string,
  ticketId: string,
  date: Date,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO support_admin_ticket_reads (admin_id, ticket_id, last_message_date)
     VALUES ($1, $2, $3)
     ON CONFLICT (admin_id, ticket_id)
     DO UPDATE SET last_message_date = GREATEST(
         support_admin_ticket_reads.last_message_date, EXCLUDED.last_message_date
     )`,
    [adminId, ticketId, date],
  );
}

/**
 * Закрывает обращение администратором: переводит статус в 'closed'. Закрыть
 * можно только обращение, переданное оператору (status = 'escalated', issue
 * #244) — именно такие видны администратору.
 * Возвращает закрытое обращение или null, если оно не найдено или уже закрыто.
 */
export async function closeTicket(ticketId: string): Promise<SupportTicketRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<SupportTicketRow>(
    `UPDATE support_tickets SET status = 'closed' WHERE id = $1 AND status = 'escalated' RETURNING *`,
    [ticketId],
  );
  return rows[0] ?? null;
}

/**
 * Автоматически закрывает обращение LLM-консультантом: переводит статус в
 * 'auto_closed'. Вызывается только если пользователь явно подтвердил, что
 * проблема решена (поле resolved=true в ответе LLM, issue #149).
 * Возвращает закрытое обращение или null, если оно уже закрыто/не найдено.
 */
export async function autoCloseTicket(ticketId: string): Promise<SupportTicketRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<SupportTicketRow>(
    `UPDATE support_tickets SET status = 'auto_closed' WHERE id = $1 AND status = 'open' RETURNING *`,
    [ticketId],
  );
  return rows[0] ?? null;
}
