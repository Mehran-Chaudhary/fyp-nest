import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min, MaxLength } from 'class-validator';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../utils/pagination.util';

export enum SortDirection {
  ASC = 'ASC',
  DESC = 'DESC',
}

/**
 * Query parameters shared by every list endpoint.
 *
 * `limit` is capped rather than merely defaulted. An uncapped page size is a
 * denial-of-service vector — `?limit=1000000` on the audit log would attempt to
 * materialise the entire table — and capping in the DTO means no individual
 * controller can forget to.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Page number, 1-based.',
    minimum: 1,
    default: DEFAULT_PAGE,
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page must be an integer' })
  @Min(1, { message: 'page must be at least 1' })
  page: number = DEFAULT_PAGE;

  @ApiPropertyOptional({
    description: `Items per page. Values above ${MAX_PAGE_SIZE} are clamped.`,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1, { message: 'limit must be at least 1' })
  @Max(MAX_PAGE_SIZE, { message: `limit cannot exceed ${MAX_PAGE_SIZE}` })
  limit: number = DEFAULT_PAGE_SIZE;

  @ApiPropertyOptional({
    description: 'Free-text search term. Interpretation depends on the endpoint.',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;

  @ApiPropertyOptional({
    description:
      'Field to sort by. Each endpoint validates this against its own allowlist; ' +
      'an unrecognised value falls back to the endpoint default rather than erroring.',
    example: 'createdAt',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  sortBy?: string;

  @ApiPropertyOptional({ enum: SortDirection, default: SortDirection.DESC })
  @IsOptional()
  @IsEnum(SortDirection)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  sortDirection: SortDirection = SortDirection.DESC;

  get skip(): number {
    return (this.page - 1) * this.limit;
  }

  get take(): number {
    return Math.min(this.limit, MAX_PAGE_SIZE);
  }

  /**
   * Resolves `sortBy` against an allowlist of sortable columns.
   *
   * Never interpolate a user-supplied column name into SQL. Even through an ORM,
   * an unvalidated `ORDER BY` is an injection point, and it can also be used to
   * sort by a column the caller should not be able to observe at all.
   */
  resolveSort(
    allowed: readonly string[],
    fallback: string,
  ): { field: string; direction: SortDirection } {
    const field = this.sortBy && allowed.includes(this.sortBy) ? this.sortBy : fallback;
    return { field, direction: this.sortDirection };
  }
}
