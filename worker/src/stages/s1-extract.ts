/**
 * S1 -- extract.
 *
 * Turns PDF bytes into reading-order text and decides which of the three
 * extraction paths the paper takes. It does NOT segment; that is S2's job,
 * and keeping them separate is what lets a paper be re-segmented after the
 * rules improve without paying to re-read the PDF.
 *
 * The routing decision is the whole point of this stage, and it is a
 * three-way branch, not the two-way one ARCHITECTURE.md originally assumed:
 *
 *   no text layer at all      -> 'vision'                (19 of 31 papers)
 *   text layer, fails gate    -> 'dirty_ocr_recovered'   (1 of 31)
 *   text layer, passes gate   -> 'digital'               (11 of 31)
 *
 * Note that the emptiness test reads the RAW item count, not
 * assessTextQuality's reason string. The gate returns
 * "text layer empty or near-empty" for anything under 200 characters, so
 * string-matching it would conflate a scan (nothing to recover, go straight
 * to vision) with a near-empty bad OCR layer (worth handing to the model as
 * a hint). They are different rows in papers.text_source and they mean
 * different things to anyone reading the corpus later.
 */

import { assessTextQuality } from '@precedent/shared';
import { loadPdfPages } from '../pdf/load.js';
import { buildLayout } from '../pdf/reading-order.js';
import type { ExtractionResult, RawPdfPage } from '../types.js';

export interface ExtractOptions {
  paperId: string;
  pdfBytes: Uint8Array;
}

/**
 * Below this many characters a text layer is treated as absent rather than
 * bad. A handful of stray glyphs from a scanner watermark is not an OCR
 * attempt worth showing the model.
 */
const EMPTY_LAYER_CHARS = 40;

export async function extract(options: ExtractOptions): Promise<ExtractionResult> {
  const pages = await loadPdfPages(options.pdfBytes);
  return extractFromPages(options.paperId, pages, options.pdfBytes);
}

/**
 * The half of S1 that has no pdfjs dependency, so it can be driven from
 * synthetic coordinate fixtures. Everything the tests exercise lives here.
 */
export function extractFromPages(
  paperId: string,
  pages: RawPdfPage[],
  pdfBytes: Uint8Array | null,
): ExtractionResult {
  const warnings: string[] = [];
  const rawChars = pages.reduce(
    (n, p) => n + p.items.reduce((m, i) => m + i.str.trim().length, 0),
    0,
  );

  if (rawChars < EMPTY_LAYER_CHARS) {
    return {
      paperId,
      pageCount: pages.length,
      textSource: 'vision',
      layout: null,
      quality: { usable: false, score: 0, reason: 'no text layer (image-only scan)' },
      needsVision: true,
      pdfBytes,
      warnings,
    };
  }

  // Coordinate sort FIRST. The quality gate scores common-word presence and
  // punctuation-run density, both of which are properties of reading-order
  // text; scoring content-stream order would measure the typesetter, not
  // the OCR.
  const layout = buildLayout(pages);
  const quality = assessTextQuality(layout.text);

  const multiColumn = layout.pages.filter((p) => p.columnCount > 1).map((p) => p.pageNo);
  if (multiColumn.length > 0) {
    warnings.push(`multi-column reading order applied on page(s) ${multiColumn.join(', ')}`);
  }

  if (!quality.usable) {
    // A non-empty layer that fails the gate is NOT discarded: it is carried
    // into the vision request as a hint. TOC-R2023-EndSem-25S5 reads
    // "Define ambiquous qrammar" -- wrong enough to poison an embedding,
    // right enough to tell a vision model what it is looking at.
    warnings.push(`text layer rejected by quality gate: ${quality.reason}`);
    return {
      paperId,
      pageCount: pages.length,
      textSource: 'dirty_ocr_recovered',
      layout,
      quality,
      needsVision: true,
      pdfBytes,
      warnings,
    };
  }

  return {
    paperId,
    pageCount: pages.length,
    textSource: 'digital',
    layout,
    quality,
    needsVision: false,
    pdfBytes,
    warnings,
  };
}
