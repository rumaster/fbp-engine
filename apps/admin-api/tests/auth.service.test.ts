import { describe, expect, it, vi, afterEach } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';
import type { DatabaseService } from '../src/database/database.service';

function makeConfig(values: Record<string, string>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as ConfigService;
}

function makeDatabase(rows: unknown[]): DatabaseService {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as DatabaseService;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuthService', () => {
  it('отправляет одноразовый код через Telegram по имени @name и выдаёт подписанный токен', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const database = makeDatabase([{ id: 'admin-1', telegram_id: '999', username: 'root', is_admin: true }]);
    const service = new AuthService(
      makeConfig({
        ADMIN_AUTH_BOT_TOKEN: 'bot-token',
        ADMIN_SESSION_SECRET: 'secret',
      }),
      database,
    );

    await service.requestLoginCode('@Root');

    // Поиск администратора выполняется по нормализованному (без @, в нижнем регистре) имени.
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining('LOWER(username)'), ['root']);

    // Код отправляется в Telegram на chat_id из telegram_id найденного администратора.
    const sendBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { chat_id: string; text: string };
    expect(sendBody.chat_id).toBe('999');
    const code = sendBody.text.match(/\d{6}/)?.[0];
    expect(code).toMatch(/^\d{6}$/);

    const result = await service.verifyLoginCode('@Root', code ?? '');

    expect(result.admin).toMatchObject({ userId: 'admin-1', telegramId: '999', username: 'root' });
    expect(service.verifySessionToken(result.token)).toMatchObject({ userId: 'admin-1', telegramId: '999' });
  });

  it('не отправляет код, если имя не принадлежит администратору', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const service = new AuthService(
      makeConfig({ ADMIN_AUTH_BOT_TOKEN: 'bot-token', ADMIN_SESSION_SECRET: 'secret' }),
      makeDatabase([]),
    );

    await service.requestLoginCode('@stranger');

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(service.verifyLoginCode('@stranger', '111111')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('использует ADMIN_AUTH_BOT_TOKEN как fallback-секрет сессии', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const service = new AuthService(
      makeConfig({ ADMIN_AUTH_BOT_TOKEN: 'bot-token-secret' }),
      makeDatabase([{ id: 'admin-1', telegram_id: '999', username: 'root', is_admin: true }]),
    );

    await service.requestLoginCode('@root');
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { text: string };
    const code = requestBody.text.match(/\d{6}/)?.[0] ?? '';
    const result = await service.verifyLoginCode('@root', code);
    const defaultSecretService = new AuthService(makeConfig({}), makeDatabase([]));

    expect(service.verifySessionToken(result.token)).toMatchObject({ userId: 'admin-1' });
    expect(() => defaultSecretService.verifySessionToken(result.token)).toThrow(UnauthorizedException);
  });

  it('игнорирует пустой ADMIN_AUTH_BOT_TOKEN и использует SUPPORT_ADMIN_BOT_TOKEN', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const service = new AuthService(
      makeConfig({ ADMIN_AUTH_BOT_TOKEN: '', SUPPORT_ADMIN_BOT_TOKEN: 'support-bot-token' }),
      makeDatabase([{ id: 'admin-1', telegram_id: '999', username: 'root', is_admin: true }]),
    );

    await service.requestLoginCode('@root');
    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { text: string };
    const code = requestBody.text.match(/\d{6}/)?.[0] ?? '';
    const result = await service.verifyLoginCode('@root', code);

    expect(requestUrl).toContain('/botsupport-bot-token/sendMessage');
    expect(service.verifySessionToken(result.token)).toMatchObject({ telegramId: '999' });
  });
});
