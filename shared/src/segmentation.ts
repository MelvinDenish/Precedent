/**
 * The normalized intermediate representation that BOTH extraction paths emit.
 *
 * This exists because 19 of the 31 corpus papers are image-only scans. The
 * digital path (pdfjs-dist coordinates -> rule segmenter) and the vision path
 * (Gemini, prompted to emit this structure directly) produce the same shape,
 * so everything downstream -- embedding, clustering, statistics -- is blind to
 * which path a paper came through.
 *
 * Writing one segmenter against pdfjs coordinate output and only then
 * discovering it cannot consume vision output would cost an entire wave, so
 * the contract is fixed here before either is built.
 */

import type { ExamType, PaperTemplate } from './domain.js';

/** One atomic question or sub-part, as recovered from a paper. */
export interface SegmentedQuestion {
  /** 'A' | 'B' | 'C' in the R2023 template; null if the paper has no parts. */
  part: 'A' | 'B' | 'C' | null;
  /** '11' -- the top-level question number. */
  qNumber: string;
  /** 'a', 'b', 'i', 'ii' -- null for an undivided question. */
  partLabel: string | null;
  text: string;
  marks: number | null;
  /**
   * PER-PAPER ordinal grouping alternatives. In the R2023 template a literal
   * centered "OR" sits between 11(a) and 11(b), so both get orGroupId 11.
   * NULL when the question offers no choice (all of PART-A and PART-C).
   */
  orGroupId: number | null;
  /** Course outcome printed in the paper's CO column. */
  coCode: number | null;
  /** Bloom taxonomy level printed in the paper's BL column. */
  blLevel: number | null;
  pageNo: number | null;
  /** Segmenter self-assessment. Low values route to the review queue. */
  confidence: number;
}

/** Metadata read from the paper HEADER, never from the filename. */
export interface PaperMetadata {
  /** 'CS23503' -- may differ from the current code for older regulations. */
  subjectCode: string | null;
  subjectName: string | null;
  /** 'R2023', 'R2018' -- older papers in this corpus are genuinely R2018. */
  regulationCode: string | null;
  examYear: number | null;
  /** 'apr-may' | 'nov-dec' */
  examSession: string | null;
  examType: ExamType | null;
  /** NULL when centrally set by the university departments. */
  college: string | null;
  paperSet: string | null;
  semester: number | null;
  totalMarks: number | null;
}

/** What a completed segmentation job hands to the next stage. */
export interface SegmentationResult {
  metadata: PaperMetadata;
  template: PaperTemplate | null;
  questions: SegmentedQuestion[];
  /** Which path produced this, for papers.text_source. */
  method: 'rules' | 'vision' | 'llm_fallback';
  /** Mean question confidence; drives the review-queue decision for the paper. */
  overallConfidence: number;
  warnings: string[];
}

// --- Text quality gate ----------------------------------------------

export interface TextQuality {
  usable: boolean;
  score: number;
  reason: string;
}

