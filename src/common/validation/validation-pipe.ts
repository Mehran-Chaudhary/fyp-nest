import {
  ValidationPipe,
  type ValidationError as ClassValidatorError,
} from '@nestjs/common';
import { ValidationError } from '../exceptions/app.exception';

/**
 * class-validator's error tree as messages per field, keyed by the property
 * path of the request: `email`, `settings.defaultChunkSize`, `items.0.name`.
 *
 * The path comes from the error tree, never from the message text. (Parsing
 * messages keyed errors by their first word, which filed password-policy
 * failures under "Password" and unknown fields under "property".) An unknown
 * field is reported under its own name.
 */
export function validationFieldErrors(
  errors: readonly ClassValidatorError[],
): Record<string, string[]> {
  const fields: Record<string, string[]> = {};

  const visit = (error: ClassValidatorError, parentPath: string): void => {
    const path = parentPath ? `${parentPath}.${error.property}` : error.property;
    const messages = Object.values(error.constraints ?? {});
    if (messages.length > 0) (fields[path] ??= []).push(...messages);
    for (const child of error.children ?? []) visit(child, path);
  };

  for (const error of errors) visit(error, '');
  return fields;
}

/**
 * The application's validation pipe. One definition, so that every entry
 * point (the HTTP app, tests that build it) validates identically.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    // Strips properties with no decorator. Without it, a client could set
    // fields the DTO never declared and any code doing `Object.assign(entity,
    // dto)` would write them straight to the database.
    whitelist: true,
    // Rejects rather than silently dropping, so an integration sending a
    // misspelled field learns about it instead of losing data quietly.
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    // 422 rather than 400: distinguishes "malformed request" from "well-formed
    // but semantically invalid", which the frontend renders differently.
    errorHttpStatusCode: 422,
    // Validator internals are not useful to a client and describe our DTOs.
    validationError: { target: false, value: false },
    stopAtFirstError: false,
    // `{ code: VALIDATION_FAILED, details: { fields: { <path>: [messages] } } }`.
    exceptionFactory: (errors) =>
      new ValidationError({ details: { fields: validationFieldErrors(errors) } }),
  });
}
