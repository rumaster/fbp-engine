export interface AdminSession {
  userId: string;
  telegramId: string;
  username: string | null;
  expiresAt: number;
}

export interface AdminRequest {
  headers: Record<string, string | string[] | undefined>;
  admin?: AdminSession;
}
