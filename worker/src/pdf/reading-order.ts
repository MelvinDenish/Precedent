/**
 * The coordinate-sort pass. Runs BEFORE any segmentation rule, because
 * pdfjs emits items in content-stream order, which is the order the
 * typesetter happened to draw them -- not the order a human reads them.
 *
 * This is not a theoretical concern for this corpus. The first page of
 * OS-R2023-Supplementary-25 emits, in item order:
 *
 *     "AU" / "CHENNAI" / "600" / "025" / "Time:" / "3" / "hrs" /
 *     "CO1" / "CO2" ... / "Q.No." / "1" / "ANNA" / "UNIVERSITY" ...
 *
 * -- the letterhead logo, then a table's first column, then the title that
 * sits above all of it. Feeding that to a regex segmenter produces garbage
 * silently, so the sort is a correctness requirement, not a tidy-up.
 */

import type { LayoutDocument, LayoutLine, LayoutPage, PdfTextItem, RawPdfPage } from '../types.js';

/**
 * Fraction of a line's mean character width that a horizontal gap must
 * exceed before a space is synthesized.
 *
 * pdfjs usually emits inter-word spaces as their own items, but not always:
 * CN-Endsem-23S5 emits "CS6111 & COMPUTER NETWORKS" as a single item while
 * OS-R2023-Supplementary-25 emits every space separately. Dropping the
 * whitespace items -- the obvious filter -- runs words together into
 * "Givethedifferencebetweenmultiprogramming", which breaks both the quality
 * gate (assessTextQuality scores common-English-word presence at 0.25 of
 * the total) and every embedding computed downstream.
 */
const SPACE_GAP_RATIO = 0.28;

/**
 * A gutter must be this wide, as a fraction of page width, to be considered
 * at all. Below it the "gap" is inter-word space that happened to line up.
 */
const MIN_GUTTER_RATIO = 0.03;

/**
 * A genuine READING column split sits near the middle of the page. This
 * band is the primary discriminator against the exam table. See
 * detectReadingColumns.
 */
const GUTTER_SEARCH_MIN = 0.3;
const GUTTER_SEARCH_MAX = 0.7;

/**
 * Each side of a reading-column split must carry at least this share of the
 * page's characters. A Marks/CO/BL strip never does.
 */
const MIN_SIDE_CHAR_SHARE = 0.3;

/**
 * Share of baselines a candidate gutter may be crossed on and still count
 * as clear. Non-zero on purpose: a two-column page almost always carries a
 * centred heading, a running head or a part header spanning both columns,
 * and demanding a perfectly clear channel would reject every real one.
 */
const MAX_GUTTER_CROSSING_SHARE = 0.15;

/**
 * Joins items already sorted left-to-right, inserting a space wherever the
 * geometry says one was drawn but no whitespace item exists.
 */
export function joinItems(items: PdfTextItem[]): string {
  if (items.length === 0) return '';
  const charCount = items.reduce((n, it) => n + it.str.length, 0);
  const totalWidth = items.reduce((w, it) => w + it.width, 0);
  const meanCharWidth = charCount > 0 ? totalWidth / charCount : 4;

  let out = items[0]?.str ?? '';
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const cur = items[i];
    if (!prev || !cur) continue;
    const gap = cur.x - (prev.x + prev.width);
    const alreadySpaced = /\s$/.test(out) || /^\s/.test(cur.str);
    if (!alreadySpaced && gap > meanCharWidth * SPACE_GAP_RATIO) out += ' ';
    out += cur.str;
  }
  return out;
}

