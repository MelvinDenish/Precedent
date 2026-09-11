/**
 * Domain types. These mirror the schema in migrations/ one-to-one.
 *
 * FROZEN after Phase 0. Wave agents that need a new shared type declare it
 * locally and it gets promoted during the inter-wave merge -- concurrent
 * edits to the contract defeat the point of having one.
 */

// --- Corpus scoping -------------------------------------------------
// The corpus key. One shared master graph per (university, regulation, subject).

export interface Subject {
  subjectId: string;
  universityId: string;
  regulationId: string;
  code: string;
  name: string;
  semester: number | null;
}

export interface University {
  universityId: string;
  name: string;
  slug: string;
}

export interface Regulation {
  regulationId: string;
  universityId: string;
  code: string;
}

// --- Papers ---------------------------------------------------------

/**
 * Mixing a quiz MCQ with a 13-mark end-semester question corrupts the marks
 * bands, so recurrence statistics are scoped by this.
 */
export type ExamType = 'endsem' | 'assessment' | 'quiz' | 'supplementary' | 'retest';

/**
 * Which extraction path actually produced the text.
 *
 * dirty_ocr_recovered = the PDF had a text layer, it failed the quality gate,
 * and it was re-read with vision. A non-empty text layer is NOT evidence of a
 * usable one: 19 of 31 corpus papers are image-only scans and several more
 * carry garbage OCR such as "Define ambiquous qrammar".
 */
export type TextSource = 'digital' | 'vision' | 'dirty_ocr_recovered';

export type PaperStatus =
  | 'queued'
  | 'extracting'
  | 'segmenting'
  | 'embedding'
  | 'clustering'
  | 'enriching'
  | 'ready'
  | 'failed';

export interface Paper {
  paperId: string;
  subjectId: string;
  examSession: string | null;
  examYear: number;
  examType: ExamType;
  /** NULL = centrally set by the university. CEG or MIT = college-set. */
  college: string | null;
  /** Paper set letter from the header: BT, OT, RT, GT. */
  paperSet: string | null;
  contentHash: string;
  textSource: TextSource;
  blobUrl: string | null;
  pageCount: number | null;
  status: PaperStatus;
  template: PaperTemplate | null;
  createdAt: string;
}

/**
 * The recovered exam structure, consumed as a HARD CONSTRAINT by the Night
 * Before optimizer: the paper forces an answer from every unit, so taking the
 * globally top-N concepts fails a student whose top concepts all sit in one
 * unit.
 *
 * Anna University R2023: PART-A 10x2=20, PART-B 5x13=65 (OR-paired),
 * PART-C 1x15=15.
 */
export interface PaperTemplate {
  totalMarks: number;
  parts: PaperTemplatePart[];
}

export interface PaperTemplatePart {
  part: 'A' | 'B' | 'C';
  slotCount: number;
  marksPerSlot: number;
  /** PART-B slots are (a) OR (b); PART-A and PART-C are compulsory. */
  hasChoice: boolean;
  note: string | null;
}

// --- Questions ------------------------------------------------------

export interface Question {
  questionId: string;
  paperId: string;
  qNumber: string;
  partLabel: string | null;
  part: 'A' | 'B' | 'C' | null;
  text: string;
  marks: number | null;
  /**
   * PER-PAPER, and only meaningful together with paperId. Two questions are
   * alternatives only when they share BOTH. See canMerge() in or-rule.ts --
   * getting this wrong deflates every recurrence count with no error raised.
   */
  orGroupId: number | null;
  /** Course outcome printed on the paper. Supervision for syllabus alignment. */
  coCode: number | null;
  /** Bloom taxonomy level 1-6, printed on the paper. */
  blLevel: number | null;
  unitHint: number | null;
  pageNo: number | null;
  segConfidence: number | null;
}

/** Marks bands observed in the R2023 corpus. Sub-parts split 13 into 5 + 8. */
export const MARKS_BANDS = [2, 5, 8, 13, 15] as const;
export type MarksBand = (typeof MARKS_BANDS)[number];

// --- Clusters and the graph -----------------------------------------

export type ClusterStatus = 'provisional' | 'confirmed' | 'disputed';
export type DecidedBy = 'agent' | 'human' | 'rule';

export interface Cluster {
  clusterId: string;
  subjectId: string;
  canonicalText: string;
  /** answer_cache key. Content-addressed so merge and split stay cache-safe. */
  canonicalTextHash: string;
  marksBand: number | null;
  /** Optimistic concurrency. Bumped on every mutation. */
  version: number;
  confidence: number | null;
  status: ClusterStatus;
}

export interface Concept {
  conceptId: string;
  subjectId: string;
  name: string;
  description: string | null;
  /** lesson_cache key. Content-addressed. */
  contentHash: string;
}

export interface SyllabusUnit {
  unitId: string;
  subjectId: string;
  unitNo: number;
  title: string;
  hours: number | null;
}

