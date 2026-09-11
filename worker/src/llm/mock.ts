/**
 * The deterministic provider. No network, no API key, no variance.
 *
 * This is not a convenience. Two independent reasons make it load-bearing:
 *
 *   - The vision path is the PRIMARY extraction path for this corpus, and
 *     a primary path that can only be exercised by spending quota against
 *     a live model has no regression suite. Every assertion about the IR
 *     contract -- that vision and rules emit the same shape, that OR pairs
 *     survive, that sub-part marks stay separate -- runs against this.
 *   - EVALUATION.md section 5 requires that exhausting the provider quota
 *     DEFERS rather than fails. `deferAfter` reproduces that wall on
 *     demand, so the degradation path is tested rather than asserted.
 *
 * LLM_PROVIDER_MODE=mock selects it for the whole pipeline.
 */

import { segmentationResultSchema } from '@precedent/shared';
import type { SegmentationResult } from '@precedent/shared';
import type {
  LlmProvider,
  LlmResult,
  SegmentFromDocumentRequest,
  SegmentFromTextRequest,
} from '../types.js';

export interface MockProviderOptions {
  /**
   * Canned results by paperId. A test that cares what comes back supplies
   * one; everything else gets the synthetic paper below.
   */
  fixtures?: Record<string, SegmentationResult>;
  /**
   * Defer every call after this many successes, imitating a free-tier
   * quota wall. 0 defers immediately.
   */
  deferAfter?: number;
  /** Reported in the deferral, so a caller can test its backoff. */
  retryAfterMs?: number;
}

/**
 * One R2023-shaped paper carrying the three cases that matter: an OR pair
 * emitted as two questions sharing an orGroupId, a sub-part split 5 + 8
 * rather than a single 13, and CO/BL on every question.
 *
 * The STRUCTURE is modelled on the real template; the WORDING is invented.
 * data/ is gitignored because the papers are copyrighted and this repo is
 * public, and a fixture that quotes them puts the text back in the repo by
 * another route -- one no test would ever catch.
 */
export const MOCK_PAPER: SegmentationResult = {
  metadata: {
    subjectCode: 'CS23501',
    subjectName: 'Operating Systems',
    regulationCode: 'R2023',
    examYear: 2025,
    examSession: 'nov-dec',
    examType: 'endsem',
    college: null,
    paperSet: null,
    semester: 5,
    totalMarks: 100,
  },
  template: {
    totalMarks: 100,
    parts: [
      { part: 'A', slotCount: 10, marksPerSlot: 2, hasChoice: false, note: '(Answer all Questions)' },
      {
        part: 'B',
        slotCount: 5,
        marksPerSlot: 13,
        hasChoice: true,
        note: '(Restrict to a maximum of 2 subdivisions)',
      },
      { part: 'C', slotCount: 1, marksPerSlot: 15, hasChoice: false, note: '(Q.No.16 is compulsory)' },
    ],
  },
  questions: [
    {
      part: 'A',
      qNumber: '1',
      partLabel: null,
      text: 'State two differences between a monolithic kernel and a microkernel.',
      marks: 2,
      orGroupId: null,
      coCode: 1,
      blLevel: 2,
      pageNo: 1,
      confidence: 0.97,
    },
    {
      part: 'B',
      qNumber: '11',
      partLabel: 'a',
      text: 'Define a thread and describe how a scheduler treats one.',
      marks: 13,
      orGroupId: 11,
      coCode: 1,
      blLevel: 2,
      pageNo: 2,
      confidence: 0.95,
    },
    {
      part: 'B',
      qNumber: '11',
      partLabel: 'b-i',
      text: 'Describe how a scheduler picks the next runnable thread.',
      marks: 5,
      orGroupId: 11,
      coCode: 1,
      blLevel: 2,
      pageNo: 2,
      confidence: 0.95,
    },
    {
      part: 'B',
      qNumber: '11',
      partLabel: 'b-ii',
      text: 'Describe the bookkeeping a kernel keeps for each open file.',
      marks: 8,
      orGroupId: 11,
      coCode: 1,
      blLevel: 2,
      pageNo: 2,
      confidence: 0.95,
    },
    {
      part: 'C',
      qNumber: '16',
      partLabel: null,
      text: 'Given a resource allocation table, decide whether the state is safe and justify it.',
      marks: 15,
      orGroupId: null,
      coCode: 3,
      blLevel: 4,
      pageNo: 4,
      confidence: 0.9,
    },
  ],
  method: 'vision',
  overallConfidence: 0.94,
  warnings: [],
};

export class MockProvider implements LlmProvider {
  readonly name = 'mock' as const;
  readonly supportsVision = true;

  private calls = 0;
  private readonly options: MockProviderOptions;

  constructor(options: MockProviderOptions = {}) {
    this.options = options;
    // Fail loudly at construction rather than mid-corpus: a fixture that
    // does not satisfy the schema would make a test pass against a shape
    // the real pipeline rejects.
    for (const [paperId, fixture] of Object.entries(options.fixtures ?? {})) {
      const parsed = segmentationResultSchema.safeParse(fixture);
      if (!parsed.success) {
        throw new Error(`mock fixture for ${paperId} is not a valid SegmentationResult`);
      }
    }
  }

  /** How many calls have been served. Lets a test assert no network churn. */
  get callCount(): number {
    return this.calls;
  }

  async segmentFromText(req: SegmentFromTextRequest): Promise<LlmResult<SegmentationResult>> {
    return this.respond(req.paperId, 'llm_fallback');
  }

  async segmentFromDocument(
    req: SegmentFromDocumentRequest,
  ): Promise<LlmResult<SegmentationResult>> {
    return this.respond(req.paperId, 'vision');
  }

  private respond(
    paperId: string,
    method: SegmentationResult['method'],
  ): LlmResult<SegmentationResult> {
    if (this.options.deferAfter !== undefined && this.calls >= this.options.deferAfter) {
      return {
        kind: 'deferred',
        provider: this.name,
        reason: 'mock quota exhausted',
        retryAfterMs: this.options.retryAfterMs ?? 60_000,
      };
    }
    this.calls += 1;
    const fixture = this.options.fixtures?.[paperId];
    const value: SegmentationResult = fixture
      ? { ...fixture, method }
      : { ...MOCK_PAPER, method, warnings: [...MOCK_PAPER.warnings, 'mock provider: synthetic paper'] };
    return { kind: 'ok', value, provider: this.name, model: 'mock-deterministic' };
  }
}
