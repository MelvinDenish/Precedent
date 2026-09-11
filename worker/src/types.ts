/**
 * Types local to the worker.
 *
 * shared/ is FROZEN after Phase 0, so anything this wave needs that is not
 * already in the contract is declared here and promoted during the
 * inter-wave merge. Everything below is either (a) an internal layout type
 * that never crosses a process boundary, or (b) a candidate for promotion --
 * marked PROMOTE where that applies.
 */

import type { ExamType, SegmentationResult } from '@precedent/shared';

// --- PDF layout -----------------------------------------------------
// Internal to extraction. Nothing downstream of S2 sees coordinates.

/** One pdfjs text item, flattened to the four numbers the sort actually uses. */
export interface PdfTextItem {
  str: string;
  /** PDF user space: origin bottom-left, so LARGER y is HIGHER on the page. */
  x: number;
  y: number;
  width: number;
  /** Glyph height. Drives the line-clustering tolerance, which must scale
   *  with font size or 14pt headings get merged with 8pt footnotes. */
  height: number;
  fontName: string;
}

export interface RawPdfPage {
  pageNo: number;
  width: number;
  height: number;
  items: PdfTextItem[];
}

/**
 * A run of items sharing a baseline, in left-to-right order, with spacing
 * reconstructed. `text` is what the rules match against; `items` is kept so
 * the segmenter can ask WHERE a token sat, which is how the Marks/CO/BL
 * columns are read (they are positional, not textual).
 */
export interface LayoutLine {
  pageNo: number;
  /** Reading column index. 0 for a single-column page. */
  column: number;
  y: number;
  xStart: number;
  xEnd: number;
  text: string;
  items: PdfTextItem[];
}

export interface LayoutPage {
  pageNo: number;
  width: number;
  height: number;
  /** Already in reading order: column-major when the page was split. */
  lines: LayoutLine[];
  columnCount: number;
  /** x of each detected reading-column boundary. Empty for single column. */
  gutters: number[];
}

export interface LayoutDocument {
  pages: LayoutPage[];
  /** Reading-order text. THIS is what the quality gate and the rules see. */
  text: string;
  itemCount: number;
}

// --- S1 -------------------------------------------------------------

/** PROMOTE: the S1 -> S2 handoff; S2 currently receives it in-process. */
export interface ExtractionResult {
  paperId: string;
  pageCount: number;
  /** papers.text_source. See the branch rationale in s1-extract.ts. */
  textSource: 'digital' | 'vision' | 'dirty_ocr_recovered';
  /** Null when the page had no text layer at all -- there is nothing to lay out. */
  layout: LayoutDocument | null;
  quality: { usable: boolean; score: number; reason: string };
  /** True when S2 must go through the vision provider instead of the rules. */
  needsVision: boolean;
  /** Raw bytes carried forward so the vision path does not re-fetch the blob. */
  pdfBytes: Uint8Array | null;
  warnings: string[];
}

// --- Header metadata hints ------------------------------------------

/**
 * Filename-derived guesses. A HINT ONLY, and consulted solely where the
 * header yielded nothing.
 *
 * CN-CEG-22S5-QP.pdf carries a header reading "12th September 2022,
 * CS6111, Regulation 2018" -- so the filename's subject folder (CS23502,
 * R2023) is wrong about the paper in two ways at once. And "-BT" / "-OT" /
 * "-RT" are PAPER SET letters, not dates. Trusting the filename would
 * silently file papers under the wrong regulation.
 */
export interface FilenameHints {
  college: string | null;
  paperSet: string | null;
  examType: ExamType | null;
  examYear: number | null;
}

// --- LLM provider ---------------------------------------------------

/**
 * PROMOTE: every LLM call in the system wants this shape.
 *
 * `deferred` is a VALUE, not a thrown error, because EVALUATION.md section 5
 * requires that exhausting the provider quota defers and retries the job
 * rather than failing the paper permanently. A thrown exception cannot carry
 * "retry in 47 seconds" without the caller string-matching the message.
 */
export type LlmResult<T> =
  | { kind: 'ok'; value: T; provider: string; model: string }
  | { kind: 'deferred'; provider: string; reason: string; retryAfterMs: number }
  | { kind: 'failed'; provider: string; reason: string };

export interface SegmentFromTextRequest {
  paperId: string;
  /** Reading-order text from S1. */
  text: string;
  /** Filename hint, passed through so the model can break a header tie. */
  hints?: FilenameHints;
}

export interface SegmentFromDocumentRequest {
  paperId: string;
  /**
   * The PDF itself. Gemini accepts application/pdf inline and rasterizes
   * server-side, so the vision path needs no node-canvas dependency -- which
   * matters, because node-canvas is a native build and this worker ships in
   * a slim container.
   */
  pdfBytes: Uint8Array;
  /** Whatever the failed text layer held, when there was one. Helps the
   *  model on dirty_ocr_recovered papers; absent for image-only scans. */
  dirtyText?: string;
  hints?: FilenameHints;
}

/**
 * Three implementations: gemini (vision, the PRIMARY extraction path for
 * this corpus), groq (text only -- fast, used for the low-confidence rule
 * fallback), and mock (deterministic, no network, no keys).
 */
export interface LlmProvider {
  readonly name: 'gemini' | 'groq' | 'mock';
  readonly supportsVision: boolean;
  segmentFromText(req: SegmentFromTextRequest): Promise<LlmResult<SegmentationResult>>;
  segmentFromDocument(req: SegmentFromDocumentRequest): Promise<LlmResult<SegmentationResult>>;
}
