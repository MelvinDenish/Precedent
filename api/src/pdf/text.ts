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
import { pathToFileURL } from 'node:url';
import { contentHash } from '@precedent/shared';
import type { CheapText } from '../types.js';

/**
 * pdfjs warns unless it can find the standard font files. Extraction works
 * without them, but a warning per upload is noise in the logs.
 */
function standardFontDataUrl(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('pdfjs-dist/package.json');
  return pathToFileURL(join(dirname(pkg), 'standard_fonts') + '/').href;
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
    standardFontDataUrl: standardFontDataUrl(),
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
 * Normally SHA-256 of the NORMALIZED text, so that the same paper from two
 * archives collides despite differing byte-wise.
 *
 * But most of this corpus is image-only scans -- 19 of 31 papers -- and a scan
 * has no text layer at all. Hashing the resulting empty string would give
 * EVERY scanned paper in a subject the same content_hash, and
 * UNIQUE (subject_id, content_hash) would then collapse them into a single
 * row: the second scan uploaded would be recorded as a duplicate of the first,
 * silently, and the corpus would lose most of its papers while reporting
 * success. So below the threshold the hash comes from the bytes instead.
 *
 * That is weaker -- two archives' copies of one scan will not dedupe -- but
 * wrong-and-loud beats wrong-and-silent, and it is recoverable: the worker
 * runs vision extraction on exactly these papers and can recompute the real
 * text hash afterwards. Cross-archive dedup for scans is therefore deferred to
 * the worker, not abandoned.
 *
 * The prefix domain-separates the two hash families so a byte hash can never
 * coincide with a text hash.
 */
export function paperContentHash(
  bytes: Buffer,
  cheap: CheapText,
  minTextChars: number,
): { hash: string; hasTextLayer: boolean } {
  if (cheap.text.trim().length >= minTextChars) {
    return { hash: contentHash(cheap.text), hasTextLayer: true };
  }
  const hash = createHash('sha256')
    .update('precedent:provisional-bytes:', 'utf8')
    .update(bytes)
    .digest('hex');
  return { hash, hasTextLayer: false };
}