/** Prerequisite edges are INDUCED, never hand-authored. Provenance is mandatory. */
export interface ConceptEdge {
  fromConcept: string;
  toConcept: string;
  kind: 'prerequisite' | 'related';
  confidence: number;
  evidence: ConceptEdgeEvidence;
}

export interface ConceptEdgeEvidence {
  proposedBy: 'llm' | 'corpus' | 'human';
  /** Corpus structure that confirmed or demoted the LLM proposal. */
  corpusSupport: {
    fromUnitNo: number | null;
    toUnitNo: number | null;
    vocabularyOverlap: number | null;
  } | null;
  note: string | null;
}

// --- Statistics -----------------------------------------------------

export interface ClusterStats {
  clusterId: string;
  appearances: number;
  decayedFreq: number;
  lastSeenYear: number | null;
  meanGapYears: number | null;
  /**
   * Renewal hazard, and counter-intuitive: a topic absent for three sittings
   * is MORE likely to appear, because examiners rotate through units. Raw
   * frequency counting gets this exactly backwards, which is one reason
   * hand-computed "important questions" lists go stale.
   */
  overdueRatio: number | null;
  pNext: number;
  expectedMarks: number;
}

export interface ConceptStats {
  conceptId: string;
  expectedMarks: number;
  studyCostMin: number;
  roi: number;
  /** Share of students who needed Tier 2. Corrects studyCostMin over time. */
  escalationRate: number | null;
  evidenceClusterCount: number;
}

export type Regime = 'high' | 'medium' | 'low';

export interface SubjectRegime {
  subjectId: string;
  repetitionRate: number;
  regime: Regime;
  paperCount: number;
}

// --- Citations: the non-negotiable trail ----------------------------

/**
 * Every statistic in the product drills down to this. PRD Principle 1:
 * "A statistic without a paper/year/question-number trail does not ship.
 * This is the only thing separating Precedent from an LLM guessing."
 */
export interface Citation {
  paperId: string;
  examYear: number;
  examSession: string | null;
  examType: ExamType;
  college: string | null;
  qNumber: string;
  partLabel: string | null;
  marks: number | null;
  /** Present only for user-notes citations, absent for corpus citations. */
  sourceTitle?: string;
}

// --- Learning -------------------------------------------------------

export type LearnMode = 'night_before' | 'mastery';
export type LearnState = 'SELECT' | 'TEACH' | 'TEST' | 'STUCK' | 'DONE';
export type LessonDepth = 'cram' | 'full';

export interface LearnSession {
  sessionId: string;
  userId: string;
  subjectId: string;
  mode: LearnMode;
  budgetMin: number | null;
  spentMin: number;
  plan: LearnPlan;
  cursor: LearnCursor;
  state: LearnState;
}

export interface LearnPlan {
  /** Ordered concept ids: ROI-descending (night_before) or topological (mastery). */
  conceptIds: string[];
  /** Night Before only: minimum viable coverage per unit, reached before deepening. */
  unitCoverage: Record<string, number>;
  /** ~15% held back to absorb prerequisite hops discovered mid-run. */
  reserveMin: number;
  expectedMarksTotal: number;
}

export interface LearnCursor {
  index: number;
  /** Prerequisite hops push here; the loop pops back when they are cleared. */
  prerequisiteStack: string[];
  currentConceptId: string | null;
  currentClusterId: string | null;
}

export interface Lesson {
  conceptId: string;
  depth: LessonDepth;
  body: string;
  sources: Citation[];
  /**
   * What the source material did NOT cover. An honest lesson is cached as
   * honestly as a complete one: the system flags the gap rather than
   * inventing content. PRD Principle 2, made storable.
   */
  gapFlags: GapFlag[];
}

export interface GapFlag {
  topic: string;
  missingFrom: ('syllabus' | 'notes' | 'textbook' | 'corpus')[];
  note: string;
}

export interface AnswerEvaluation {
  score: number;
  maxScore: number;
  points: EvaluatedPoint[];
  /** Each miss maps to a concept id -- this is what feeds the prerequisite hop. */
  missedConceptIds: string[];
}

export interface EvaluatedPoint {
  point: string;
  awarded: number;
  possible: number;
  conceptId: string | null;
  comment: string;
}

export interface Mastery {
  userId: string;
  conceptId: string;
  score: number;
  lastSeenAt: string | null;
  dueAt: string | null;
}

// --- Escalation ladder ----------------------------------------------

/**
 * Tiers 0 and 1 are generated once per corpus and served to every student
 * sharing the (university, regulation, subject) key. Only Tier 2 spends
 * per-student tokens. That is the cost model, not just UX.
 */
export type EscalationTier = 0 | 1 | 2;

export interface TutorMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  citations?: Citation[];
  at: string;
}

// --- Review queue ---------------------------------------------------

export type ReviewKind = 'merge' | 'split' | 'segmentation' | 'dlq';
export type ReviewStatus = 'open' | 'resolved' | 'dismissed';

export interface ReviewItem {
  reviewId: string;
  subjectId: string;
  kind: ReviewKind;
  payload: unknown;
  confidence: number | null;
  status: ReviewStatus;
  createdAt: string;
}
