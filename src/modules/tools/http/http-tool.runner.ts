import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { TOOLS_CONFIG_KEY, type ToolsConfig } from '../../../config/tools.config';
import { ToolRuntimeError, type ToolOutput } from '../builtins/builtin-tool';
import {
  EgressBlockedError,
  parseAllowlist,
  type AllowlistEntry,
} from '../domain/egress-guard';
import {
  HttpTemplateError,
  renderHttpRequest,
  resolvePointer,
  type HttpToolConfig,
  type RenderedHttpRequest,
  type ToolDescriptor,
} from '../domain/tool-definition';
import { ToolDenialReason } from '../entities/tool-execution.entity';
import { HttpToolError, SafeHttpClient } from './safe-http.client';

/** Inspects a request about to leave; returns a reason to stop it, or null. */
export type EgressInspector = (request: RenderedHttpRequest) => Promise<string | null>;

/**
 * Runs workspace-defined HTTP tools.
 *
 * The request is rendered from the tool's fixed template and the model's
 * validated arguments, inspected for personal data by the caller-supplied
 * inspector (the same check the LLM gateway applies to prompts), given its
 * credential, and sent through {@link SafeHttpClient}, which enforces the
 * egress allowlist and refuses private addresses. The response is decoded,
 * narrowed by the tool's `responsePath`, and bounded in size.
 */
@Injectable()
export class HttpToolRunner {
  private readonly config: ToolsConfig;
  private readonly allowlist: AllowlistEntry[];
  private readonly client: SafeHttpClient;

  constructor(configService: ConfigService) {
    this.config = configService.getOrThrow<ToolsConfig>(TOOLS_CONFIG_KEY);
    this.allowlist = parseAllowlist(this.config.http.allowedHosts);
    this.client = new SafeHttpClient({
      allowlist: this.allowlist,
      allowPrivateNetworks: this.config.http.allowPrivateNetworks,
      allowInsecure: this.config.http.allowInsecure,
      userAgent: this.config.http.userAgent,
    });
  }

  /** HTTP tools are offered only once the operator has allowed at least one host. */
  get isAvailable(): boolean {
    return this.allowlist.length > 0;
  }

  get allowedHosts(): readonly AllowlistEntry[] {
    return this.allowlist;
  }

  async run(input: {
    tool: ToolDescriptor & { http: HttpToolConfig };
    secret: string | null;
    args: Record<string, unknown>;
    inspect: EgressInspector;
    signal: AbortSignal;
  }): Promise<ToolOutput> {
    if (!this.isAvailable) {
      throw new ToolRuntimeError(
        ErrorCode.TOOL_EGRESS_BLOCKED,
        'Outbound HTTP tools are disabled on this deployment (TOOL_HTTP_ALLOWED_HOSTS is empty).',
        { denial: ToolDenialReason.EGRESS },
      );
    }

    let rendered: RenderedHttpRequest;
    try {
      rendered = renderHttpRequest(input.tool.http, input.args);
    } catch (error) {
      if (error instanceof HttpTemplateError) {
        throw new ToolRuntimeError(ErrorCode.TOOL_ARGUMENTS_INVALID, error.message, {
          denial: ToolDenialReason.ARGUMENTS,
        });
      }
      throw error;
    }

    const refusal = await input.inspect(rendered);
    if (refusal) {
      throw new ToolRuntimeError(ErrorCode.TOOL_PII_BLOCKED, refusal, {
        denial: ToolDenialReason.PII,
      });
    }

    const headers = {
      ...rendered.headers,
      ...this.authHeaders(input.tool.http, input.secret),
    };

    let response;
    try {
      response = await this.client.send({
        url: rendered.url,
        method: input.tool.http.method,
        headers,
        body: rendered.body,
        timeoutMs: input.tool.timeoutMs,
        maxResponseBytes: this.config.http.maxResponseBytes,
        signal: input.signal,
      });
    } catch (error) {
      if (error instanceof EgressBlockedError) {
        throw new ToolRuntimeError(ErrorCode.TOOL_EGRESS_BLOCKED, error.message, {
          denial: ToolDenialReason.EGRESS,
        });
      }
      if (error instanceof HttpToolError) {
        if (error.kind === 'ABORTED') throw error;
        throw new ToolRuntimeError(
          error.kind === 'TIMEOUT'
            ? ErrorCode.TOOL_TIMEOUT
            : ErrorCode.TOOL_EXECUTION_FAILED,
          error.kind === 'TIMEOUT'
            ? 'The service did not respond in time.'
            : 'The service could not be reached.',
          { retryable: true },
        );
      }
      throw error;
    }

    const metadata = {
      httpStatus: response.status,
      host: rendered.url.host,
      method: input.tool.http.method,
      responseBytes: response.body.length,
      durationMs: response.durationMs,
    };

    if (response.status >= 300 && response.status < 400) {
      throw new ToolRuntimeError(
        ErrorCode.TOOL_EXECUTION_FAILED,
        `The service answered with a redirect (HTTP ${response.status}); redirects are not followed.`,
      );
    }
    if (response.status >= 400) {
      const retryable = response.status >= 500 || response.status === 429;
      const detail =
        response.status < 500 ? ` ${decode(response.body, response.contentType, 400)}` : '';
      throw new ToolRuntimeError(
        ErrorCode.TOOL_EXECUTION_FAILED,
        `The service answered HTTP ${response.status}.${detail}`.trim(),
        { retryable },
      );
    }

    const text = decode(response.body, response.contentType, this.config.maxResultBytes);
    let data: unknown = text;
    let content = text;
    if (isJson(response.contentType)) {
      try {
        data = resolvePointer(
          JSON.parse(response.body.toString('utf8')),
          input.tool.http.responsePath,
        );
        content = JSON.stringify(data) ?? 'null';
      } catch {
        // Declared JSON that is not: pass the text through.
      }
    }

    return {
      content: response.truncated ? `${content}\n[response truncated]` : content,
      data,
      metadata: { ...metadata, truncated: response.truncated },
    };
  }

  private authHeaders(
    config: HttpToolConfig,
    secret: string | null,
  ): Record<string, string> {
    if (config.auth.type === 'none') return {};
    if (!secret) {
      throw new ToolRuntimeError(
        ErrorCode.TOOL_EXECUTION_FAILED,
        'This tool’s credential has not been configured.',
      );
    }
    switch (config.auth.type) {
      case 'bearer':
        return { authorization: `Bearer ${secret}` };
      case 'header':
        return { [config.auth.headerName.toLowerCase()]: secret };
      case 'basic':
        return {
          authorization: `Basic ${Buffer.from(`${config.auth.username}:${secret}`).toString('base64')}`,
        };
      default:
        return {};
    }
  }
}

function isJson(contentType: string | null): boolean {
  return !!contentType && /\bjson\b/i.test(contentType);
}

function isText(contentType: string | null): boolean {
  return (
    !contentType ||
    /^text\//i.test(contentType) ||
    /json|xml|javascript|x-www-form-urlencoded/i.test(contentType)
  );
}

function decode(body: Buffer, contentType: string | null, limit: number): string {
  if (!isText(contentType)) {
    return `[${body.length} bytes of ${contentType ?? 'binary'} content, not shown]`;
  }
  const text = body.toString('utf8').replaceAll('\u0000', '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