/**
 * Groups items into baselines.
 *
 * THE TOLERANCE IS A PAGE PROPERTY, NOT AN ITEM PROPERTY. Deriving it from
 * each item's own glyph height -- the obvious approach -- fails on exactly
 * the rows that matter, because the parts of a table row are set in
 * different sizes and on slightly different baselines:
 *
 *   y=375 x=108  "Give the difference between multiprogramming ..."  h=10
 *   y=371 x=78   "1"                                                 h=7.7
 *
 * That is one row. A per-item tolerance of 0.5 * 7.7 = 3.85 misses the 4pt
 * offset by a fifth of a point, and the question number becomes its own
 * line -- which then reads as an empty question, while its text is absorbed
 * into the question above. Both failures are silent.
 *
 * The page's MEDIAN glyph height is the right scale: body line spacing in
 * these papers is 11-13pt and intra-row baseline scatter is 3-5pt, so a
 * tolerance a little over half the median separates them cleanly while
 * staying robust to a 14pt title sharing the page with 8pt cells.
 */
function clusterIntoLines(items: PdfTextItem[], pageNo: number, column: number): LayoutLine[] {
  if (items.length === 0) return [];
  const ordered = [...items].sort((a, b) => b.y - a.y || a.x - b.x);

  const heights = ordered.map((i) => i.height || 10).sort((a, b) => a - b);
  const medianHeight = heights[heights.length >> 1] ?? 10;
  const tolerance = Math.min(7, Math.max(2, medianHeight * 0.55));

  const lines: LayoutLine[] = [];
  let bucket: PdfTextItem[] = [];
  let bucketY = ordered[0]?.y ?? 0;

  const flush = (): void => {
    if (bucket.length === 0) return;
    const sorted = [...bucket].sort((a, b) => a.x - b.x);
    const text = joinItems(sorted).replace(/\s+/g, ' ').trim();
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (first && last && text.length > 0) {
      lines.push({
        pageNo,
        column,
        y: bucketY,
        xStart: first.x,
        xEnd: last.x + last.width,
        text,
        items: sorted,
      });
    }
    bucket = [];
  };

  for (const item of ordered) {
    if (bucket.length === 0) {
      bucketY = item.y;
      bucket.push(item);
    } else if (Math.abs(item.y - bucketY) <= tolerance) {
      bucket.push(item);
    } else {
      flush();
      bucketY = item.y;
      bucket.push(item);
    }
  }
  flush();
  return lines;
}

/**
 * Finds the vertical whitespace gutter that splits a page into READING
 * columns -- and, critically, refuses to split the R2023 exam table.
 *
 * The trap: that table IS multi-column. Q.No. | Questions | Marks | CO | BL
 * are separated by whitespace channels running the full height of the page,
 * geometrically indistinguishable from a two-column layout. Splitting on
 * them would emit every question number, then every question body, then
 * every marks value, as three separate reading streams, and the segmenter
 * would produce confident nonsense.
 *
 * Three conditions separate a reading gutter from a table gutter, and all
 * three must hold:
 *
 *   1. POSITION. A two-column page splits near the middle. The measured
 *      table gutters on OS-R2023-Supplementary-25 (page width 546) sit at
 *      x = 420, 455 and 495 -- 77%, 83% and 91% of the width. Searching
 *      only 30-70% rejects all three on geometry alone.
 *   2. MASS. Both sides must carry at least 30% of the page's characters.
 *      A Marks/CO/BL strip is three short tokens per row; it never does.
 *   3. WIDTH. The channel must be at least 3% of the page wide, which is
 *      what makes it a channel rather than a coincidental alignment of two
 *      paragraph edges.
 *
 * At most one split is returned. No paper in this corpus is three-column,
 * and a speculative third column is a silent-corruption risk with no upside.
 */
