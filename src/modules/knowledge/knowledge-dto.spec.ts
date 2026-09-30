import 'reflect-metadata';
import { AppException } from '../../common/exceptions/app.exception';
import { createValidationPipe } from '../../common/validation/validation-pipe';
import { ListDocumentsQueryDto, UpdateDocumentDto } from './documents/dto/document.dto';
import { UpdateKnowledgeBaseDto } from './knowledge-bases/dto/knowledge-base.dto';

async function validate(metatype: new () => object, body: unknown): Promise<unknown> {
  return createValidationPipe().transform(body, { type: 'body', metatype });
}

async function fieldsFor(
  metatype: new () => object,
  body: unknown,
): Promise<Record<string, string[]>> {
  try {
    await validate(metatype, body);
  } catch (error) {
    expect(error).toBeInstanceOf(AppException);
    return ((error as AppException).details as { fields: Record<string, string[]> }).fields;
  }
  throw new Error('expected a validation failure');
}

describe('knowledge PATCH bodies and null', () => {
  it('refuses null for knowledge-base fields that cannot be cleared', async () => {
    const fields = await fieldsFor(UpdateKnowledgeBaseDto, {
      name: null,
      accessMode: null,
      defaultClassification: null,
    });
    expect(Object.keys(fields).sort()).toEqual([
      'accessMode',
      'defaultClassification',
      'name',
    ]);
  });

  it('accepts null where it means "clear" or "inherit"', async () => {
    await expect(
      validate(UpdateKnowledgeBaseDto, {
        description: null,
        chunkSize: null,
        chunkOverlap: null,
      }),
    ).resolves.toBeInstanceOf(UpdateKnowledgeBaseDto);
    await expect(
      validate(UpdateDocumentDto, { description: null }),
    ).resolves.toBeInstanceOf(UpdateDocumentDto);
  });

  it('refuses null for document fields that cannot be cleared', async () => {
    // classification: null used to reach the clearance check and answer 500.
    const fields = await fieldsFor(UpdateDocumentDto, {
      title: null,
      classification: null,
      tags: null,
    });
    expect(Object.keys(fields).sort()).toEqual(['classification', 'tags', 'title']);
  });

  it('accepts one status or a comma-separated list on the document list', async () => {
    const pipe = createValidationPipe();
    const parse = (status: unknown) =>
      pipe.transform({ status }, { type: 'query', metatype: ListDocumentsQueryDto });

    await expect(parse('READY')).resolves.toMatchObject({ status: ['READY'] });
    await expect(parse('PARSING, CHUNKING,EMBEDDING')).resolves.toMatchObject({
      status: ['PARSING', 'CHUNKING', 'EMBEDDING'],
    });
    await expect(parse(['UPLOADED', 'FAILED'])).resolves.toMatchObject({
      status: ['UPLOADED', 'FAILED'],
    });
    await expect(parse('READY,DONE')).rejects.toBeInstanceOf(AppException);
  });

  it('still treats an absent field as unchanged', async () => {
    await expect(validate(UpdateDocumentDto, {})).resolves.toBeInstanceOf(
      UpdateDocumentDto,
    );
    await expect(
      validate(UpdateKnowledgeBaseDto, { name: 'Finance' }),
    ).resolves.toBeInstanceOf(UpdateKnowledgeBaseDto);
  });
});
