import { Injectable } from '@nestjs/common';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { defaultDataPolicy, Integrity } from '../domain/information-flow';
import { ToolDenialReason } from '../entities/tool-execution.entity';
import {
  ToolRuntimeError,
  type BuiltinTool,
  type BuiltinToolDefinition,
  type ToolOutput,
} from './builtin-tool';

/**
 * The current date and time. Models have no clock; "how many days until the
 * end of the quarter?" needs one.
 */
@Injectable()
export class CurrentDateTimeTool implements BuiltinTool {
  readonly definition: BuiltinToolDefinition = {
    name: 'current_datetime',
    displayName: 'Current date and time',
    description:
      'Returns the current date, time and weekday, optionally in a given IANA time zone ' +
      '(for example Asia/Karachi). Defaults to UTC.',
    parameters: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          maxLength: 64,
          description: 'An IANA time zone name such as Asia/Karachi or Europe/London.',
        },
      },
      additionalProperties: false,
    },
    dataPolicy: defaultDataPolicy({ external: false, sideEffects: false }),
    resultIntegrity: Integrity.TRUSTED,
    requiresApproval: false,
    requiredPermissions: [],
    timeoutMs: 1_000,
  };

  /** The clock; overridden in tests. */
  now(): Date {
    return new Date();
  }

  isAvailable(): boolean {
    return true;
  }

  execute(args: Record<string, unknown>): Promise<ToolOutput> {
    const timeZone =
      typeof args.timezone === 'string' && args.timezone ? args.timezone : 'UTC';
    let formatted: string;
    try {
      formatted = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        dateStyle: 'full',
        timeStyle: 'long',
      }).format(this.now());
    } catch {
      return Promise.reject(
        new ToolRuntimeError(
          ErrorCode.TOOL_ARGUMENTS_INVALID,
          `"${timeZone.slice(0, 64)}" is not a known IANA time zone.`,
          { denial: ToolDenialReason.ARGUMENTS },
        ),
      );
    }
    const iso = this.now().toISOString();
    return Promise.resolve({
      content: `${formatted} (${timeZone}). ISO 8601 (UTC): ${iso}`,
      data: { iso, timeZone, formatted },
    });
  }
}
