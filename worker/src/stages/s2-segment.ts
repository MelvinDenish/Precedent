/**
 * S2 -- segment. The rule pass for the digital path.
 *
 * Emits exactly the SegmentationResult the vision path emits, so everything
 * downstream is blind to which of the two produced a paper. That contract is
 * why shared/src/segmentation.ts was frozen before either was written.
 *
 * THE SHAPE THIS PARSES, verified against the real R2023 papers:
 *
 *     PART - A (10 x 2 = 20 Marks)
 *     (Answer all Questions)
 *     Q.No. | Questions                        | Marks | CO  | BL
 *     1       Give the difference between ...      2      CO1   L2
 *     ...
 *     PART - B (5 x 13 = 65 Marks)
 *     (Restrict to a maximum of 2 subdivisions)
 *     11 (a)  What is a process? ...                13     CO1   L2
 *                              OR
 *     11 (b)  (i)  Explain the services ...          5     CO1   L2
 *             (ii) Explain the types of ...          8
 *
 * FOUR THINGS MAKE THIS HARDER THAN THE LAYOUT SUGGESTS, and each one is
 * handled explicitly below because each one fails silently otherwise:
 *
 *   1. Marks / CO / BL are POSITIONAL, not textual. They are cells in the
 *      right-hand columns and are frequently typeset a few points above the
 *      text they annotate, so they cannot be matched off the end of a line.
 *      Column x-bands are learned from the printed header row.
 *   2. Question numbers go MISSING. OS-R2023-Supplementary-25 has no "9"
 *      glyph in its text layer at all; the row is identifiable only by its
 *      orphaned marks cell. Dropping the question would lose a real exam
 *      question with no error raised.
 *   3. Sub-part labels are OCR-damaged: "(i)" arrives as "()", "(ü)" and
 *      "(üi)" in the same paper. Labels are therefore assigned by ORDINAL
 *      position and the printed glyph is only used when it is legible.
 *   4. Not every paper is R2023. The same corpus holds R2018 CS6111 papers
 *      with "PART-B (8 x 8 = 64 Marks) / (Answer any 8 questions)" and no
 *      OR anywhere, and MCQ quizzes with no PART headers at all. Nothing
 *      here keys off the part letter; everything keys off what is printed.
 */

import { segmentationResultSchema } from '@precedent/shared';
import type {
  PaperTemplate,
  PaperTemplatePart,
  SegmentationResult,
  SegmentedQuestion,
} from '@precedent/shared';
import type {
  ExtractionResult,
  FilenameHints,
  LayoutDocument,
  LayoutLine,
  LayoutPage,
  LlmProvider,
  LlmResult,
  PdfTextItem,
} from '../types.js';
import { joinItems } from '../pdf/reading-order.js';
import { parseHeaderMetadata } from './header-metadata.js';
import { normaliseQuestion, normaliseVisionResult } from './normalise-ir.js';

// --- Column geometry ------------------------------------------------

type ColumnKind = 'qno' | 'body' | 'marks' | 'co' | 'bl';

/**
 * Left edges of the right-hand table columns, learned from the printed
 * header row rather than assumed.
 *
 * Measured on OS-R2023-Supplementary-25 (page width 546):
 *   Q.No.@69  Questions@241  Marks@428  CO@474  BL@510
 * and on CN-Endsem-23S5 (page width 537), where the header is lowercase:
 *   Q.No.@73  Questions@227  Marks@404  co@440  BL@477
 *
 * Data cells sit a few points right of their header, so each boundary is
 * pulled back by a small slack rather than sitting on the header's x.
 */
interface ColumnBands {
  qnoRight: number;
  marksLeft: number;
  coLeft: number;
  blLeft: number;
}

const BAND_SLACK = 8;

/**
 * PER-PAGE column geometry. The table is NOT in the same place on every
 * page, and assuming it is silently swaps the columns.
 *
 * Measured on the four pages of OS-R2023-Supplementary-25:
 *
 *   p1  Q.No.@68  Questions@224  Marks@396  CO@437  BL@471
 *   p2  Q.No.@69  Questions@241  Marks@428  CO@474  BL@510
 *   p4  Q.No.@84  Questions@265  Marks@461  CO@508  BL@546   (landscape)
 *
 * A single document-wide band set learned from page 1 puts page 2's marks
 * cell (x=442) inside the CO band, so every question on pages 2-4 gets its
 * marks read as a course outcome and its marks recorded as null. The result
 * still validates against the schema, which is exactly what makes it
 * dangerous: CO is supervision for syllabus alignment and marks drive the
 * ROI weighting, and both would be quietly wrong.
 */
class Geometry {
  private readonly byPage = new Map<number, ColumnBands>();
  private readonly fallbackQnoRight: number;

  constructor(pages: readonly LayoutPage[], fallbackQnoRight: number) {
    this.fallbackQnoRight = fallbackQnoRight;
    for (const page of pages) {
      const bands = findColumnBands(page.lines);
      if (bands) this.byPage.set(page.pageNo, bands);
    }
  }

  get anyBands(): boolean {
    return this.byPage.size > 0;
  }

