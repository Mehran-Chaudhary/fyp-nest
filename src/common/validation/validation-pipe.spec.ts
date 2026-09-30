import 'reflect-metadata';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsInt,
  IsOptional,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { ErrorCode } from '../enums/error-code.enum';
import { AppException } from '../exceptions/app.exception';
import { createValidationPipe } from './validation-pipe';

class SettingsDto {
  @IsOptional()
  @IsInt()
  @Min(64)
  defaultChunkSize?: number;
}

class ItemDto {
  @Matches(/^[a-z]+$/, { message: 'name must be lowercase letters' })
  name: string;
}

class BodyDto {
  @IsEmail({}, { message: 'email must be a valid email address' })
  email: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'a member must hold at least one role' })
  roleIds: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => SettingsDto)
  settings?: SettingsDto;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ItemDto)
  items?: ItemDto[];
}

async function fieldsFor(body: unknown): Promise<Record<string, string[]>> {
  try {
    await createValidationPipe().transform(body, { type: 'body', metatype: BodyDto });
  } catch (error) {
    expect(error).toBeInstanceOf(AppException);
    const app = error as AppException;
    expect(app.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(app.getStatus()).toBe(422);
    return (app.details as { fields: Record<string, string[]> }).fields;
  }
  throw new Error('expected a validation failure');
}

describe('createValidationPipe', () => {
  it('keys errors by property, not by the first word of the message', async () => {
    const fields = await fieldsFor({ email: 'nope', roleIds: [] });
    expect(fields).toEqual({
      email: ['email must be a valid email address'],
      roleIds: ['a member must hold at least one role'],
    });
  });

  it('reports an unknown field under its own name', async () => {
    const fields = await fieldsFor({ email: 'a@b.co', roleIds: ['x'], extra: 1 });
    expect(Object.keys(fields)).toEqual(['extra']);
  });

  it('uses dotted paths for nested objects and array items', async () => {
    const fields = await fieldsFor({
      email: 'a@b.co',
      roleIds: ['x'],
      settings: { defaultChunkSize: 10, bogus: true },
      items: [{ name: 'ok' }, { name: 'NOT' }],
    });
    expect(Object.keys(fields).sort()).toEqual([
      'items.1.name',
      'settings.bogus',
      'settings.defaultChunkSize',
    ]);
  });

  it('passes a valid body through', async () => {
    await expect(
      createValidationPipe().transform(
        { email: 'a@b.co', roleIds: ['x'] },
        { type: 'body', metatype: BodyDto },
      ),
    ).resolves.toBeInstanceOf(BodyDto);
  });

  it('files a message that starts with another word under its property', async () => {
    // The password policy's messages start with "Password …" / "That password …";
    // they must land on the field that failed, not on those words.
    class PasswordDto {
      @Matches(/\d/, {
        message: 'That password is too common. Password must contain a number.',
      })
      newPassword: string;
    }
    try {
      await createValidationPipe().transform(
        { newPassword: 'abc' },
        { type: 'body', metatype: PasswordDto },
      );
      throw new Error('expected a validation failure');
    } catch (error) {
      expect((error as AppException).details).toEqual({
        fields: {
          newPassword: ['That password is too common. Password must contain a number.'],
        },
      });
    }
  });
});
