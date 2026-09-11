/**
 * Syllabus parser for the Anna University B.E. CSE R2023 curriculum document.
 *
 * PRD section 4.4 makes the syllabus load-bearing rather than optional: papers
 * alone tell you what recurred, but only the syllabus tells you what EXISTS.
 * Without it the coverage matrix loses its whole right-hand column -- topics
 * in the syllabus that have never been examined, which is exactly what a
 * Mastery student needs, and what a cramming student needs to know they are
 * gambling on.
 *
 * The document covers the entire degree, so each subject is located by code
 * and parsed independently.
 *
 * Two outputs matter more than the unit titles:
 *
 *   1. `lectureHours` per unit ("8L, 12P"). This is the syllabus prior on
 *      marks weight, and it is what the ROI model leans on in a LOW
 *      repetition regime where per-question p_next carries little signal.
 *
 *   2. The numbered COURSE OUTCOMES. Every R2023 paper tags each question
 *      with a CO number, so these are the labels behind that column -- free
 *      ground-truth supervision for syllabus alignment, rather than an LLM
 *      guessing which unit a question belongs to.
 */

/** Course outcome as printed. `number` matches questions.co_code. */
export interface ParsedCourseOutcome {
  number: number;
  text: string;
}

export interface ParsedUnit {
  unitNo: number;
  title: string;
  /** The prior on marks weight. Practical hours are tracked separately. */
  lectureHours: number | null;
  practicalHours: number | null;
  topics: string[];
  rawText: string;
}

export interface ParsedSubjectSyllabus {
  subjectCode: string;
  subjectName: string;
  units: ParsedUnit[];
  courseOutcomes: ParsedCourseOutcome[];
  references: string[];
}

const ROMAN: Record<string, number> = {
  I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8,
};

/**
 * The document's en-dashes survive extraction as U+FFFD, and they sit in the
 * middle of every topic separator, so they are normalised before any
 * structural regex runs.
 */
function normalise(text: string): string {
  return text
    .replace(/\uFFFD/g, '-')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u00a0/g, ' ')
    // Tabs collapse, but RUNS OF SPACES ARE PRESERVED: the layout-extracted
    // document separates a unit title from its hours, and a subject code from
    // its name, with nothing but a run of spaces. Collapsing them here would
    // erase the only column boundary the document has.
    .replace(/	/g, " ");
}

/** Page furniture that appears mid-section and would otherwise enter topic text. */
const FURNITURE = [
  /^\s*Prepared by\b.*$/i,
  /^\s*\(Name & Signature\)\s*$/i,
  /^\s*\^?\s*Applicable to only courses Offered by other Departments\s*$/i,
  /^\s*HoD\b.*$/i,
  /^\s*\d{1,3}\s*$/,
];

function isFurniture(line: string): boolean {
  return FURNITURE.some((re) => re.test(line));
}

/**
 * Slices the whole-degree document down to one subject.
 *
 * The code appears at least twice: once in a curriculum summary table near
 * the front, and once as the detailed syllabus heading. Only the detailed
 * section is followed by UNIT headers, so candidates without them are skipped.
 */
function sliceSubject(doc: string, subjectCode: string): string | null {
  const heading = new RegExp(String.raw`^\s*${subjectCode}\b.*$`, 'gm');
  const starts: number[] = [];
  for (const m of doc.matchAll(heading)) {
    if (m.index !== undefined) starts.push(m.index);
  }

  for (const start of starts) {
    const rest = doc.slice(start);
    if (!/UNIT\s*[-\s]*\s*I\b/.test(rest.slice(0, 3000))) continue;

    // Ends at the next subject heading (code plus an ALL-CAPS title), or EOF.
    const next = rest.slice(200).search(/^\s*[A-Z]{2}\d{5}\s+[A-Z][A-Z\s&,-]{6,}/m);
    return next === -1 ? rest : rest.slice(0, 200 + next);
  }
  return null;
}

