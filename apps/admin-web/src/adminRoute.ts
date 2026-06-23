import { useCallback, useEffect, useState } from 'react';

// Hash-роутинг админки (issue #152). Всё навигационное состояние — раздел,
// выбранная сущность и фильтры — кодируется в URL вида
// `#/topics/abc-123?status=open`, чтобы закладки и расшаренные ссылки
// воспроизводили страницу, а кнопки «Назад»/«Вперёд» браузера работали.

export interface AdminRoute {
  // Ключ активного раздела админки (см. ViewKey в App.tsx).
  view: string;
  // Идентификатор выбранной сущности внутри раздела (id, ключ, алиас) или null.
  entityId: string | null;
  // Фильтры раздела (поиск, статусы и т.п.) — только непустые значения.
  query: Record<string, string>;
}

// Разбирает hash-строку (`#/view/entity?filter=value`) в объект маршрута.
// Неизвестный раздел сбрасывается на fallbackView без сущности и фильтров.
export function parseRouteHash(
  hash: string,
  allowedViews: readonly string[],
  fallbackView: string,
): AdminRoute {
  let raw = hash.startsWith('#') ? hash.slice(1) : hash;

  let queryString = '';
  const queryIndex = raw.indexOf('?');
  if (queryIndex >= 0) {
    queryString = raw.slice(queryIndex + 1);
    raw = raw.slice(0, queryIndex);
  }

  const segments = raw
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));

  const query: Record<string, string> = {};
  new URLSearchParams(queryString).forEach((value, key) => {
    if (value) query[key] = value;
  });

  const view = segments[0] ?? fallbackView;
  if (!allowedViews.includes(view)) {
    return { view: fallbackView, entityId: null, query: {} };
  }

  const entityId = segments[1] ? segments[1] : null;

  return { view, entityId, query };
}

// Собирает hash-строку из маршрута. Пустые фильтры опускаются, ключи
// сортируются — так одинаковое состояние всегда даёт одинаковый URL.
export function buildRouteHash(route: AdminRoute): string {
  const path = [route.view, route.entityId]
    .filter((part): part is string => Boolean(part))
    .map((part) => encodeURIComponent(part))
    .join('/');

  const params = new URLSearchParams();
  Object.keys(route.query)
    .sort()
    .forEach((key) => {
      const value = route.query[key];
      if (value) params.set(key, value);
    });

  const queryString = params.toString();
  return `#/${path}${queryString ? `?${queryString}` : ''}`;
}

// Подписка на hash-навигацию. Возвращает текущий маршрут и функцию перехода.
// `navigate(route, replace)` использует History API: pushState добавляет запись
// в историю (кнопка «Назад» работает), replaceState — заменяет текущую.
export function useHashRoute(
  allowedViews: readonly string[],
  fallbackView: string,
): [AdminRoute, (route: AdminRoute, replace?: boolean) => void] {
  const [route, setRoute] = useState<AdminRoute>(() =>
    parseRouteHash(window.location.hash, allowedViews, fallbackView),
  );

  useEffect(() => {
    const sync = () =>
      setRoute(parseRouteHash(window.location.hash, allowedViews, fallbackView));
    // popstate ловит кнопки «Назад»/«Вперёд», hashchange — ручную правку URL.
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, [allowedViews, fallbackView]);

  const navigate = useCallback(
    (next: AdminRoute, replace = false) => {
      const hash = buildRouteHash(next);
      const url = `${window.location.pathname}${window.location.search}${hash}`;
      // pushState/replaceState не вызывают popstate — обновляем состояние сами.
      if (replace) {
        window.history.replaceState(null, '', url);
      } else {
        window.history.pushState(null, '', url);
      }
      setRoute(parseRouteHash(hash, allowedViews, fallbackView));
    },
    [allowedViews, fallbackView],
  );

  return [route, navigate];
}
