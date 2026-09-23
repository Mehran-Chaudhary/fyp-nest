import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { MembershipStatus } from '../entities/organization-member.entity';

const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

export class ListMembersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: MembershipStatus })
  @IsOptional()
  @IsEnum(MembershipStatus)
  status?: MembershipStatus;

  @ApiPropertyOptional({ description: 'Only members holding this role.', format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  roleId?: string;
}

export class SetMemberRolesDto {
  @ApiProperty({
    description:
      'The complete set of roles this member should hold. Replaces the current ' +
      'set rather than adding to it.',
    type: [String],
    format: 'uuid',
  })
  @IsArray()
  @ArrayNotEmpty({ message: 'a member must hold at least one role' })
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  roleIds: string[];
}

export class UpdateMemberProfileDto {
  @ApiPropertyOptional({
    description: 'Workspace-local display name, overriding the account-level one.',
    maxLength: 120,
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Trim()
  displayName?: string;

  @ApiPropertyOptional({ example: 'Head of Compliance', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Trim()
  title?: string;
}

export class SuspendMemberDto {
  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Trim()
  reason?: string;
}

// ── Responses ───────────────────────────────────────────────────────────────

export class MemberRoleDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;

  @ApiProperty({ nullable: true })
  color: string | null;

  @ApiProperty()
  priority: number;
}

export class MemberDto {
  @ApiProperty({ format: 'uuid', description: 'Membership id, not the user id.' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  userId: string;

  @ApiProperty()
  email: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiProperty()
  displayName: string;

  @ApiProperty({ nullable: true })
  avatarUrl: string | null;

  @ApiProperty({ nullable: true })
  title: string | null;

  @ApiProperty({ enum: MembershipStatus })
  status: MembershipStatus;

  @ApiProperty({ type: [MemberRoleDto] })
  roles: MemberRoleDto[];

  @ApiProperty({
    description: 'Highest role priority held. Determines who may act on this member.',
  })
  highestRolePriority: number;

  @ApiProperty()
  isOwner: boolean;

  @ApiProperty({ format: 'date-time', nullable: true })
  joinedAt: Date | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  lastActiveAt: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}