  /**
   * A page with no header row of its own inherits the nearest PRECEDING
   * page's geometry: the header is reprinted once per part, so a
   * continuation page carries the table of the page before it.
   */
  bandsFor(pageNo: number): ColumnBands | null {
    for (let p = pageNo; p >= 1; p--) {
      const found = this.byPage.get(p);
      if (found) return found;
    }
    // Before the first header row, fall back to the first one in the
    // document rather than to nothing.
    const first = [...this.byPage.keys()].sort((a, b) => a - b)[0];
    return first === undefined ? null : this.byPage.get(first) ?? null;
  }

  qnoRightFor(pageNo: number): number {
    return this.bandsFor(pageNo)?.qnoRight ?? this.fallbackQnoRight;
  }
}

function findColumnBands(lines: readonly LayoutLine[]): ColumnBands | null {
  for (const line of lines) {
    if (!isTableHeaderRow(line.text)) continue;
    let qno: PdfTextItem | undefined;
    let marks: PdfTextItem | undefined;
    let co: PdfTextItem | undefined;
    let bl: PdfTextItem | undefined;
    for (const item of line.items) {
      const s = item.str.trim();
      if (!qno && /^q\s*\.?\s*no/i.test(s)) qno = item;
      else if (!marks && /^marks?$/i.test(s)) marks = item;
      else if (!co && /^co$/i.test(s)) co = item;
      else if (!bl && /^bl$/i.test(s)) bl = item;
    }
    if (qno && marks && co && bl) {
      return {
        // "Q.No." is ~24pt wide; the number and any "(a)" sit under it.
        qnoRight: qno.x + qno.width + 14,
        marksLeft: marks.x - BAND_SLACK,
        coLeft: co.x - BAND_SLACK,
        blLeft: bl.x - BAND_SLACK,
      };
    }
  }
  return null;
}

function classify(item: PdfTextItem, line: LayoutLine, geo: Geometry): ColumnKind {
  const bands = geo.bandsFor(line.pageNo);
  if (bands) {
    if (item.x >= bands.blLeft) return 'bl';
    if (item.x >= bands.coLeft) return 'co';
    if (item.x >= bands.marksLeft) return 'marks';
  }
  return item.x <= geo.qnoRightFor(line.pageNo) ? 'qno' : 'body';
}

// --- Part headers ---------------------------------------------------

interface PartHeader {
  part: 'A' | 'B' | 'C';
  slotCount: number;
  marksPerSlot: number;
  total: number;
  /** True when the "=" was lost and the split had to be inferred. */
  recovered: boolean;
}

/**
 * Parses "PART - A (10 x 2 = 20 Marks)" and its damaged variants.
 *
 * The corpus contains "PART- C(2x816marks)" -- the "=" did not survive
 * extraction, leaving "2 x 816". Reading that literally would record a
 * 1632-mark part. The recovery is arithmetic rather than guesswork: split
 * the digit run at the one point where slots * perSlot == total. For "816"
 * with 2 slots, only 8|16 satisfies 2 * 8 == 16.
 */
export function parsePartHeader(text: string): PartHeader | null {
  if (text.length > 90) return null; // a sentence mentioning "part", not a header
  const compact = text.replace(/\s+/g, '').toUpperCase();
  const head = /^\(?PART[-–—:.]*([ABC])(?![A-Z])/.exec(compact);
  if (!head) return null;
  const part = head[1] as 'A' | 'B' | 'C';
  const rest = compact.slice(head[0].length);

  const explicit = /(\d+)[X×*](\d+)=(\d+)/.exec(rest);
  if (explicit) {
    return {
      part,
      slotCount: Number(explicit[1]),
      marksPerSlot: Number(explicit[2]),
      total: Number(explicit[3]),
      recovered: false,
    };
  }

  const lost = /(\d+)[X×*](\d+)/.exec(rest);
  if (lost) {
    const slots = Number(lost[1]);
    const digits = lost[2] ?? '';
    for (let k = 1; k < digits.length; k++) {
      const perSlot = Number(digits.slice(0, k));
      const total = Number(digits.slice(k));
      if (perSlot > 0 && total > 0 && slots * perSlot === total) {
        return { part, slotCount: slots, marksPerSlot: perSlot, total, recovered: true };
      }
    }
    const perSlot = Number(digits);
    return { part, slotCount: slots, marksPerSlot: perSlot, total: slots * perSlot, recovered: true };
  }

  // Header present but the arithmetic is unreadable. Still worth recording:
  // knowing a PART-B exists is what assigns questions to it.
  return { part, slotCount: 0, marksPerSlot: 0, total: 0, recovered: true };
}

/**
 * The literal centred "OR" between the two alternatives of a PART-B
 * question. THE single most load-bearing token in this file: it is what
 * makes 11(a) and 11(b) OR-siblings, and per docs/ARCHITECTURE.md 2.3
 * getting or_group wrong deflates or inflates every recurrence count in the
 * product with no error raised anywhere.
 *
 * The centring test is not decoration. Without it, a body line reading
 * "OR" -- or an OCR fragment -- would silently pair two unrelated questions.
 */
function isOrMarker(line: LayoutLine, pageWidth: number): boolean {
  if (!/^o\s*\.?\s*r\.?$/i.test(line.text)) return false;
  return line.xStart > pageWidth * 0.2;
}

/**
 * The parenthesised instruction under a part header: "(Answer all
 * Questions)", "(Restrict to a maximum of 2 subdivisions)".
 *
 * It must not match a sub-part line. "(i) Explain ..." also starts with a
 * parenthesis, and a paper whose PART-B opens directly on "11 (a) (i)"
 * would lose that sub-part into the template note.
 */
function isPartNote(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 90 || !trimmed.startsWith('(') || !trimmed.includes(')')) return false;
  return !SUBPART_START.test(trimmed);
}

