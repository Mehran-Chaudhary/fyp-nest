/**
 * Pagination helpers shared by every list endpoint so that the frontend can rely
 * on one envelope shape regardless of which module served the response.
 */

export interface PaginationMeta {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}

export interface PaginatedResult<T> {
  items: T[];
  meta: PaginationMeta;
}

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** Clamps caller supplied paging input into a safe range. */
export function normalisePagination(
  page?: number,
  limit?: number,
): { page: number; limit: number } {
  const safePage =
    Number.isInteger(page) && (page as number) > 0 ? (page as number) : DEFAULT_PAGE;
  const requestedLimit =
    Number.isInteger(limit) && (limit as number) > 0
      ? (limit as number)
      : DEFAULT_PAGE_SIZE;

  return { page: safePage, limit: Math.min(requestedLimit, MAX_PAGE_SIZE) };
}

/** Converts page/limit into the skip/take pair TypeORM expects. */
export function toSkipTake(page: number, limit: number): { skip: number; take: number } {
  const normalised = normalisePagination(page, limit);
  return {
    skip: (normalised.page - 1) * normalised.limit,
    take: normalised.limit,
  };
}

export function buildPaginationMeta(
  totalItems: number,
  page: number,
  limit: number,
): PaginationMeta {
  const normalised = normalisePagination(page, limit);
  const totalPages = normalised.limit > 0 ? Math.ceil(totalItems / normalised.limit) : 0;

  return {
    page: normalised.page,
    limit: normalised.limit,
    totalItems,
    totalPages,
    hasPreviousPage: normalised.page > 1,
    hasNextPage: normalised.page < totalPages,
  };
}

export function paginate<T>(
  items: T[],
  totalItems: number,
  page: number,
  limit: number,
): PaginatedResult<T> {
  return { items, meta: buildPaginationMeta(totalItems, page, limit) };
}
