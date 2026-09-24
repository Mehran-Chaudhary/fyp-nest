import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AppException } from '../../common/exceptions/app.exception';
import { AiServiceError } from '../../shared/ai-service/ai-service.types';
import { ObjectStorageError } from '../../shared/storage/object-storage.service';
import { VectorStoreError } from '../../shared/vector-store/vector-store.service';

/**
 * Translates a failure from a cloud dependency into the API's error contract.
 *
 * The client learns *which* dependency is unavailable — enough to show "search
 * is temporarily unavailable" rather than a generic error — and nothing about
 * endpoints, credentials or provider error text, which stay in the server log.
 */
export function toDependencyException(error: unknown): unknown {
  if (error instanceof AppException) return error;

  if (error instanceof ObjectStorageError) {
    if (error.notFound) {
      return new AppException(ErrorCode.DOCUMENT_CONTENT_UNAVAILABLE, HttpStatus.GONE, {
        cause: error,
      });
    }
    return new AppException(
      ErrorCode.OBJECT_STORAGE_UNAVAILABLE,
      HttpStatus.SERVICE_UNAVAILABLE,
      {
        cause: error,
      },
    );
  }

  if (error instanceof VectorStoreError) {
    return new AppException(
      ErrorCode.VECTOR_STORE_UNAVAILABLE,
      HttpStatus.SERVICE_UNAVAILABLE,
      {
        cause: error,
      },
    );
  }

  if (error instanceof AiServiceError) {
    return new AppException(
      ErrorCode.AI_SERVICE_UNAVAILABLE,
      HttpStatus.SERVICE_UNAVAILABLE,
      {
        cause: error,
        details: { reason: error.code },
      },
    );
  }

  return error;
}