function isTableHeaderRow(text: string): boolean {
  return /q\s*\.?\s*no\.?/i.test(text) && /marks/i.test(text);
}

function isPageFurniture(text: string): boolean {
  return (
    /^page\s*\d+\s*(of|\/)\s*\d+$/i.test(text) ||
    /^roll\s*\.?\s*no\.?[\s._]*$/i.test(text) ||
    text.replace(/[^A-Za-z0-9]/g, '').length === 0
  );
}

// --- Blocks ---------------------------------------------------------

interface Block {
  part: 'A' | 'B' | 'C' | null;
  qNumber: string;
  topLabel: string | null;
  pageNo: number;
  pageWidth: number;
  lines: LayoutLine[];
  numberInterpolated: boolean;
}

/**
 * A question number, optionally followed by its TOP-LEVEL alternative
 * label. The label is restricted to a single letter a-d on purpose: the
 * R2023 template offers "(a) OR (b)" at the top level and "(i) / (ii)"
 * beneath it, so letting a roman numeral bind here turns PART-C's
 * "16. (i) ... (ii) ..." into one question labelled "i-ii" instead of two
 * sub-parts, and loses one of the two.
 */
const QUESTION_START = /^\(?\s*(\d{1,2})\s*[.)]?\s*(?:\(\s*([a-dA-D])\s*\))?\s*/;
const SUBPART_START = /^\(\s*([^)\s]{0,4})\s*\)\s*/;
const ROMAN_BY_ORDINAL = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii'];

/**
 * Removes a question's own number and sub-part label from the front of its
 * text -- and ONLY its own.
 *
 * The guard matters for a row recovered by splitOrphanedRows: that row has
 * no number glyph, so its body text starts at the question itself. An
 * unguarded strip of "any leading one or two digits" turns
 * "1000 bytes are sent over a link..." into "00 bytes are sent...",
 * silently, on exactly the rows already flagged as low confidence.
 */
function stripLeadingNumber(text: string, qNumber: string): string {
  const m = QUESTION_START.exec(text);
  if (!m || m[1] !== qNumber) return text;
  return text.slice(m[0].length);
}

function itemsOfKind(
  line: LayoutLine,
  geo: Geometry,
  kinds: readonly ColumnKind[],
): PdfTextItem[] {
  return line.items.filter((i) => kinds.includes(classify(i, line, geo)));
}

