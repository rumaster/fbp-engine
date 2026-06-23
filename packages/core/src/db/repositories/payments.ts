import { getPool } from '../pool.js';

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'canceled';

export interface PaymentRow {
  id: string;
  user_id: string;
  session_id: string | null;
  amount: number;
  status: PaymentStatus;
  telegram_charge_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: Date;
}

export interface CreatePaymentInput {
  userId: string;
  amount: number;
  status?: PaymentStatus;
  payload?: Record<string, unknown>;
}

/** Создаёт запись о платеже (по умолчанию в статусе pending). */
export async function createPayment(input: CreatePaymentInput): Promise<PaymentRow> {
  const pool = getPool();
  const { rows } = await pool.query<PaymentRow>(
    `INSERT INTO payment_logs (user_id, amount, status, payload)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [
      input.userId,
      input.amount,
      input.status ?? 'pending',
      input.payload ? JSON.stringify(input.payload) : null,
    ],
  );
  return rows[0];
}

/**
 * Помечает платёж оплаченным и связывает его с сессией.
 */
export async function markPaymentPaid(
  paymentId: string,
  telegramChargeId: string,
  sessionId: string | null,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE payment_logs
     SET status = 'paid', telegram_charge_id = $2, session_id = $3
     WHERE id = $1`,
    [paymentId, telegramChargeId, sessionId],
  );
}

/** Обновляет статус платежа. */
export async function updatePaymentStatus(
  paymentId: string,
  status: PaymentStatus,
): Promise<void> {
  const pool = getPool();
  await pool.query('UPDATE payment_logs SET status = $2 WHERE id = $1', [paymentId, status]);
}
