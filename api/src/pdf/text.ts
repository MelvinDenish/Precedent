/**
 * Cheap text-layer read, for hashing only.
 *
 * This is deliberately NOT extraction. The worker's S1 stage does the real
 * job: coordinates, vision fallback for image-only scans, and an OCR quality
 * gate. All the API needs is enough text to compute a dedupe key before it
 * decides whether to enqueue anything at all, and it must do that inside a
 * request, so it reads the text layer and nothing else.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { assessTextQuality, contentHash } from '@precedent/shared';
import type { CheapText } from '../types.js';

/**
 * pdfjs warns unless it can find the standard font files. Extraction works
 * without them, but a warning per upload is noise in the logs.
 *
 * A plain filesystem path, NOT a file:// URL: the Node build reads this one
 * off disk, while a file:// URL goes through fetch, which Node does not
 * support for that scheme -- so the URL form fails to load and warns twice.
 */
function standardFontDataPath(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('pdfjs-dist/package.json');
  return join(dirname(pkg), 'standard_fonts') + '/';
}

/** %PDF-. Checked before parsing so a mislabelled upload fails fast and clearly. */
export function looksLikePdf(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes.subarray(0, 5).toString('latin1') === '%PDF-';
}

export async function extractCheapText(bytes: Buffer): Promise<CheapText> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const doc = await pdfjs.getDocument({
    // pdfjs takes ownership of the buffer it is handed and detaches it, so it
    // gets a copy: the caller still needs these bytes to store the blob.
    data: new Uint8Array(bytes),
    // Untrusted input from any student. eval and external font/image fetches
    // stay off; none of them affect the text layer.
    isEvalSupported: false,
    useWorkerFetch: false,
    useSystemFonts: false,
    standardFontDataUrl: standardFontDataPath(),
  }).promise;

  try {
    const parts: string[] = [];
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      parts.push(
        content.items.map((item) => ('str' in item ? item.str : '')).join(' '),
      );
      page.cleanup();
    }
    return { text: parts.join('\n'), pageCount: doc.numPages };
  } finally {
    await doc.destroy();
  }
}

/**
 * The dedupe key, and the single most consequential decision in the upload path.
 *
 * The design says SHA-256 of the NORMALIZED text, so that the same paper from
 * two archives collides despite differing byte-wise. That assumes the text is
 * extractable. In this corpus it usually is not: 20 of 31 papers are scans
 * with no usable text layer.
 *
 * Hashing near-empty text would give EVERY scan in a subject the same
 * content_hash, and UNIQUE (subject_id, content_hash) would then collapse all
 * 20 into a single row -- each upload after the first reported as a duplicate,
 * silently, losing most of the corpus while returning 200. That is strictly
 * worse than no dedup at all, because no error is ever raised.
 *
 * So the hash family is chosen by assessTextQuality():
 *
 *   usable text -> SHA-256 of normalized text. Final. Strong cross-archive
 *                  dedup, and papers.text_source stays 'digital'.
 *   otherwise   -> SHA-256 of the raw bytes, marked PROVISIONAL by setting
 *                  papers.text_source = 'vision' at insert time.
 *
 * A provisional hash only dedupes byte-identical re-uploads, which is weaker,
 * but it is correct-and-recoverable rather than wrong-and-silent: the worker
 * re-hashes these papers once S1 has produced real text. Cross-archive dedup
 * for scans is deferred to the worker, not abandoned. routes/upload.ts states
 * the handoff contract, including the ordering that keeps contributor credits
 * alive through a merge.
 *
 * assessTextQuality() is used rather than a local threshold so that the API
 * and the worker agree on what "usable" means. They are NOT, however, looking
 * at the same string: this sees the cheap pdfjs text layer, S1 sees its own
 * extraction. S1 can therefore find usable text where this did not, which is
 * precisely why the provisional marker is recorded at insert time instead of
 * being re-derived later.
 *
 * The prefix domain-separates the two hash families, so a byte hash can never
 * collide with a text hash.
 */
export function paperContentHash(
  bytes: Buffer,
  cheap: CheapText,
): { hash: string; provisional: boolean; reason: string } {
  const quality = assessTextQuality(cheap.text);
  if (quality.usable) {
    return { hash: contentHash(cheap.text), provisional: false, reason: 'digital text layer' };
  }
  const hash = createHash('sha256')
    .update('precedent:provisional-bytes:', 'utf8')
    .update(bytes)
    .digest('hex');
  return { hash, provisional: true, reason: quality.reason };
}
