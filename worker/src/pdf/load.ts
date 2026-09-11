/**
 * pdfjs-dist adapter. The ONLY file that imports pdfjs, so the rest of
 * extraction is testable against synthetic coordinates with no PDF at all --
 * which is the whole reason the fixtures in tests/fixtures are .json.
 */

import type { PdfTextItem, RawPdfPage } from '../types.js';

/**
 * The legacy build is the one that runs under Node. The modern build assumes
 * browser globals (DOMMatrix, Path2D) that Node 22 still does not provide.
 */
async function pdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

export async function loadPdfPages(bytes: Uint8Array): Promise<RawPdfPage[]> {
  const lib = await pdfjs();
  const doc = await lib.getDocument({
    // pdfjs transfers and then detaches the buffer it is handed, which
    // destroys the caller's copy -- and the vision path needs those same
    // bytes afterwards. Copy defensively.
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    // Silence the font/cmap warnings these scanned papers emit by the hundred.
    verbosity: 0,
  }).promise;

  const pages: RawPdfPage[] = [];
  try {
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const raw of content.items) {
        if (!('str' in raw)) continue; // a marked-content boundary, not text
        const t = raw.transform;
        items.push({
          str: raw.str,
          x: t[4] ?? 0,
          y: t[5] ?? 0,
          width: raw.width,
          // A rotated item reports height 0; fall back to the vertical scale
          // of the text matrix so the line tolerance still has something real.
          height: raw.height || Math.abs(t[3] ?? 0) || 10,
          fontName: raw.fontName,
        });
      }
      pages.push({ pageNo, width: viewport.width, height: viewport.height, items });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}