function lineBodyText(line: LayoutLine, geo: Geometry): string {
  return joinItems(itemsOfKind(line, geo, ['qno', 'body']))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * First integer found in a right-hand cell: "CO3" -> 3, "C04" -> 4 (the OCR
 * of CO4), "L2" -> 2.
 *
 * `max` is not cosmetic. These cells sit at the page edge where scanner
 * speckle and page numbers land, and an out-of-range value would fail
 * segmentedQuestionSchema and reject the WHOLE paper -- so a 7 read out of
 * a BL column becomes null (a gap the review UI can fill) rather than a
 * validation error that loses 26 good questions with it.
 */
function cellNumber(items: readonly PdfTextItem[], max: number): number | null {
  for (const item of items) {
    const m = /(\d{1,3})/.exec(item.str);
    if (!m?.[1]) continue;
    const value = Number(m[1]);
    if (value >= 1 && value <= max) return value;
  }
  return null;
}

/** Course outcomes run CO1..CO6 here; the schema allows up to 12. */
const MAX_CO = 12;
/** Bloom's taxonomy is L1..L6 and the schema enforces it. */
const MAX_BL = 6;
/** Marks on a single question never exceed the paper's part total. */
const MAX_MARKS = 100;

// --- The main pass --------------------------------------------------

export interface SegmentInput {
  paperId: string;
  layout: LayoutDocument;
  hints?: FilenameHints;
}

interface PartAccumulator extends PartHeader {
  note: string | null;
  orMarkers: number;
}

/**
 * The pure rule segmenter. No I/O, no provider, no PDF -- it consumes a
 * LayoutDocument, which is why every case in the test suite can be a
 * synthetic coordinate fixture rather than a copyrighted paper.
 */
export function segmentRules(input: SegmentInput): SegmentationResult {
  const warnings: string[] = [];
  const allLines = input.layout.pages.flatMap((p) => p.lines);
  const xStartsAll = allLines.map((l) => l.xStart).sort((a, b) => a - b);
  const bodyLeftGuess = xStartsAll[Math.floor(xStartsAll.length * 0.1)] ?? 0;
  const geo = new Geometry(input.layout.pages, bodyLeftGuess + 26);
  if (!geo.anyBands) {
    warnings.push('no Q.No./Marks/CO/BL header row found; marks read from text, not columns');
  }

  // Fallback Q.No. boundary for papers with no table header: the left
  // margin plus the width of a two-digit number and a "(a)".
  const parts: PartAccumulator[] = [];
  const blocks: Block[] = [];
  const headerLines: LayoutLine[] = [];
  /** Index into `blocks` that each OR marker precedes. */
  const orMarkerAt: number[] = [];

  let currentPart: PartAccumulator | null = null;
  let lastNumber = 0;
  let justSawPartHeader = false;
  let sawAnyQuestion = false;

  for (const page of input.layout.pages) {
    for (const line of page.lines) {
      const text = line.text;
      if (isPageFurniture(text)) continue;

      const partHeader = parsePartHeader(text);
      if (partHeader) {
        currentPart = { ...partHeader, note: null, orMarkers: 0 };
        parts.push(currentPart);
        justSawPartHeader = true;
        if (partHeader.recovered) {
          warnings.push(
            `PART-${partHeader.part} counts recovered from a damaged header ` +
              `("${text}") as ${partHeader.slotCount} x ${partHeader.marksPerSlot} = ${partHeader.total}`,
          );
        }
        continue;
      }

      if (justSawPartHeader && currentPart && isPartNote(text)) {
        currentPart.note = text;
        justSawPartHeader = false;
        continue;
      }
      justSawPartHeader = false;

      if (isTableHeaderRow(text)) continue;

      if (isOrMarker(line, page.width)) {
        orMarkerAt.push(blocks.length);
        if (currentPart) currentPart.orMarkers += 1;
        continue;
      }

      const start = matchQuestionStart(line, geo, lastNumber);
      if (start) {
        blocks.push({
          part: currentPart?.part ?? null,
          qNumber: String(start.number),
          topLabel: start.label,
          pageNo: line.pageNo,
          pageWidth: page.width,
          lines: [line],
          numberInterpolated: false,
        });
        lastNumber = start.number;
        sawAnyQuestion = true;
        continue;
      }

      const open = blocks[blocks.length - 1];
      if (open) open.lines.push(line);
      else if (!sawAnyQuestion) headerLines.push(line);
    }
  }

  // Rows that lost their number glyph entirely. See note 2 in the module
  // comment: the only surviving evidence is an orphaned marks cell.
  const rows = blocks.flatMap((b) => splitOrphanedRows(b, geo, warnings));

  const confirmedOr = new Set<string>();
  for (const index of orMarkerAt) {
    const before = blocks[index - 1];
    const after = blocks[index];
    if (before && after && before.qNumber === after.qNumber) confirmedOr.add(before.qNumber);
  }

  const questions = buildQuestions(rows, parts, confirmedOr, geo, warnings);

  const template = buildTemplate(parts, confirmedOr.size > 0);
  const headerText = headerLines.map((l) => l.text).join('\n');
  const header = parseHeaderMetadata(headerText, input.hints, template?.totalMarks ?? null);
  warnings.push(...header.warnings);

  const overallConfidence = scorePaper(questions, template, warnings);

  return {
    metadata: header.metadata,
    template,
    questions,
    method: 'rules',
    overallConfidence,
    warnings,
  };
}

function matchQuestionStart(
  line: LayoutLine,
  geo: Geometry,
  lastNumber: number,
): { number: number; label: string | null } | null {
  // A question number sits in the Q.No. column. Without this check every
  // line beginning with a figure ("1,024 words each") becomes a question.
  if (line.xStart > geo.qnoRightFor(line.pageNo) + 6) return null;
  const m = QUESTION_START.exec(line.text);
  if (!m?.[1]) return null;
  const number = Number(m[1]);
  if (!Number.isInteger(number) || number < 1 || number > 40) return null;

  const label = m[2] ? m[2].toLowerCase() : null;
  // A repeat of the current number is the (b) of an OR pair, so it must
  // carry a label; a bare repeat is a stray figure.
  if (number === lastNumber) return label ? { number, label } : null;
  if (number <= lastNumber) return null;

  // HOW FAR THE NUMBER MAY JUMP depends on how much corroboration the line
  // carries. A row printing a full Marks/CO/BL triple is a table row, full
  // stop, so its number is trusted however far it has jumped -- which is
  // what CN-Endsem-23S5 needs, having lost the glyphs for nine of its ten
  // PART-A numbers. Without that allowance `lastNumber` stalls at 8, every
  // later number is rejected as implausible, and the entire rest of the
  // paper collapses into one question.
  const triple =
    itemsOfKind(line, geo, ['marks']).length > 0 &&
    itemsOfKind(line, geo, ['co']).length > 0 &&
    itemsOfKind(line, geo, ['bl']).length > 0;
  const window = triple ? 12 : 3;
  if (number > lastNumber + window) return null;
  return { number, label };
}

/**
 * Splits a block that swallowed a question whose number glyph is absent.
 *
 * Question numbers really do go missing. OS-R2023-Supplementary-25 has no
 * "3" and no "9" anywhere in its text layer, yet both questions are on the
 * paper and both carry marks. Absorbed into their predecessors they would
 * vanish from the corpus with no error raised -- and PART-A would then hold
 * 8 questions against a template declaring 10, which is a statistic nobody
 * checks until the recurrence counts are already wrong.
 *
 * WHAT IDENTIFIES A NEW ROW: a complete Marks + CO + BL triple, after the
 * block already has one. The paper prints that triple exactly once per
 * question, and nothing weaker survives the counter-examples:
 *
 *   - "marks cell present" fires on 13(a), whose A/B/C/D sub-items each
 *     carry their own 4-mark cell under one question number.
 *   - "a line of cells with no text" fires on 13(b), whose BL cell is
 *     typeset on its own baseline, and misses question 9 entirely, whose
 *     cells share a baseline with their question text.
 *
 * The recovered number is interpolated from the sequence and the row is
 * flagged: a low-confidence question goes to the review queue, whereas a
 * dropped one is simply gone.
 */
function splitOrphanedRows(
  block: Block,
  geo: Geometry,
  warnings: string[],
): Block[] {
  if (!geo.anyBands) return [block];
  // Only an unlabelled, numbered row can lose its number. A PART-B block
  // already identified as 11(a) or 14(b) never renumbers -- its inner
  // sub-parts legitimately carry several Marks/CO/BL triples.
  if (block.topLabel !== null) return [block];
  const out: Block[] = [];
  let current: Block = { ...block, lines: [] };
  let seenTriple = false;

  for (const line of block.lines) {
    const isTriple =
      itemsOfKind(line, geo, ['marks']).length > 0 &&
      itemsOfKind(line, geo, ['co']).length > 0 &&
      itemsOfKind(line, geo, ['bl']).length > 0;

    // A sub-part opens a new leaf of the SAME question, never a new
    // question, so it must never trigger a renumber.
    const opensSubPart = SUBPART_START.test(lineBodyText(line, geo));

    if (isTriple && seenTriple && !opensSubPart && current.lines.length > 0) {
      out.push(current);
      const nextNumber = Number(current.qNumber) + 1;
      warnings.push(
        `question ${nextNumber} has no number glyph in the text layer; ` +
          'recovered from its Marks/CO/BL cells and renumbered by sequence',
      );
      current = {
        ...block,
        qNumber: String(nextNumber),
        topLabel: null,
        lines: [],
        numberInterpolated: true,
      };
      seenTriple = false;
    }
    if (isTriple) seenTriple = true;
    current.lines.push(line);
  }
  out.push(current);
  return out;
}

interface Leaf {
  partLabel: string | null;
  lines: LayoutLine[];
  ocrLabel: boolean;
}

/**
 * Splits one question block into its answerable leaves.
 *
 * Only LEAVES are emitted, never the parent as well: emitting 11(b) and
 * 11(b)(i) and 11(b)(ii) would count the same 13 marks twice and break
 * every marks-weighted statistic downstream.
 *
 * A shared stem before the first sub-part -- the process table in 13(a),
 * for instance -- is prepended to every leaf rather than attached to the
 * first. Each sub-part is unanswerable without it, and the text field is
 * what gets embedded.
 */
function splitLeaves(
  block: Block,
  geo: Geometry,
): { leaves: Leaf[]; stem: LayoutLine[] } {
  const starts: number[] = [];
  const labels: (string | null)[] = [];

  block.lines.forEach((line, index) => {
    const body = lineBodyText(line, geo);
    // On the block's first line the sub-part label follows the question
    // number, so strip that prefix before looking for it.
    const after = index === 0 ? body.replace(QUESTION_START, '') : body;
    const m = SUBPART_START.exec(after);
    if (!m) return;
    const raw = (m[1] ?? '').toLowerCase();
    starts.push(index);
    labels.push(/^[ivx]{1,4}$/.test(raw) || /^[a-d]$/.test(raw) ? raw : null);
  });

  if (starts.length === 0) {
    return { leaves: [{ partLabel: block.topLabel, lines: block.lines, ocrLabel: false }], stem: [] };
  }

  const firstStart = starts[0] ?? 0;
  let stem = block.lines.slice(0, firstStart);
  const leaves: Leaf[] = [];

  // OCR damage makes "(i)" arrive as "()", "(ü)" and "(üi)" within a single
  // paper, so a block can hold one legible label and one illegible one. If
  // trusting the legible glyphs would produce a COLLISION -- 14(a) prints
  // "()" then "(i)", which would yield a-i twice and drop a sub-part on the
  // UNIQUE (paper, q_number, part_label) constraint -- fall back to pure
  // ordinal numbering for the whole block.
  const resolved = labels.map((printed, k) => printed ?? ROMAN_BY_ORDINAL[k] ?? String(k + 1));
  const collides = new Set(resolved).size !== resolved.length;

  // When the sub-parts are SIBLING letters, the lines before the first of
  // them are not a shared preamble -- they are the topLabel's own content.
  // CN-Endsem-23S5 prints "11 (a) <text>" then "(b) <text>"; treating the
  // (a) text as a preamble to (b) both loses question (a) entirely and
  // corrupts (b) with (a)'s wording.
  const siblingSplit =
    block.topLabel !== null && resolved.some((l) => /^[a-d]$/.test(l) && l !== block.topLabel);
  if (siblingSplit && stem.length > 0) {
    leaves.push({ partLabel: block.topLabel, lines: stem, ocrLabel: false });
    stem = [];
  }

  for (let k = 0; k < starts.length; k++) {
    const from = starts[k] ?? 0;
    const to = starts[k + 1] ?? block.lines.length;
    const printed = labels[k] ?? null;
    const inner = collides ? ROMAN_BY_ORDINAL[k] ?? String(k + 1) : resolved[k] ?? String(k + 1);
    // A LETTER label is a SIBLING alternative, a ROMAN one is nested.
    //
    // CN-Endsem-23S5 prints "11 (a) ..." and then a bare "(b) ..." with no
    // repeated number, so (b) is 11's second half at the SAME level -- it
    // must come out as partLabel "b", not "a-b", or it collides with
    // nothing and reads as a sub-part of (a) that does not exist. R2023's
    // "11 (b) (i) / (ii)" nests roman numerals under the letter, and those
    // do join.
    const siblingLetter = /^[a-d]$/.test(inner) && inner !== block.topLabel;
    const partLabel =
      block.topLabel === null || siblingLetter || inner === block.topLabel
        ? inner
        : `${block.topLabel}-${inner}`;
    leaves.push({
      partLabel,
      lines: block.lines.slice(from, to),
      ocrLabel: printed === null || collides,
    });
  }
  return { leaves, stem };
}

function buildQuestions(
  blocks: readonly Block[],
  parts: readonly PartAccumulator[],
  confirmedOr: ReadonlySet<string>,
  geo: Geometry,
  warnings: string[],
): SegmentedQuestion[] {
  const paperPrintsCo = blocks.some((b) =>
    b.lines.some((l) => itemsOfKind(l, geo, ['co']).length > 0),
  );
  const paperPrintsBl = blocks.some((b) =>
    b.lines.some((l) => itemsOfKind(l, geo, ['bl']).length > 0),
  );
  const paperHasParts = parts.length > 0;

  // A question number carrying two top-level labels inside a part that
  // offers choice is an OR pair even when the "OR" glyph was lost.
  const labelsByNumber = new Map<string, Set<string>>();
  for (const block of blocks) {
    if (!block.topLabel) continue;
    const set = labelsByNumber.get(block.qNumber) ?? new Set<string>();
    set.add(block.topLabel);
    labelsByNumber.set(block.qNumber, set);
  }

  const out: SegmentedQuestion[] = [];

  for (const block of blocks) {
    const part = parts.find((p) => p.part === block.part) ?? null;
    const { leaves, stem } = splitLeaves(block, geo);
    const stemText = stem
      .map((l, i) =>
        i === 0 ? stripLeadingNumber(lineBodyText(l, geo), block.qNumber) : lineBodyText(l, geo),
      )
      .join(' ')
      .trim();

    // Block-level CO/BL, inherited by any leaf that has none of its own:
    // the paper prints them once per question, against the first sub-part.
    const blockCo = cellNumber(
      block.lines.flatMap((l) => itemsOfKind(l, geo, ['co'])),
      MAX_CO,
    );
    const blockBl = cellNumber(
      block.lines.flatMap((l) => itemsOfKind(l, geo, ['bl'])),
      MAX_BL,
    );

    const leafMarks = leaves.map((leaf) =>
      cellNumber(leaf.lines.flatMap((l) => itemsOfKind(l, geo, ['marks'])), MAX_MARKS),
    );
    resolveMissingMarks(leafMarks, leaves, part, geo.anyBands);

    let orGroupId: number | null = null;
    let orInferred = false;
    if (confirmedOr.has(block.qNumber)) {
      orGroupId = Number(block.qNumber);
    } else if (
      // ONLY a part that printed at least one OR marker may have a pair
      // inferred. "Answer any 8 questions" is deliberately NOT evidence:
      // that is a choice BETWEEN questions, which the template records as
      // hasChoice, whereas orGroupId means "these two are alternatives to
      // each other". CN-Endsem-23S5 says "Answer any 8" and prints
      // "11 (a) (4 marks)" and "(b) (4 marks)" -- both are answered, and
      // pairing them would block every legitimate cross-year merge those
      // two questions should take part in, deflating the counts silently.
      part !== null &&
      part.orMarkers > 0 &&
      (labelsByNumber.get(block.qNumber)?.size ?? 0) >= 2
    ) {
      orGroupId = Number(block.qNumber);
      orInferred = true;
      warnings.push(
        `question ${block.qNumber} paired as an OR group from its (a)/(b) siblings; ` +
          'no OR marker was found between them',
      );
    }

    leaves.forEach((leaf, index) => {
      const leafCo =
        cellNumber(leaf.lines.flatMap((l) => itemsOfKind(l, geo, ['co'])), MAX_CO) ??
        blockCo;
      const leafBl =
        cellNumber(leaf.lines.flatMap((l) => itemsOfKind(l, geo, ['bl'])), MAX_BL) ??
        blockBl;
      let text = leaf.lines
        .map((line, i) => {
          const body = lineBodyText(line, geo);
          const stripped =
            i === 0 || line === block.lines[0] ? stripLeadingNumber(body, block.qNumber) : body;
          return i === 0 ? stripped.replace(SUBPART_START, '') : stripped;
        })
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (stemText) text = `${stemText} ${text}`.trim();

      const { text: cleanText, marks: textualMarks } = stripTrailingMarks(text);
      const marks = leafMarks[index] ?? textualMarks ?? null;
      if (!cleanText) return; // nothing answerable here; the schema rejects ''

      const question: SegmentedQuestion = {
        part: block.part,
        qNumber: block.qNumber,
        partLabel: leaf.partLabel,
        text: cleanText,
        marks,
        orGroupId,
        coCode: leafCo,
        blLevel: leafBl,
        pageNo: block.pageNo,
        confidence: scoreQuestion({
          marks,
          text: cleanText,
          part: block.part,
          coCode: null,
          interpolated: block.numberInterpolated,
          ocrLabel: leaf.ocrLabel,
          orInferred,
          paperPrintsCo,
          paperPrintsBl,
          paperHasParts,
          hasCo: leafCo !== null,
          hasBl: leafBl !== null,
        }),
      };

      // Both paths go through the same normaliser, so the digital and
      // vision outputs cannot drift apart in label shape -- and PART-A/C
      // get their orGroupId cleared in exactly one place.
      out.push(normaliseQuestion(question));
    });
  }

  return out;
}

/**
 * Fills marks the paper did not print against a question.
 *
 * Two cases, in order of how much they are actually worth trusting:
 *   - an undivided question in a part whose header states marks-per-slot
 *     (all of PART-A, and every R2018 paper, which prints no marks column);
 *   - one unmarked sub-part among marked siblings, where the part total
 *     pins it by subtraction (13 = 5 + 8).
 */
function resolveMissingMarks(
  marks: (number | null)[],
  leaves: readonly Leaf[],
  part: PartAccumulator | null,
  hasBands: boolean,
): void {
  if (!part || part.marksPerSlot <= 0) return;

  if (leaves.length === 1 && marks[0] === null) {
    marks[0] = part.marksPerSlot;
    return;
  }

  const missing = marks.map((m, i) => (m === null ? i : -1)).filter((i) => i >= 0);
  if (missing.length === 1) {
    const known = marks.reduce<number>((sum, m) => sum + (m ?? 0), 0);
    const remainder = part.marksPerSlot - known;
    const slot = missing[0];
    if (slot !== undefined && remainder > 0) marks[slot] = remainder;
    return;
  }

  // With no marks column at all, an undivided part slot is the best
  // available estimate; anything finer would be invention.
  if (!hasBands && missing.length === marks.length && marks.length === 1) marks[0] = part.marksPerSlot;
}

/**
 * Recovers marks written into the text itself, which is how the R2018
 * papers annotate them: "Show the TCP state transition diagram ... (5)".
 * The annotation is removed from the text so it never reaches an embedding.
 */
export function stripTrailingMarks(text: string): { text: string; marks: number | null } {
  const m = /[([](\d{1,2})\s*(?:marks?|m)?[)\]]\s*$/i.exec(text);
  if (!m?.[1]) return { text, marks: null };
  const marks = Number(m[1]);
  if (marks < 1 || marks > 100) return { text, marks: null };
  return { text: text.slice(0, m.index).trim(), marks };
}

// --- Template and confidence ----------------------------------------

/**
 * The recovered exam structure. The Night Before optimizer consumes this as
 * a HARD CONSTRAINT: the paper forces an answer from every unit, so taking
 * the globally top-N concepts fails a student whose top concepts all sit in
 * one unit.
 */
function buildTemplate(parts: readonly PartAccumulator[], anyOr: boolean): PaperTemplate | null {
  if (parts.length === 0) return null;
  const templateParts: PaperTemplatePart[] = parts.map((p) => ({
    part: p.part,
    slotCount: Math.max(1, p.slotCount),
    marksPerSlot: Math.max(1, p.marksPerSlot),
    // Choice is read off the paper, never off the part letter. PART-B in
    // CN-Endsem-20S5 is "8 x 8, answer any 8" with no OR at all, and a
    // hardcoded "B means OR" would invent pairs that do not exist.
    hasChoice: p.orMarkers > 0 || /answer\s*any/i.test(p.note ?? ''),
    note: p.note,
  }));
  void anyOr;
  return {
    totalMarks: templateParts.reduce((sum, p) => sum + p.slotCount * p.marksPerSlot, 0),
    parts: templateParts,
  };
}

interface QuestionScoreInput {
  marks: number | null;
  text: string;
  part: 'A' | 'B' | 'C' | null;
  coCode: number | null;
  interpolated: boolean;
  ocrLabel: boolean;
  orInferred: boolean;
  paperPrintsCo: boolean;
  paperPrintsBl: boolean;
  paperHasParts: boolean;
  hasCo: boolean;
  hasBl: boolean;
}

/**
 * Per-question self-assessment. Feeds the segmentation review queue, so the
 * penalties are sized by how much damage the defect does downstream rather
 * than by how wrong it looks: a missing marks value corrupts the mark bands
 * that drive answer depth and ROI, while a missing BL level is metadata.
 */
function scoreQuestion(input: QuestionScoreInput): number {
  let score = 1;
  if (input.marks === null) score -= 0.25;
  if (input.text.length < 15) score -= 0.2;
  if (input.interpolated) score -= 0.15;
  if (input.orInferred) score -= 0.1;
  if (input.ocrLabel) score -= 0.05;
  if (input.paperHasParts && input.part === null) score -= 0.1;
  if (input.paperPrintsCo && !input.hasCo) score -= 0.05;
  if (input.paperPrintsBl && !input.hasBl) score -= 0.05;
  return Math.min(1, Math.max(0, Number(score.toFixed(3))));
}

function scorePaper(
  questions: readonly SegmentedQuestion[],
  template: PaperTemplate | null,
  warnings: string[],
): number {
  if (questions.length === 0) return 0;
  const mean = questions.reduce((sum, q) => sum + q.confidence, 0) / questions.length;
  if (!template) return Number(mean.toFixed(3));

  // A paper whose recovered question count is far from its own template has
  // lost or invented rows, whatever the per-question scores say.
  const expected = template.parts.reduce((sum, p) => sum + p.slotCount, 0);
  const found = new Set(questions.map((q) => `${q.part}:${q.qNumber}`)).size;
  const ratio = expected > 0 ? found / expected : 1;
  if (ratio < 0.8 || ratio > 1.6) {
    warnings.push(`recovered ${found} question numbers against a template expecting ${expected}`);
    return Number(Math.max(0, mean - 0.2).toFixed(3));
  }
  return Number(mean.toFixed(3));
}

// --- Stage entry point ----------------------------------------------

export interface SegmentOptions {
  provider?: LlmProvider;
  hints?: FilenameHints;
  /** Below this, the rule output is handed to the LLM for a second opinion. */
  minConfidence?: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.6;

/**
 * S2 proper: rules first, then a single structured LLM call when the rules
 * are not confident. ARCHITECTURE.md 2.2 -- rules cover the majority of
 * clean PDFs, and the model is a fallback rather than the default, because
 * the model costs quota and cannot be unit-tested.
 *
 * A deferred provider is NOT an error. The rule result stands, carrying a
 * warning, and the paper remains correctable through the review UI.
 */
export async function segment(
  input: SegmentInput,
  options: SegmentOptions = {},
): Promise<SegmentationResult> {
  const ruled = segmentRules(input);
  const threshold = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  if (!options.provider || ruled.overallConfidence >= threshold) return ruled;

  const outcome = await options.provider.segmentFromText({
    paperId: input.paperId,
    text: input.layout.text,
    ...(input.hints ? { hints: input.hints } : {}),
  });

  if (outcome.kind !== 'ok') {
    return {
      ...ruled,
      warnings: [
        ...ruled.warnings,
        `rule confidence ${ruled.overallConfidence} below ${threshold}; ` +
          `LLM fallback ${outcome.kind} (${outcome.reason})`,
      ],
    };
  }

  const parsed = segmentationResultSchema.safeParse(outcome.value);
  if (!parsed.success) {
    return {
      ...ruled,
      warnings: [...ruled.warnings, `LLM fallback returned invalid IR: ${parsed.error.message}`],
    };
  }

  // Only take the model's answer if it is actually more confident. A model
  // that is equally unsure adds nothing and costs a review-queue entry.
  if (parsed.data.overallConfidence <= ruled.overallConfidence) {
    return {
      ...ruled,
      warnings: [...ruled.warnings, 'LLM fallback was no more confident than the rules; rules kept'],
    };
  }

  return {
    ...parsed.data,
    method: 'llm_fallback',
    warnings: [
      ...parsed.data.warnings,
      `rule pass scored ${ruled.overallConfidence}; replaced by the LLM fallback`,
    ],
  };
}

/**
 * S2 for a paper S1 routed to vision. This is the path 20 of the 31 corpus
 * papers take, so "fallback" would be the wrong word for it.
 *
 * The raw model output goes through normaliseVisionResult before it is
 * returned, which is what keeps the two paths emitting the SAME IR: the
 * model returns qNumber "11(a)" with partLabel "(a)", the university's own
 * name in `college`, and regulationCode "2023" -- none of which join to
 * anything. The rule path emits the normalised form directly.
 *
 * A deferral is returned as a deferral. The caller re-queues the job; the
 * paper is not marked failed.
 */
export async function segmentWithVision(
  extraction: ExtractionResult,
  provider: LlmProvider,
  hints?: FilenameHints,
): Promise<LlmResult<SegmentationResult>> {
  if (!extraction.pdfBytes) {
    return { kind: 'failed', provider: provider.name, reason: 'no PDF bytes to send' };
  }
  if (!provider.supportsVision) {
    return {
      kind: 'failed',
      provider: provider.name,
      reason: `${provider.name} cannot read a document; configure a vision provider`,
    };
  }

  const outcome = await provider.segmentFromDocument({
    paperId: extraction.paperId,
    pdfBytes: extraction.pdfBytes,
    // A text layer that failed the quality gate is still a hint about what
    // the page says -- "Define ambiquous qrammar" is wrong enough to
    // poison an embedding and right enough to orient a vision model.
    ...(extraction.textSource === 'dirty_ocr_recovered' && extraction.layout
      ? { dirtyText: extraction.layout.text }
      : {}),
    ...(hints ? { hints } : {}),
  });

  if (outcome.kind !== 'ok') return outcome;

  const normalised = normaliseVisionResult(outcome.value);
  return {
    ...outcome,
    value: {
      ...normalised,
      warnings: [...normalised.warnings, ...extraction.warnings],
    },
  };
}

/**
 * The stage entry point. Routes on what S1 decided, so nothing above this
 * needs to know that most of this corpus is scanned paper.
 */
export async function runSegmentation(
  extraction: ExtractionResult,
  options: SegmentOptions & { visionProvider?: LlmProvider } = {},
): Promise<LlmResult<SegmentationResult>> {
  if (extraction.needsVision) {
    if (!options.visionProvider) {
      return {
        kind: 'deferred',
        provider: 'none',
        reason: `${extraction.paperId} needs vision and no vision provider is configured`,
        retryAfterMs: 300_000,
      };
    }
    return segmentWithVision(extraction, options.visionProvider, options.hints);
  }

  if (!extraction.layout) {
    return { kind: 'failed', provider: 'rules', reason: 'digital path with no layout' };
  }

  const result = await segment(
    {
      paperId: extraction.paperId,
      layout: extraction.layout,
      ...(options.hints ? { hints: options.hints } : {}),
    },
    options,
  );
  return {
    kind: 'ok',
    value: { ...result, warnings: [...result.warnings, ...extraction.warnings] },
    provider: 'rules',
    model: 'rules',
  };
}
