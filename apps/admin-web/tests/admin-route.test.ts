import { describe, expect, it } from 'vitest';

import { buildRouteHash, parseRouteHash } from '../src/adminRoute';

const VIEWS = ['users', 'sessions', 'schemas', 'topics', 'llm'] as const;

describe('admin hash-роутинг', () => {
  it('разбирает раздел, сущность и фильтры из URL-хеша', () => {
    const route = parseRouteHash('#/topics/abc-123?status=open', VIEWS, 'users');
    expect(route).toEqual({ view: 'topics', entityId: 'abc-123', query: { status: 'open' } });
  });

  it('пустой хеш даёт раздел по умолчанию', () => {
    expect(parseRouteHash('', VIEWS, 'users')).toEqual({ view: 'users', entityId: null, query: {} });
    expect(parseRouteHash('#', VIEWS, 'users')).toEqual({ view: 'users', entityId: null, query: {} });
    expect(parseRouteHash('#/', VIEWS, 'users')).toEqual({ view: 'users', entityId: null, query: {} });
  });

  it('неизвестный раздел сбрасывается на fallback без сущности и фильтров', () => {
    expect(parseRouteHash('#/unknown/xx?status=open', VIEWS, 'users')).toEqual({
      view: 'users',
      entityId: null,
      query: {},
    });
  });

  it('раздел с фильтром без выбранной сущности', () => {
    expect(parseRouteHash('#/sessions?userId=u-1', VIEWS, 'users')).toEqual({
      view: 'sessions',
      entityId: null,
      query: { userId: 'u-1' },
    });
  });

  it('декодирует и кодирует спецсимволы в сущности', () => {
    const hash = buildRouteHash({ view: 'llm', entityId: 'gpt 4o/mini', query: {} });
    expect(parseRouteHash(hash, VIEWS, 'users')).toEqual({
      view: 'llm',
      entityId: 'gpt 4o/mini',
      query: {},
    });
  });

  it('собирает канонический хеш: пустые фильтры опускаются, ключи сортируются', () => {
    const hash = buildRouteHash({
      view: 'sessions',
      entityId: 's-1',
      query: { status: 'active', userId: 'u-1', gameId: '' },
    });
    expect(hash).toBe('#/sessions/s-1?status=active&userId=u-1');
  });

  it('хеш без сущности и фильтров содержит только раздел', () => {
    expect(buildRouteHash({ view: 'users', entityId: null, query: {} })).toBe('#/users');
  });

  it('parse и build обратимы для полного маршрута', () => {
    const route = { view: 'llm', entityId: 'req-9', query: { userId: 'u-2', requestKind: 'hint_generation' } };
    expect(parseRouteHash(buildRouteHash(route), VIEWS, 'users')).toEqual(route);
  });
});
