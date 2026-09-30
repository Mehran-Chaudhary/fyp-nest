import { ValidateIf } from 'class-validator';

/**
 * `@IsOptional()` for a field that may be left out but never set to `null`.
 *
 * `@IsOptional()` skips validation for `null` as well as `undefined`, so on a
 * PATCH body `{ "name": null }` passed every constraint and reached the
 * database, which answered a NOT NULL violation (a 422 naming no field) or, for
 * values used in logic first, a 500. With this decorator an absent field is
 * skipped and `null` is validated like any other value, so the field's own
 * constraints refuse it with a message keyed by the property.
 */
export const IsOptionalNotNull = (): PropertyDecorator =>
  ValidateIf((_object: object, value: unknown) => value !== undefined);
