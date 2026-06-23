import { describe, expect, it } from 'vitest';
import {
  ADMIN_LIST_PAGE_SIZE,
  buildPagedSearchParams,
  pageCount,
  pageRange,
} from '../src/adminPagination';

describe('admin pagination helpers', () => {
  it('строит limit/offset для выбранной страницы списка', () => {
    const params = buildPagedSearchParams(
      {
        search: 'alice',
        empty: '',
        missing: undefined,
      },
      3,
    );

    expect(params.get('limit')).toBe(String(ADMIN_LIST_PAGE_SIZE));
    expect(params.get('offset')).toBe('100');
    expect(params.get('search')).toBe('alice');
    expect(params.has('empty')).toBe(false);
    expect(params.has('missing')).toBe(false);
  });

  it('считает страницы и видимый диапазон строк', () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(101)).toBe(3);
    expect(pageRange(101, 3)).toEqual({ from: 101, to: 101 });
    expect(pageRange(0, 1)).toEqual({ from: 0, to: 0 });
  });
});
