/**
 * Header metadata parse.
 *
 * THE FILENAME IS NOT EVIDENCE. This is the load-bearing rule of this file,
 * and the corpus enforces it three separate ways:
 *
 *   - CN-CEG-22S5-QP.pdf sits in the "CS23502 Networks and Data
 *     Communication" folder, which is an R2023 subject. Its header reads
 *     "12th September 2022 / CS6111: Computer Networks / (Regulation 2018)".
 *     Trusting the path would file an R2018 CS6111 paper as R2023 CS23502
 *     and silently merge two different syllabuses into one corpus.
 *   - OS-Endsem-BT.pdf / -OT / -RT / TOC-Endsem-GT: BT, OT, RT and GT are
 *     PAPER SET letters, not dates and not exam types.
 *   - Folder names carry a Google-Takeout timestamp ("-20260910T203235Z")
 *     that is the download date, not the exam date.
 *
 * So every field here is parsed from header TEXT. FilenameHints fill a field
 * only when the header yielded nothing for it, and a disagreement between
 * the two is recorded as a warning rather than resolved in the filename's
 * favour.
 */

import type { ExamType, PaperMetadata } from '@precedent/shared';
import type { FilenameHints } from '../types.js';

export interface HeaderParse {
  metadata: PaperMetadata;
  warnings: string[];
}

const ROMAN: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6,
  vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12,
};

const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

/**
 * The university writes sessions as a month PAIR ("NOV/DEC 2025",
 * "APRIL/MAY 2024"); college-set internals write a single date
 * ("12th September 2022"). Only the pair form is a real exam session, so a
 * single month is emitted as its own slug and flagged, rather than being
 * rounded to the nearest official session -- an invented 'nov-dec' on a
 * September quiz would land it in the wrong recurrence bucket forever.
 */
function parseSession(header: string): { session: string | null; nonStandard: boolean } {
  const pair = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*[/&-]\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/i.exec(
    header,
  );
  if (pair) return { session: `${pair[1]?.toLowerCase()}-${pair[2]?.toLowerCase()}`, nonStandard: false };

  const single = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.exec(
    header,
  );
  if (single) {
    const slug = single[1]?.slice(0, 3).toLowerCase() ?? null;
    // A lone month is always non-standard: every official sitting is a pair.
    return { session: slug !== null && MONTHS.includes(slug) ? slug : null, nonStandard: true };
  }
  return { session: null, nonStandard: false };
}

function parseExamType(header: string): ExamType | null {
  const h = header.toLowerCase();
  // Order matters: "SUPPLEMENTARY EXAMINATIONS" also contains "examinations",
  // and a retest is an end-semester paper by format but not by statistics.
  if (/supplementary/.test(h)) return 'supplementary';
  if (/re-?\s?test|retest/.test(h)) return 'retest';
  if (/\bquiz\b/.test(h)) return 'quiz';
  if (/end\s*-?\s*sem|end\s+semester/.test(h)) return 'endsem';
  if (/mid\s*-?\s*sem|assessment|cycle\s*test|\bCAT\b/i.test(h)) return 'assessment';
  return null;
}

/**
 * NULL means centrally set by the university departments, which is the
 * slice recurrence statistics default to. CEG and MIT are college-set
 * internals sharing the same subject -- they belong in the corpus but not
 * in the same marks bands.
 */
function parseCollege(header: string): string | null {
  if (/college\s+of\s+engineering,?\s*guindy|\bCEG\b/i.test(header)) return 'CEG';
  if (/madras\s+institute\s+of\s+technology|\bMIT\b/i.test(header)) return 'MIT';
  return null;
}

function parseSemester(header: string): number | null {
  const m = /\bsemester\s*[-:]?\s*([ivx]{1,4})\b|\b([ivx]{1,4})(?:th|st|nd|rd)?\s+semester\b/i.exec(
    header,
  );
  const roman = (m?.[1] ?? m?.[2])?.toLowerCase();
  if (roman && ROMAN[roman] !== undefined) return ROMAN[roman] ?? null;
  const arabic = /\bsemester\s*[-:]?\s*(\d{1,2})\b/i.exec(header);
  if (arabic?.[1]) {
    const n = Number(arabic[1]);
    if (n >= 1 && n <= 12) return n;
  }
  return null;
}

/**
 * Anna University subject codes are letters then digits with no separator:
 * CS23501 (R2023) and CS6111 (R2018) both occur in this corpus, for what is
 * nominally the same subject.
 */
function parseSubjectCode(header: string): string | null {
  for (const m of header.matchAll(/\b([A-Z]{2,4})\s?(\d{4,6})\b/g)) {
    const letters = m[1] ?? '';
    // "NOV/DEC2025" looks exactly like a subject code and is not one. The
    // sitting line always precedes the subject line, so without this the
    // month always wins and every centrally-set paper is filed under
    // subject "DEC2025".
    if (MONTHS.includes(letters.toLowerCase())) continue;
    return `${letters}${m[2]}`;
  }
  return null;
}

