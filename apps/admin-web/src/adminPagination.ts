export const ADMIN_LIST_PAGE_SIZE = 50;

export function normalizePage(page: number): number {
  return Number.isFinite(page) && page > 1 ? Math.floor(page) : 1;
}

export function pageOffset(page: number, pageSize = ADMIN_LIST_PAGE_SIZE): number {
  return (normalizePage(page) - 1) * pageSize;
}

export function pageCount(total: number, pageSize = ADMIN_LIST_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(total, 0) / pageSize));
}

export function pageRange(
  total: number,
  page: number,
  pageSize = ADMIN_LIST_PAGE_SIZE,
): { from: number; to: number } {
  if (total <= 0) return { from: 0, to: 0 };
  const offset = pageOffset(page, pageSize);
  return {
    from: Math.min(offset + 1, total),
    to: Math.min(offset + pageSize, total),
  };
}

export function buildPagedSearchParams(
  filters: Record<string, string | undefined>,
  page: number,
  pageSize = ADMIN_LIST_PAGE_SIZE,
): URLSearchParams {
  const params = new URLSearchParams({
    limit: String(pageSize),
    offset: String(pageOffset(page, pageSize)),
  });

  Object.entries(filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });

  return params;
}
