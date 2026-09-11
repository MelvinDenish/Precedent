/**
 * Normalises raw vision output into the frozen SegmentationResult IR.
 *
 * Gate 2 of the build plan was to probe what Gemini vision actually returns
 * for a scanned paper BEFORE building a segmenter, because the rule path and
 * the vision path share a contract that had never been tested. The probe ran
 * against OS-R2023-EndSem-25S5.pdf (no text layer at all) and the contract
 * holds -- but the raw output needs this layer in between.
 *
 * WHAT THE PROBE CONFIRMED WORKS, and must keep working:
 *
 *   - OR groups are recovered correctly. 11(a) and 11(b) both came back with
 *     orGroupId 11, as SEPARATE questions. This is the load-bearing case.
 *   - Sub-part marks survive individually: 12(a)(i)=5 and 12(a)(ii)=8, rather
 *     than a single 13. Mark bands drive answer depth and ROI, so collapsing
 *     them would be a silent quality loss.
 *   - CO and BL were present on 27 of 27 questions.
 *   - The PART A/B/C template, slot counts and marks-per-slot were exact.
 *
 * WHAT IT RETURNS THAT THE SCHEMA WILL NOT ACCEPT, hence this module:
 *
 *   - qNumber arrives as "11(a)(i)" with partLabel "(a)(i)", duplicating the
 *     information and matching neither column. The schema wants qNumber "11"
 *     and partLabel "a-i", which is also what UNIQUE (paper_id, q_number,
 *     part_label) expects.
 *   - college arrives as "ANNA UNIVERSITY (UNIVERSITY DEPARTMENTS)". In this
 *     schema a centrally-set paper has college NULL, and only a genuinely
 *     college-set paper (CEG, MIT) names one. Left alone, every centrally-set
 *     paper would be excluded from the default statistics slice.
 *   - regulationCode arrives as "2023" rather than "R2023", and subjectCode
 *     as "CS 23501" with an interior space, so neither joins to its row.
 */

import type { SegmentedQuestion, SegmentationResult } from '@precedent/shared';

/** Colleges that set their own papers. Anything else is centrally set. */
const COLLEGE_CODES = ['CEG', 'MIT'] as const;

/**
 * NULL means centrally set by the university departments, which is the
 * default statistics slice. A model naming the university in this field is
 * answering a different question than the schema asks.
 */
export function normaliseCollege(raw: string | null): string | null {
  if (!raw) return null;
  const upper = raw.toUpperCase();
  for (const code of COLLEGE_CODES) {
    // Word-boundary match: "ANNA UNIVERSITY" must not match on stray letters.
    if (new RegExp(String.raw`\b${code}\b`).test(upper)) return code;
  }
  return null;
}

export function normaliseRegulation(raw: string | null): string | null {
  if (!raw) return null;
  const digits = /(\d{4})/.exec(raw);
  return digits ? `R${digits[1]}` : null;
}

export function normaliseSubjectCode(raw: string | null): string | null {
  if (!raw) return null;
  const compact = raw.replace(/[\s_-]+/g, '').toUpperCase();
  return /^[A-Z]{2,3}\d{4,5}$/.test(compact) ? compact : null;
}

/**
 * Splits "11(a)(i)" into a question number and a flattened part label.
 *
 * Returns partLabel "a-i" rather than nested structure: the schema's
 * UNIQUE (paper_id, q_number, part_label) needs one scalar per row, and the
 * nesting carries no information the marks and text do not already carry.
 */
export function splitQuestionNumber(
  rawNumber: string,
  rawPartLabel: string | null,
): { qNumber: string; partLabel: string | null } {
  const combined = `${rawNumber ?? ''}${rawPartLabel ?? ''}`;

  const leading = /^\s*(\d{1,3})/.exec(combined);
  const qNumber = leading?.[1] ?? String(rawNumber ?? '').trim();

  // Every parenthesised or bare alphabetic/roman token after the number.
  const tail = combined.slice((leading?.[0] ?? '').length);
  const parts = [...tail.matchAll(/\(?\s*([a-z]+|[ivx]+)\s*\)?/gi)]
    .map((m) => (m[1] ?? '').toLowerCase())
    .filter((p) => p.length > 0);

  // De-duplicate: the model repeats the label in both fields, so "11(a)" with
  // partLabel "(a)" would otherwise yield "a-a".
  const deduped = parts.filter((p, i) => parts.indexOf(p) === i);

  return { qNumber, partLabel: deduped.length > 0 ? deduped.join('-') : null };
}

/**
 * PART A and PART C are compulsory, so nothing in them is an alternative.
 *
 * A model that helpfully assigns an orGroupId there would make every PART-A
 * question an OR-sibling of its neighbours, and the merge guard would then
 * refuse legitimate cross-year merges within the same paper number -- the
 * over-strict failure, which deflates every recurrence count and raises no
 * error. Cheaper to clear it here than to debug the statistics later.
 */
function orGroupFor(part: 'A' | 'B' | 'C' | null, raw: number | null): number | null {
  if (part === 'A' || part === 'C') return null;
  return raw;
}

export function normaliseQuestion(raw: SegmentedQuestion): SegmentedQuestion {
  const { qNumber, partLabel } = splitQuestionNumber(raw.qNumber, raw.partLabel);
  return {
    ...raw,
    qNumber,
    partLabel,
    orGroupId: orGroupFor(raw.part, raw.orGroupId),
    text: raw.text.replace(/[ 	]+/g, ' ').trim(),
    coCode: raw.coCode ?? null,
    blLevel: raw.blLevel ?? null,
  };
}

/** Applies every normalisation to a raw vision result. */
export function normaliseVisionResult(raw: SegmentationResult): SegmentationResult {
  const questions = raw.questions.map(normaliseQuestion);

  const warnings = [...raw.warnings];
  const missingCo = questions.filter((q) => q.coCode === null).length;
  if (missingCo > 0) {
    warnings.push(`${missingCo} of ${questions.length} questions have no CO code`);
  }

  return {
    ...raw,
    metadata: {
      ...raw.metadata,
      subjectCode: normaliseSubjectCode(raw.metadata.subjectCode),
      regulationCode: normaliseRegulation(raw.metadata.regulationCode),
      college: normaliseCollege(raw.metadata.college),
    },
    questions,
    method: 'vision',
    warnings,
  };
}

/**
 * Marks actually obtainable from a paper, as distinct from marks printed on it.
 *
 * The probe returned PART-B totalling 130 marks across 15 questions, because
 * BOTH sides of every OR pair are emitted -- correctly so, since both are
 * evidence of what gets examined. But a student answers one side of each
 * pair, so the paper is worth 65 there, not 130.
 *
 * Expected-marks arithmetic must use this, or every OR-paired unit is
 * weighted at roughly double its true value and the Night Before optimizer
 * over-invests in whichever unit happens to have the most choice.
 */
export function obtainableMarks(questions: readonly SegmentedQuestion[]): number {
  let total = 0;
  const seenOrGroups = new Map<number, number>();

  for (const q of questions) {
    const marks = q.marks ?? 0;
    if (q.orGroupId === null) {
      total += marks;
      continue;
    }
    // Accumulate the group; it is halved below, once, after the loop.
    seenOrGroups.set(q.orGroupId, (seenOrGroups.get(q.orGroupId) ?? 0) + marks);
  }

  // Each OR group offers two alternatives of equal weight, so half its total
  // is what one student can actually earn.
  for (const groupTotal of seenOrGroups.values()) {
    total += Math.round(groupTotal / 2);
  }
  return total;
}