function parseSubjectName(header: string, code: string | null): string | null {
  if (code === null) return null;
  // The name follows the code on the same line, after a separator that is
  // variously "-", "&", ":" or nothing at all.
  // String.raw on every dynamically-built pattern: a template literal eats
  // the backslash in "\s", which degrades silently into a literal "s".
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const pattern = new RegExp(String.raw`${escaped}\s*[-:&]?\s*([A-Za-z][A-Za-z ,.&/()-]{3,80})`);
  // Line by line, never over a flattened header. Flattening lets the match
  // run past the end of the title into whatever follows it, which turns
  // "CS6111-Computer Networks / Mid Sem / Time: 1.30hrs" into the subject
  // name "Computer Networks Mid Sem Time".
  for (const line of header.split('\n')) {
    const m = pattern.exec(line.replace(/\s+/g, ' '));
    if (!m?.[1]) continue;
    const name = m[1].split(/\s*\(/)[0]?.trim() ?? '';
    if (name.length >= 4) return name.slice(0, 200);
  }
  return null;
}

export function parseHeaderMetadata(
  headerText: string,
  hints: FilenameHints | undefined,
  totalMarksFromTemplate: number | null,
): HeaderParse {
  const warnings: string[] = [];
  // Scanned headers carry non-breaking spaces, which defeat every
  // \s-anchored pattern below. Written as an escape so it stays visible.
  const header = headerText.replace(/ /g, ' ');

  // A four-digit year in the plausible exam range. The FIRST one wins:
  // the header runs title-first, and a stray year later in the page is
  // usually a syllabus reference ("Regulation 2018-RUSA") which is caught
  // separately below.
  let examYear: number | null = null;
  for (const m of header.matchAll(/\b(19|20)\d{2}\b/g)) {
    const n = Number(m[0]);
    // Skip a year that is immediately preceded by "Regulation" -- that is
    // the syllabus revision, not the sitting.
    const before = header.slice(Math.max(0, (m.index ?? 0) - 14), m.index ?? 0);
    if (/regulation\s*$/i.test(before)) continue;
    if (n >= 1990 && n <= 2100) { examYear = n; break; }
  }

  const regulationMatch = /regulation\s*[-:]?\s*(\d{4})/i.exec(header);
  const regulationCode = regulationMatch?.[1] ? `R${regulationMatch[1]}` : null;

  const { session, nonStandard } = parseSession(header);
  if (session !== null && nonStandard) {
    warnings.push(
      `header names a single month ("${session}") rather than a university session; ` +
        'recorded verbatim rather than rounded to nov-dec / apr-may',
    );
  }

  const subjectCode = parseSubjectCode(header);
  const examType = parseExamType(header);
  const college = parseCollege(header);

  const maxMarks = /max\.?\s*marks\s*[:\-]?\s*(\d{2,4})/i.exec(header)
    ?? /\bmarks\s*[:\-]\s*(\d{2,4})/i.exec(header);
  const printedTotal = maxMarks?.[1] ? Number(maxMarks[1]) : null;

  const metadata: PaperMetadata = {
    subjectCode,
    subjectName: parseSubjectName(header, subjectCode),
    regulationCode,
    examYear,
    examSession: session,
    examType,
    college,
    // Paper set is NOT printed in the header of any paper in this corpus;
    // it lives only in the archive filename (-BT, -OT, -RT, -GT). This is
    // the one field the hint is the primary source for, and it is recorded
    // as such rather than silently blended with header-derived fields.
    paperSet: hints?.paperSet ?? null,
    semester: parseSemester(header),
    totalMarks: printedTotal ?? totalMarksFromTemplate,
  };

  if (hints) {
    if (metadata.examYear === null && hints.examYear !== null) {
      metadata.examYear = hints.examYear;
      warnings.push('exam year taken from filename hint: no year in header');
    } else if (
      hints.examYear !== null &&
      metadata.examYear !== null &&
      hints.examYear !== metadata.examYear
    ) {
      warnings.push(
        `filename suggests ${hints.examYear} but the header says ${metadata.examYear}; header wins`,
      );
    }
    if (metadata.examType === null && hints.examType !== null) metadata.examType = hints.examType;
    if (metadata.college === null && hints.college !== null) {
      // Deliberately NOT applied. A missing college in the header means
      // "centrally set", which is a real and load-bearing value -- see
      // migrations/007. Overwriting it from a filename would move papers
      // out of the default statistics slice.
      warnings.push(
        `filename suggests college ${hints.college} but the header names none; ` +
          'kept as centrally-set',
      );
    }
  }

  if (
    printedTotal !== null &&
    totalMarksFromTemplate !== null &&
    printedTotal !== totalMarksFromTemplate
  ) {
    warnings.push(
      `header total ${printedTotal} disagrees with the parts summing to ${totalMarksFromTemplate}`,
    );
  }

  return { metadata, warnings };
}

/**
 * Filename parse. A HINT ONLY -- see the module comment and FilenameHints.
 */
export function parseFilenameHints(filename: string): FilenameHints {
  const base = filename.replace(/\.pdf$/i, '');
  const setMatch = /-(BT|OT|RT|GT)\b/i.exec(base);
  // "22S5" = 2022, semester 5. Two digits, not four, so it cannot be
  // confused with a header year.
  const yearMatch = /\b(\d{2})S\d\b/i.exec(base);
  const year = yearMatch?.[1] ? 2000 + Number(yearMatch[1]) : null;

  let examType: ExamType | null = null;
  if (/supplementary/i.test(base)) examType = 'supplementary';
  else if (/retest|re-?test/i.test(base)) examType = 'retest';
  else if (/quiz/i.test(base)) examType = 'quiz';
  else if (/assess/i.test(base)) examType = 'assessment';
  else if (/endsem/i.test(base)) examType = 'endsem';

  return {
    college: /-CEG-/i.test(base) ? 'CEG' : /-MIT/i.test(base) ? 'MIT' : null,
    paperSet: setMatch?.[1] ? setMatch[1].toUpperCase() : null,
    examType,
    examYear: year !== null && year >= 1990 && year <= 2100 ? year : null,
  };
}
