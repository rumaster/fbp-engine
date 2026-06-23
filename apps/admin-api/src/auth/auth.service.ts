import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { DatabaseService } from '../database/database.service';
import type { AdminSession } from './auth.types';

interface AdminUserRow {
  id: string;
  telegram_id: string;
  username: string | null;
  is_admin: boolean;
}

interface PendingCode {
  user: AdminUserRow;
  codeHash: string;
  expiresAt: number;
}

interface TokenPayload {
  uid: string;
  tg: string;
  username: string | null;
  exp: number;
}

function optionalConfig(config: ConfigService, key: string): string | undefined {
  const value = config.get<string>(key)?.trim();
  return value ? value : undefined;
}

function normalizeUsername(username: string): string {
  return username.trim().replace(/^@+/, '').toLowerCase();
}

@Injectable()
export class AuthService {
  private readonly pendingCodes = new Map<string, PendingCode>();
  private readonly codeTtlSeconds: number;
  private readonly tokenTtlSeconds: number;
  private readonly sessionSecret: string;
  private readonly botToken: string;

  constructor(
    config: ConfigService,
    private readonly database: DatabaseService,
  ) {
    this.codeTtlSeconds = Number(config.get<string>('ADMIN_AUTH_CODE_TTL_SECONDS') ?? '600');
    this.tokenTtlSeconds = Number(config.get<string>('ADMIN_AUTH_SESSION_TTL_SECONDS') ?? '28800');
    this.sessionSecret =
      optionalConfig(config, 'ADMIN_SESSION_SECRET') ??
      optionalConfig(config, 'ADMIN_AUTH_BOT_TOKEN') ??
      optionalConfig(config, 'SUPPORT_ADMIN_BOT_TOKEN') ??
      'local-admin-session-secret';
    this.botToken =
      optionalConfig(config, 'ADMIN_AUTH_BOT_TOKEN') ??
      optionalConfig(config, 'SUPPORT_ADMIN_BOT_TOKEN') ??
      '';
  }

  async requestLoginCode(username: string): Promise<{ expiresInSeconds: number }> {
    this.removeExpiredCodes();
    const key = normalizeUsername(username);
    const user = await this.findAdminByUsername(key);
    if (!user) {
      return { expiresInSeconds: this.codeTtlSeconds };
    }

    if (!this.botToken) {
      throw new UnauthorizedException('Не задан ADMIN_AUTH_BOT_TOKEN или SUPPORT_ADMIN_BOT_TOKEN');
    }

    const code = this.generateCode();
    this.pendingCodes.set(key, {
      user,
      codeHash: this.hashCode(key, code),
      expiresAt: Date.now() + this.codeTtlSeconds * 1000,
    });
    await this.sendCodeViaTelegram(user.telegram_id, code);
    return { expiresInSeconds: this.codeTtlSeconds };
  }

  async verifyLoginCode(username: string, code: string): Promise<{ token: string; admin: AdminSession }> {
    this.removeExpiredCodes();
    const key = normalizeUsername(username);
    const pending = this.pendingCodes.get(key);
    if (!pending || pending.expiresAt < Date.now()) {
      throw new UnauthorizedException('Код не найден или устарел');
    }

    const expected = Buffer.from(pending.codeHash, 'hex');
    const actual = Buffer.from(this.hashCode(key, code), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new UnauthorizedException('Неверный код');
    }

    this.pendingCodes.delete(key);
    const expiresAt = Math.floor(Date.now() / 1000) + this.tokenTtlSeconds;
    const admin: AdminSession = {
      userId: pending.user.id,
      telegramId: pending.user.telegram_id,
      username: pending.user.username,
      expiresAt,
    };
    return { token: this.signToken(admin), admin };
  }

  verifySessionToken(token: string): AdminSession {
    const [payloadPart, signature] = token.split('.');
    if (!payloadPart || !signature) {
      throw new UnauthorizedException('Некорректный токен');
    }
    const expected = this.sign(payloadPart);
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(signature);
    if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
      throw new UnauthorizedException('Некорректная подпись токена');
    }

    let payload: TokenPayload;
    try {
      payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as TokenPayload;
    } catch {
      throw new UnauthorizedException('Некорректный токен');
    }
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('Сессия устарела');
    }
    return {
      userId: payload.uid,
      telegramId: payload.tg,
      username: payload.username,
      expiresAt: payload.exp,
    };
  }

  private async findAdminByUsername(username: string): Promise<AdminUserRow | null> {
    const { rows } = await this.database.query<AdminUserRow>(
      `SELECT id, telegram_id::text AS telegram_id, username, is_admin
       FROM users
       WHERE LOWER(username) = $1 AND is_admin = TRUE`,
      [username],
    );
    return rows[0] ?? null;
  }

  private async sendCodeViaTelegram(telegramId: string, code: string): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramId,
        text: `Код входа в админ-панель tg-games: ${code}`,
      }),
    });
    if (!response.ok) {
      throw new UnauthorizedException('Не удалось отправить код через Telegram-бота');
    }
  }

  private generateCode(): string {
    return String(randomInt(100000, 1000000));
  }

  private hashCode(key: string, code: string): string {
    return createHmac('sha256', this.sessionSecret)
      .update(`${key}:${code}`)
      .digest('hex');
  }

  private signToken(admin: AdminSession): string {
    const payload: TokenPayload = {
      uid: admin.userId,
      tg: admin.telegramId,
      username: admin.username,
      exp: admin.expiresAt,
    };
    const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${payloadPart}.${this.sign(payloadPart)}`;
  }

  private sign(payloadPart: string): string {
    return createHmac('sha256', this.sessionSecret).update(payloadPart).digest('base64url');
  }

  private removeExpiredCodes(): void {
    const now = Date.now();
    for (const [key, pending] of this.pendingCodes.entries()) {
      if (pending.expiresAt < now) this.pendingCodes.delete(key);
    }
  }
}
