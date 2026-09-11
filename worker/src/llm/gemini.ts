/**
 * Gemini. THE PRIMARY EXTRACTION PATH, not a fallback.
 *
 * 19 of the 31 corpus papers are image-only scans and one more carries
 * unusable OCR, so 20 of 31 reach the corpus only through this file.
 *
 * TWO THINGS THE GATE-2 PROBE SETTLED, both of which shape the code:
 *
 *   - Gemini accepts a PDF as inline_data with mime type application/pdf
 *     and rasterises it server-side. So there is NO page-rasterising step
 *     here, and no node-canvas: a native build in a slim container, for a
 *     job the model already does.
 *   - responseMimeType 'application/json' with temperature 0 returns the
 *     SegmentationResult shape correctly -- OR groups paired, sub-part
 *     marks separate, CO/BL on 27 of 27 questions.
 *
 * Output is still validated against segmentationResultSchema before it is
 * believed. The prompt asks; the schema decides.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { segmentationResultSchema } from '@precedent/shared';
import type { SegmentationResult } from '@precedent/shared';
import type {
  LlmProvider,
  LlmResult,
  SegmentFromDocumentRequest,
  SegmentFromTextRequest,
} from '../types.js';
import { EXTRACTION_SYSTEM_PROMPT, buildUserPrompt, extractJsonObject } from './prompt.js';

export interface GeminiOptions {
  apiKey: string;
  model: string;
  visionModel: string;
}

/**
 * Quota exhaustion must DEFER, never fail: EVALUATION.md section 5
 * requires that a paper survives the provider running out. These are the
 * statuses that mean "come back later" rather than "this will never work".
 */
function isRetryable(message: string, status: number | null): boolean {
  if (status !== null && (status === 429 || status === 408 || status >= 500)) return true;
  return /resource[_\s-]?exhausted|quota|rate.?limit|overloaded|unavailable|deadline/i.test(message);
}

/**
 * Free-tier Gemini reports its own backoff in the error body. Honouring it
 * beats a fixed delay: guessing short burns the retry, guessing long
 * stalls the queue.
 */
function retryAfterFrom(message: string): number {
  const seconds = /retry(?:Delay|-after)"?[:\s]+"?(\d+)s?/i.exec(message);
  if (seconds?.[1]) return Number(seconds[1]) * 1000;
  return 60_000;
}

function statusOf(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return null;
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini' as const;
  readonly supportsVision = true;

  private readonly client: GoogleGenerativeAI;
  private readonly options: GeminiOptions;

  constructor(options: GeminiOptions) {
    if (!options.apiKey) throw new Error('GEMINI_API_KEY is empty');
    this.options = options;
    this.client = new GoogleGenerativeAI(options.apiKey);
  }

  async segmentFromText(req: SegmentFromTextRequest): Promise<LlmResult<SegmentationResult>> {
    return this.call(this.options.model, [
      { text: buildUserPrompt(req.hints) },
      { text: `--- PAPER TEXT ---\n${req.text.slice(0, 120_000)}` },
    ]);
  }

  async segmentFromDocument(
    req: SegmentFromDocumentRequest,
  ): Promise<LlmResult<SegmentationResult>> {
    return this.call(this.options.visionModel, [
      { text: buildUserPrompt(req.hints, req.dirtyText) },
      {
        inlineData: {
          mimeType: 'application/pdf',
          data: Buffer.from(req.pdfBytes).toString('base64'),
        },
      },
    ]);
  }

  private async call(
    modelName: string,
    parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[],
  ): Promise<LlmResult<SegmentationResult>> {
    const model = this.client.getGenerativeModel({
      model: modelName,
      systemInstruction: EXTRACTION_SYSTEM_PROMPT,
      generationConfig: {
        responseMimeType: 'application/json',
        // Extraction is a reading task with one right answer. Sampling
        // would make the same paper segment differently on a re-run, and
        // re-running a stage in isolation is a design goal of the queue.
        temperature: 0,
        maxOutputTokens: 32_768,
      },
    });

    let raw: string;
    try {
      const response = await model.generateContent({
        contents: [{ role: 'user', parts }],
      });
      raw = response.response.text();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isRetryable(message, statusOf(error))) {
        return {
          kind: 'deferred',
          provider: this.name,
          reason: message.slice(0, 300),
          retryAfterMs: retryAfterFrom(message),
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
      // A malformed response must fail loudly, not silently write nulls
      // into the corpus -- see the note at the top of shared/src/schemas.ts.
      return {
        kind: 'failed',
        provider: this.name,
        reason: `response failed segmentationResultSchema: ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      };
    }

    return { kind: 'ok', value: parsed.data, provider: this.name, model: modelName };
  }
}