/**
 * Decides whether a PDF text layer is good enough to segment, or whether the
 * pages must be re-read with vision.
 *
 * ARCHITECTURE.md specifies "Gemini vision if the text layer is EMPTY". That
 * rule is insufficient for this corpus. TOC-R2023-EndSem-25S5 carries ~5,800
 * characters of text layer, and it reads:
 *
 *     "Answer a uest1ons" ... "Define ambiquous qrammar and CFG"
 *
 * Non-empty, and worse than useless: a bad text layer passes an emptiness
 * check and then silently poisons every embedding, cluster and statistic
 * downstream. So the gate measures quality, not presence.
 *
 * CALIBRATION. Thresholds were fitted against the 31-paper seed corpus, of
 * which 19 have no text layer at all and 12 have one. Hand inspection found
 * exactly one of those 12 to be unusable. Measured spread:
 *
 *                            alphaRatio  punctRuns  commonWords
 *   11 usable papers          0.78-0.92   0.0000-0.0056   0.70-1.00
 *   TOC-R2023-EndSem-25S5     0.79        0.0130          0.65
 *
 * Note that alphaRatio does NOT separate them; punctuation-run density is
 * the signal that does, because failed OCR emits header noise like
 * "_/:.:;?~~}~!~:~:>.-" that real text never contains. Its threshold sits at
 * 0.008, midway across a 2.3x gap between the worst usable paper and the
 * unusable one, so it is a real margin rather than a fitted boundary.
 *
 * commonWords is deliberately NOT used as a co-discriminator. The usable
 * papers bottom out at 0.70 and the unusable one sits at 0.65, so any
 * threshold between them would be fitted to a 5-point gap on a sample of
 * twelve -- and it would reject terse but perfectly good extractions, which
 * it did on first attempt. It is kept only as a floor against outright
 * gibberish.
 *
 * The asymmetry matters when tuning: routing a good paper to vision costs
 * some free-tier quota, while accepting a bad one corrupts the corpus
 * silently and permanently. When the signals disagree, prefer vision.
 * Misroutes in either direction surface in the segmentation review queue.
 */
export function assessTextQuality(text: string): TextQuality {
  const trimmed = text.trim();

  if (trimmed.length < 200) {
    return { usable: false, score: 0, reason: 'text layer empty or near-empty' };
  }

  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 50) {
    return { usable: false, score: 0, reason: 'too few words to segment' };
  }

  // Alphabetic share of NON-WHITESPACE characters. Measuring against total
  // length instead would punish correctly-extracted papers, because
  // layout-preserving extraction pads tables with runs of spaces.
  const nonWhitespaceCount = trimmed.replace(/\s/g, '').length;
  const letterCount = (trimmed.match(/[a-z]/gi) ?? []).length;
  const alphaRatio = nonWhitespaceCount > 0 ? letterCount / nonWhitespaceCount : 0;

  // Runs of four or more consecutive punctuation characters, per word. The
  // characteristic residue of OCR failing on a scanned header or a diagram.
  const punctRuns = (trimmed.match(/[^\w\s]{4,}/g) ?? []).length;
  const punctRunRatio = punctRuns / words.length;

  // Tokens mixing letters and digits mid-word ("uest1ons", "202~").
  const garbled = words.filter((w) => /[a-z]/i.test(w) && /[0-9~^|]/.test(w)).length;
  const garbledRatio = garbled / words.length;

  // Real English prose hits these constantly; OCR noise does not.
  const COMMON = [
    'the', 'and', 'of', 'to', 'in', 'is', 'for', 'with', 'that', 'a',
    'are', 'on', 'be', 'as', 'by', 'an', 'or', 'which', 'from', 'this',
  ];
  const flattened = ` ${trimmed.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')} `;
  const commonRatio = COMMON.filter((w) => flattened.includes(` ${w} `)).length / COMMON.length;

  const score =
    Math.min(alphaRatio / 0.9, 1) * 0.3 +
    (1 - Math.min(punctRunRatio / 0.013, 1)) * 0.35 +
    (1 - Math.min(garbledRatio / 0.2, 1)) * 0.1 +
    commonRatio * 0.25;

  if (alphaRatio < 0.7) {
    return { usable: false, score, reason: `low alphabetic ratio (${alphaRatio.toFixed(2)})` };
  }
  if (punctRunRatio > 0.008) {
    return {
      usable: false,
      score,
      reason: `OCR punctuation noise (${punctRunRatio.toFixed(4)} runs/word)`,
    };
  }
  if (commonRatio < 0.45) {
    return {
      usable: false,
      score,
      reason: `too few common English words (${commonRatio.toFixed(2)})`,
    };
  }
  if (garbledRatio > 0.15) {
    return {
      usable: false,
      score,
      reason: `garbled tokens (${(garbledRatio * 100).toFixed(1)}%)`,
    };
  }

  return { usable: true, score, reason: 'text layer usable' };
}
