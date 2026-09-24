import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import {
  ApiEnvelopedResponse,
  ApiErrorResponse,
  ApiPaginatedResponse,
  ApiStandardErrors,
} from '../../../common/decorators/api-response.decorators';
import {
  Auth,
  RequirePermissions,
  SkipResponseEnvelope,
  ThrottlePolicy,
  TimeoutBudget,
} from '../../../common/decorators/auth.decorators';
import { AuthType } from '../../../common/enums/auth-type.enum';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import type { PaginatedResult } from '../../../common/utils/pagination.util';
import { THROTTLE_POLICY } from '../../../config/throttle.config';
import { Classification } from '../domain/classification';
import type { AccessPrincipal } from '../domain/access';
import { CurrentAccessPrincipal } from '../knowledge.decorators';
import { DocumentsService } from './documents.service';
import {
  DocumentChunkDto,
  DocumentDto,
  ListDocumentsQueryDto,
  UpdateDocumentDto,
  UploadDocumentDto,
  type UploadedDocumentFile,
} from './dto/document.dto';

/**
 * The Document Vault (proposal module 6.4).
 */
@ApiTags('Documents')
@ApiBearerAuth()
@Controller({ path: 'organizations/:organizationId', version: '1' })
@ApiParam({ name: 'organizationId', description: 'Workspace UUID or slug.' })
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post('knowledge-bases/:knowledgeBaseId/documents')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('document:create')
  @ThrottlePolicy(THROTTLE_POLICY.UPLOAD)
  @TimeoutBudget('upload')
  @UseInterceptors(FileInterceptor('file'))
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'PDF, DOCX, TXT or Markdown.',
        },
        title: { type: 'string', maxLength: 255 },
        description: { type: 'string', maxLength: 2000 },
        classification: { type: 'string', enum: Object.values(Classification) },
        tags: { type: 'string', description: 'Comma-separated.' },
      },
    },
  })
  @ApiOperation({
    summary: 'Upload a document',
    description:
      'Returns 202: the file is stored (encrypted) and queued for parsing and ' +
      'embedding. Poll the document, or watch `status`, until it is READY. The type ' +
      'is determined from the file’s contents; the Content-Type you send is ignored.',
  })
  @ApiEnvelopedResponse(DocumentDto, 'Accepted for processing')
  @ApiErrorResponse(415, [
    ErrorCode.DOCUMENT_TYPE_NOT_ALLOWED,
    ErrorCode.DOCUMENT_CONTENT_MISMATCH,
    ErrorCode.DOCUMENT_EMPTY,
  ])
  @ApiErrorResponse(409, [ErrorCode.DOCUMENT_DUPLICATE])
  @ApiErrorResponse(413, [ErrorCode.PAYLOAD_TOO_LARGE])
  @ApiErrorResponse(403, [
    ErrorCode.KNOWLEDGE_BASE_ACCESS_DENIED,
    ErrorCode.CLASSIFICATION_EXCEEDS_CLEARANCE,
    ErrorCode.STORAGE_QUOTA_EXCEEDED,
  ])
  @ApiErrorResponse(503, [
    ErrorCode.KNOWLEDGE_LAYER_NOT_CONFIGURED,
    ErrorCode.OBJECT_STORAGE_UNAVAILABLE,
  ])
  @ApiStandardErrors()
  upload(
    @Param('organizationId') _identifier: string,
    @Param('knowledgeBaseId', new ParseUUIDPipe({ version: '4' })) knowledgeBaseId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @UploadedFile() file: UploadedDocumentFile | undefined,
    @Body() dto: UploadDocumentDto,
  ): Promise<DocumentDto> {
    return this.documents.upload(principal, knowledgeBaseId, file, dto);
  }

  @Get('documents')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('document:read')
  @ApiOperation({
    summary: 'List documents',
    description:
      'Across every knowledge base you can read, or one with `knowledgeBaseId`. ' +
      'Documents above your clearance are not listed.',
  })
  @ApiPaginatedResponse(DocumentDto)
  @ApiStandardErrors()
  list(
    @Param('organizationId') _identifier: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: ListDocumentsQueryDto,
  ): Promise<PaginatedResult<DocumentDto>> {
    return this.documents.list(principal, {
      page: query.page,
      limit: query.take,
      knowledgeBaseId: query.knowledgeBaseId,
      status: query.status,
      classification: query.classification,
      search: query.search,
      sortBy: query.sortBy,
      sortDirection: query.sortDirection,
    });
  }

  @Get('documents/:documentId')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('document:read')
  @ApiOperation({ summary: 'Get a document and its processing status' })
  @ApiEnvelopedResponse(DocumentDto)
  @ApiErrorResponse(404, [ErrorCode.DOCUMENT_NOT_FOUND])
  @ApiStandardErrors()
  get(
    @Param('organizationId') _identifier: string,
    @Param('documentId', new ParseUUIDPipe({ version: '4' })) documentId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<DocumentDto> {
    return this.documents.get(principal, documentId);
  }

  @Get('documents/:documentId/chunks')
  @RequirePermissions('document:read')
  @ApiOperation({
    summary: 'Read the chunks retrieval serves',
    description:
      'Decrypted text of the active index version — exactly what an agent would see.',
  })
  @ApiPaginatedResponse(DocumentChunkDto)
  @ApiErrorResponse(404, [ErrorCode.DOCUMENT_NOT_FOUND])
  @ApiStandardErrors()
  chunks(
    @Param('organizationId') _identifier: string,
    @Param('documentId', new ParseUUIDPipe({ version: '4' })) documentId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResult<DocumentChunkDto>> {
    return this.documents.listChunks(principal, documentId, query.page, query.take);
  }

  @Get('documents/:documentId/download')
  @RequirePermissions('document:download')
  @SkipResponseEnvelope()
  @TimeoutBudget('upload')
  @ApiProduces('application/octet-stream')
  @ApiOperation({
    summary: 'Download the original file',
    description:
      'Decrypted and integrity-checked before any byte is sent. Every download is audited.',
  })
  @ApiErrorResponse(404, [ErrorCode.DOCUMENT_NOT_FOUND])
  @ApiErrorResponse(410, [ErrorCode.DOCUMENT_CONTENT_UNAVAILABLE])
  @ApiStandardErrors()
  async download(
    @Param('organizationId') _identifier: string,
    @Param('documentId', new ParseUUIDPipe({ version: '4' })) documentId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const file = await this.documents.download(principal, documentId);

    response.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(file.content, {
      type: file.mimeType,
      length: file.content.length,
      disposition: contentDisposition(file.filename),
    });
  }

  @Patch('documents/:documentId')
  @RequirePermissions('document:update')
  @ApiOperation({
    summary: 'Edit metadata or reclassify',
    description:
      'Reclassification takes effect for retrieval immediately; vector payloads are ' +
      'updated in the background.',
  })
  @ApiEnvelopedResponse(DocumentDto)
  @ApiErrorResponse(403, [ErrorCode.CLASSIFICATION_EXCEEDS_CLEARANCE])
  @ApiStandardErrors()
  update(
    @Param('organizationId') _identifier: string,
    @Param('documentId', new ParseUUIDPipe({ version: '4' })) documentId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: UpdateDocumentDto,
  ): Promise<DocumentDto> {
    return this.documents.update(principal, documentId, dto);
  }

  @Post('documents/:documentId/reindex')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('document:reindex')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Re-run parsing and embedding',
    description:
      'Creates a new index version. The current version keeps answering queries until ' +
      'the new one is complete, so reindexing never takes a document offline.',
  })
  @ApiEnvelopedResponse(DocumentDto)
  @ApiErrorResponse(409, [ErrorCode.DOCUMENT_PROCESSING])
  @ApiStandardErrors()
  reindex(
    @Param('organizationId') _identifier: string,
    @Param('documentId', new ParseUUIDPipe({ version: '4' })) documentId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<DocumentDto> {
    return this.documents.reindex(principal, documentId);
  }

  @Delete('documents/:documentId')
  @RequirePermissions('document:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a document and destroy its content',
    description:
      'Irreversible. The document’s encryption key is destroyed immediately, making ' +
      'every copy of its content unreadable — including backups.',
  })
  @ApiErrorResponse(404, [ErrorCode.DOCUMENT_NOT_FOUND])
  @ApiStandardErrors()
  async remove(
    @Param('organizationId') _identifier: string,
    @Param('documentId', new ParseUUIDPipe({ version: '4' })) documentId: string,
    @CurrentAccessPrincipal() principal: AccessPrincipal,
  ): Promise<{ deleted: true }> {
    await this.documents.remove(principal, documentId);
    return { deleted: true };
  }
}

/**
 * `attachment` with both an ASCII fallback and an RFC 5987 UTF-8 name, so
 * non-Latin filenames survive every browser. `attachment` rather than `inline`
 * matters: an uploaded file must never render in the API's origin.
 */
function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