function parseUnits(section: string): ParsedUnit[] {
  const unitHeader =
    /^\s*UNIT\s*[-\s]*\s*([IVX]+)\s+(.+?)\s{2,}(\d+)L(?:\s*,\s*(\d+)P)?\s*$/gm;

  const headers: {
    roman: string; title: string; lecture: number;
    practical: number | null; at: number; len: number;
  }[] = [];

  for (const m of section.matchAll(unitHeader)) {
    if (m.index === undefined) continue;
    headers.push({
      roman: m[1] ?? '',
      title: (m[2] ?? '').trim(),
      lecture: Number(m[3]),
      practical: m[4] ? Number(m[4]) : null,
      at: m.index,
      len: m[0].length,
    });
  }

  return headers.map((h, i) => {
    const bodyStart = h.at + h.len;
    const bodyEnd = i + 1 < headers.length ? headers[i + 1]!.at : section.length;
    let body = section.slice(bodyStart, bodyEnd);

    // Lab exercises and the period total are not examinable theory content.
    body = body.split(/^\s*PRACTICALS?\s*:/m)[0] ?? body;
    body = body.split(/^\s*TOTAL\s*:/m)[0] ?? body;
    body = body.split(/^\s*COURSE OUTCOMES/m)[0] ?? body;

    const cleaned = body
      .split('\n')
      .filter((l) => !isFurniture(l))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    const topics = cleaned
      .split(/\s+-\s+/)
      .map((t) => t.replace(/^[-\s]+|[-\s]+$/g, '').trim())
      .filter((t) => t.length > 1);

    return {
      unitNo: ROMAN[h.roman] ?? i + 1,
      title: h.title.replace(/\s+/g, ' ').trim(),
      lectureHours: Number.isFinite(h.lecture) ? h.lecture : null,
      practicalHours: h.practical,
      topics,
      rawText: cleaned,
    };
  });
}

/** Shared shape of the numbered lists under COURSE OUTCOMES and REFERENCES. */
function parseNumberedList(block: string): { number: number; text: string }[] {
  const out: { number: number; text: string }[] = [];
  let current: { number: number; text: string } | null = null;

  for (const rawLine of block.split('\n')) {
    if (isFurniture(rawLine)) continue;
    const line = rawLine.trim();
    if (!line) continue;

    const numbered = /^(\d{1,2})[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      if (current) out.push(current);
      current = { number: Number(numbered[1]), text: (numbered[2] ?? '').trim() };
    } else if (current) {
      // A wrapped continuation of the previous entry.
      current.text = `${current.text} ${line}`.replace(/\s+/g, ' ').trim();
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * The numbered list under COURSE OUTCOMES. These are the labels behind the CO
 * column printed on every R2023 paper, which turns syllabus alignment from a
 * classification problem into a lookup.
 */
function parseCourseOutcomes(section: string): ParsedCourseOutcome[] {
  const start = section.search(/^\s*COURSE\s+OUTCOMES?\s*:?/m);
  if (start === -1) return [];

  let block = section.slice(start);
  block = block.split(/^\s*REFERENCES?\s*:?/m)[0] ?? block;
  block = block.split(/^\s*CO\s*-?\s*PO Mapping/m)[0] ?? block;
  block = block.replace(/^\s*COURSE\s+OUTCOMES?\s*:?.*$/m, '');
  block = block.replace(/^\s*Upon completion.*$/m, '');

  return parseNumberedList(block).filter(
    (o) => o.number >= 1 && o.number <= 12 && o.text.length > 3,
  );
}

function parseReferences(section: string): string[] {
  const start = section.search(/^\s*(REFERENCES?|TEXT\s*BOOKS?)\s*:?/m);
  if (start === -1) return [];

  let block = section
    .slice(start)
    .replace(/^\s*(REFERENCES?|TEXT\s*BOOKS?)\s*:?.*$/m, '');
  block = block.split(/^\s*CO\s*-?\s*PO Mapping/m)[0] ?? block;

  return parseNumberedList(block).map((r) => r.text);
}

/**
 * Parse one subject out of the whole-degree curriculum document.
 * Returns null when the code has no detailed section.
 */
export function parseSubjectSyllabus(
  documentText: string,
  subjectCode: string,
): ParsedSubjectSyllabus | null {
  const doc = normalise(documentText);
  const section = sliceSubject(doc, subjectCode);
  if (!section) return null;

  const nameMatch = new RegExp(
    String.raw`^\s*${subjectCode}\s+(.+?)\s{2,}\d*\s*$`,
    'm',
  ).exec(section);
  const subjectName = (nameMatch?.[1] ?? '').replace(/\s+/g, ' ').trim();

  const units = parseUnits(section);
  if (units.length === 0) return null;

  return {
    subjectCode,
    subjectName,
    units,
    courseOutcomes: parseCourseOutcomes(section),
    references: parseReferences(section),
  };
}
