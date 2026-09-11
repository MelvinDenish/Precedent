/**
 * Groq. Text only, and deliberately so.
 *
 * Groq's role in this system is the low-confidence rule fallback and the
 * Tutor Chat, both of which are latency-sensitive and neither of which
 * needs to see a page. Vision is Gemini's job, and a Groq vision model
 * added here would quietly become a second extraction path with its own
 * accuracy characteristics and no evaluation behind it.
 *
 * So segmentFromDocument returns `failed`, not `deferred`: an unsupported
 * capability is permanent, and a caller that retries it forever is worse
 * than one that routes the paper to Gemini or to review.
 */

import Groq from 'groq-sdk';
import { segmentationResultSchema } from '@precedent/shared';
import type { SegmentationResult } from '@precedent/shared';
import type {
  LlmProvider,
  LlmResult,
  SegmentFromDocumentRequest,
  SegmentFromTextRequest,
} from '../types.js';
import { EXTRACTION_SYSTEM_PROMPT, buildUserPrompt, extractJsonObject } from './prompt.js';

export interface GroqOptions {
  apiKey: string;
  model: string;
}

function isRetryable(message: string, status: number | null): boolean {
  if (status !== null && (status === 429 || status === 408 || status >= 500)) return true;
  return /rate.?limit|quota|over\s*capacity|unavailable|timeout/i.test(message);
}

function statusOf(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return null;
}

export class GroqProvider implements LlmProvider {
  readonly name = 'groq' as const;
  readonly supportsVision = false;

  private readonly client: Groq;
  private readonly options: GroqOptions;

  constructor(options: GroqOptions) {
    if (!options.apiKey) throw new Error('GROQ_API_KEY is empty');
    this.options = options;
    this.client = new Groq({ apiKey: options.apiKey });
  }

  async segmentFromDocument(
    req: SegmentFromDocumentRequest,
  ): Promise<LlmResult<SegmentationResult>> {
    return {
      kind: 'failed',
      provider: this.name,
      reason: `groq has no vision path; route ${req.paperId} to gemini`,
    };
  }

  async segmentFromText(req: SegmentFromTextRequest): Promise<LlmResult<SegmentationResult>> {
    let raw: string;
    try {
      const completion = await this.client.chat.completions.create({
        model: this.options.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `${buildUserPrompt(req.hints)}\n\n--- PAPER TEXT ---\n${req.text.slice(0, 60_000)}`,
          },
        ],
      });
      raw = completion.choices[0]?.message?.content ?? '';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isRetryable(message, statusOf(error))) {
        return {
          kind: 'deferred',
          provider: this.name,
          reason: message.slice(0, 300),
          retryAfterMs: 30_000,
        };
      }
      return { kind: 'failed', provider: this.name, reason: message.slice(0, 300) };
    }

    let candidate: unknown;
    try {
      candidate = extractJsonObject(raw);
    } catch (error) {
      return {
        kind: 'failed',
        provider: this.name,
        reason: `unparseable response: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const parsed = segmentationResultSchema.safeParse(candidate);
    if (!parsed.success) {
      return {
        kind: 'failed',
        provider: this.name,
        reason: `response failed segmentationResultSchema: ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      };
    }

    return { kind: 'ok', value: parsed.data, provider: this.name, model: this.options.model };
  }
}
