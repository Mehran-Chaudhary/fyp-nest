import { Injectable } from '@nestjs/common';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { CalculatorError, evaluateExpression, formatNumber } from '../domain/calculator';
import { defaultDataPolicy, Integrity } from '../domain/information-flow';
import { ToolDenialReason } from '../entities/tool-execution.entity';
import {
  ToolRuntimeError,
  type BuiltinTool,
  type BuiltinToolDefinition,
  type ToolOutput,
} from './builtin-tool';

/**
 * Exact arithmetic. Pure: no data leaves, nothing changes, so it accepts any
 * context and is always available.
 */
@Injectable()
export class CalculatorTool implements BuiltinTool {
  readonly definition: BuiltinToolDefinition = {
    name: 'calculator',
    displayName: 'Calculator',
    description:
      'Evaluates an arithmetic expression exactly. Use it for any calculation instead of ' +
      'working it out yourself. Supports + - * / % ^, parentheses, sqrt, abs, round(x, digits), ' +
      'floor, ceil, min, max, pow, ln, log, exp, pi and e. Example: round(950000 * 0.12, 2).',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
          description: 'The expression to evaluate. Numbers without thousands separators.',
        },
      },
      required: ['expression'],
      additionalProperties: false,
    },
    dataPolicy: defaultDataPolicy({ external: false, sideEffects: false }),
    resultIntegrity: Integrity.TRUSTED,
    requiresApproval: false,
    requiredPermissions: [],
    timeoutMs: 2_000,
  };

  isAvailable(): boolean {
    return true;
  }

  execute(args: Record<string, unknown>): Promise<ToolOutput> {
    try {
      const value = evaluateExpression(String(args.expression));
      return Promise.resolve({
        content: formatNumber(value),
        data: { value },
        metadata: { operators: countOperators(String(args.expression)) },
      });
    } catch (error) {
      if (error instanceof CalculatorError) {
        return Promise.reject(
          new ToolRuntimeError(ErrorCode.TOOL_ARGUMENTS_INVALID, error.message, {
            denial: ToolDenialReason.ARGUMENTS,
          }),
        );
      }
      return Promise.reject(error as Error);
    }
  }
}

function countOperators(expression: string): number {
  return (expression.match(/[+\-*/%^]/g) ?? []).length;
}