export function detectReadingColumns(page: RawPdfPage): number | null {
  const items = page.items.filter((i) => i.str.trim().length > 0);
  if (items.length < 40) return null; // too sparse to conclude anything

  // Occupancy is counted PER BASELINE, not over the whole page, so that a
  // single centred heading spanning both columns does not close the
  // gutter for the rest of the page. Measuring raw ink coverage instead --
  // the obvious approach -- makes any two-column page with a running head
  // or a part header look single-column.
  const rows = new Map<number, PdfTextItem[]>();
  for (const item of items) {
    const key = Math.round(item.y / 6);
    const bucket = rows.get(key);
    if (bucket) bucket.push(item);
    else rows.set(key, [item]);
  }
  const baselines = [...rows.values()];
  const maxCrossings = Math.max(1, Math.floor(baselines.length * MAX_GUTTER_CROSSING_SHARE));

  const bin = Math.max(2, page.width / 200);
  const searchFrom = Math.floor((page.width * GUTTER_SEARCH_MIN) / bin);
  const searchTo = Math.ceil((page.width * GUTTER_SEARCH_MAX) / bin);
  const minGutterBins = Math.ceil((page.width * MIN_GUTTER_RATIO) / bin);
  const totalChars = items.reduce((n, i) => n + i.str.trim().length, 0);

  const clear: boolean[] = [];
  for (let b = searchFrom; b <= searchTo; b++) {
    const x = b * bin;
    let crossings = 0;
    for (const baseline of baselines) {
      if (baseline.some((i) => i.x < x && i.x + i.width > x)) crossings += 1;
      if (crossings > maxCrossings) break;
    }
    clear[b - searchFrom] = crossings <= maxCrossings;
  }

  let best: { x: number; width: number } | null = null;
  let runStart = -1;
  for (let k = 0; k <= clear.length; k++) {
    if (clear[k] === true) {
      if (runStart < 0) runStart = k;
      continue;
    }
    if (runStart >= 0) {
      const runBins = k - runStart;
      if (runBins >= minGutterBins) {
        const centre = (searchFrom + (runStart + k) / 2) * bin;
        const leftChars = items
          .filter((i) => i.x + i.width / 2 < centre)
          .reduce((n, i) => n + i.str.trim().length, 0);
        const share = Math.min(leftChars, totalChars - leftChars) / Math.max(1, totalChars);
        if (share >= MIN_SIDE_CHAR_SHARE && (best === null || runBins * bin > best.width)) {
          best = { x: centre, width: runBins * bin };
        }
      }
      runStart = -1;
    }
  }
  return best === null ? null : best.x;
}

export function layoutPage(page: RawPdfPage): LayoutPage {
  const items = page.items.filter((i) => i.str.length > 0);
  const gutter = detectReadingColumns(page);

  if (gutter === null) {
    return {
      pageNo: page.pageNo,
      width: page.width,
      height: page.height,
      lines: clusterIntoLines(items, page.pageNo, 0),
      columnCount: 1,
      gutters: [],
    };
  }

  // An item that straddles the gutter belongs to neither column: it is a
  // centred header such as "PART - B (5 x 13 = 65 Marks)". Those are folded
  // into the left column AT THEIR OWN y rather than hoisted to the top,
  // because a part header sits between the questions above and below it and
  // moving it would reassign every question in the column.
  const spanning = new Set(items.filter((i) => i.x < gutter && i.x + i.width > gutter + 1));
  const left = items.filter((i) => !spanning.has(i) && i.x + i.width / 2 < gutter);
  const right = items.filter((i) => !spanning.has(i) && i.x + i.width / 2 >= gutter);

  const merged = [
    ...clusterIntoLines([...spanning], page.pageNo, 0),
    ...clusterIntoLines(left, page.pageNo, 0),
  ].sort((a, b) => b.y - a.y);

  return {
    pageNo: page.pageNo,
    width: page.width,
    height: page.height,
    lines: [...merged, ...clusterIntoLines(right, page.pageNo, 1)],
    columnCount: 2,
    gutters: [gutter],
  };
}

export function buildLayout(pages: RawPdfPage[]): LayoutDocument {
  const laid = pages.map(layoutPage);
  return {
    pages: laid,
    text: laid.map((p) => p.lines.map((l) => l.text).join('\n')).join('\n\n'),
    itemCount: pages.reduce((n, p) => n + p.items.length, 0),
  };
}
