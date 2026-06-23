export interface ListResponse<T> {
  total?: number;
  items: T[];
}

export interface AdminSession {
  userId: string;
  telegramId: string;
  username: string | null;
  expiresAt: number;
}

export type ApiRecord = Record<string, unknown>;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function apiFetch<T>(
  token: string | null,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);

  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const message =
      typeof data === 'object' && data !== null && 'message' in data
        ? String((data as { message: unknown }).message)
        : `HTTP ${response.status}`;
    throw new ApiError(message, response.status);
  }
  return data as T;
}

export function moneyMillicents(value: unknown): string {
  const numeric = Number(value ?? 0) / 100000;
  return `${numeric.toFixed(4)} $`;
}

export function formatDate(value: unknown): string {
  if (typeof value !== 'string') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function shortId(value: unknown): string {
  if (typeof value !== 'string') return '—';
  return value.length > 12 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}
