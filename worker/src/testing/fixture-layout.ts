/**
 * Builds RawPdfPage[] from a plain-text coordinate fixture.
 *
 * WHY THIS EXISTS. The corpus in data/ is copyrighted and gitignored, so
 * no real paper can be committed as a test fixture. But the things that
 * break segmentation are geometric -- a Marks cell typeset four points
 * above its question, a table gutter that looks like a column gutter, a
 * question number in a smaller font on its own baseline -- and none of
 * them can be expressed in a plain-text fixture.
 *
 * So fixtures carry coordinates. Each line is:
 *
 *     x | y | text
 *
 * with `@page <n> width=<w> height=<h>` starting a page and `#` starting a
 * comment. Glyph width is estimated from the character count, which is
 * enough for the space-synthesis and column-band logic to behave exactly
 * as it does on a real PDF.
 */

import type { PdfTextItem, RawPdfPage } from '../types.js';

/** Rough advance width of one character at the fixture's nominal size. */
const CHAR_WIDTH = 4.6;
const GLYPH_HEIGHT = 10;

export function parseLayoutFixture(source: string): RawPdfPage[] {
  const pages: RawPdfPage[] = [];
  let current: RawPdfPage | null = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const pageMatch = /^@page\s+(\d+)\s+width=(\d+(?:\.\d+)?)\s+height=(\d+(?:\.\d+)?)/.exec(line);
    if (pageMatch) {
      current = {
        pageNo: Number(pageMatch[1]),
        width: Number(pageMatch[2]),
        height: Number(pageMatch[3]),
        items: [],
      };
      pages.push(current);
      continue;
    }

    const cell = /^(-?\d+(?:\.\d+)?)\s*\|\s*(-?\d+(?:\.\d+)?)\s*\|\s*(.*)$/.exec(line);
    if (!cell || !current) continue;
    const text = cell[3] ?? '';
    // An explicit height suffix, "|h=7.7", models the smaller font a
    // question number is set in -- which is the thing that used to break
    // line clustering.
    const heightOverride = /\|h=(\d+(?:\.\d+)?)\s*$/.exec(text);
    const str = heightOverride ? text.slice(0, heightOverride.index) : text;
    const height = heightOverride?.[1] ? Number(heightOverride[1]) : GLYPH_HEIGHT;

    // ONE ITEM PER WORD, with x advancing across the run -- which is what a
    // real PDF emits, and therefore what the space-synthesis and
    // column-detection passes have to cope with. A fixture that emitted a
    // whole line as one item would make both of them look correct without
    // ever exercising them.
    let x = Number(cell[1]);
    for (const word of str.split(' ')) {
      if (word.length > 0) {
        current.items.push({
          str: word,
          x,
          y: Number(cell[2]),
          width: word.length * CHAR_WIDTH,
          height,
          fontName: 'fixture',
        });
      }
      x += (word.length + 1) * CHAR_WIDTH;
    }
  }

  // Content-stream order is NOT reading order in a real PDF, and a fixture
  // handed to the extractor already sorted would test nothing. Shuffling
  // deterministically by a hash of the coordinates guarantees the
  // coordinate-sort pass is what recovers the order.
  for (const page of pages) {
    page.items.sort((a, b) => hash(a) - hash(b));
  }
  return pages;
}

function hash(item: PdfTextItem): number {
  const key = `${item.x}:${item.y}:${item.str}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
