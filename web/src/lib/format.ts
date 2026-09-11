import type { Citation, ExamType, IngestStage, PaperStatus, Regime } from '@precedent/shared';

/* --- Citations ----------------------------------------------------------- */

/**
 * The compact reference stamp: `2023 NOV Q13(b)`.
 * Always mono, always tabular. This string is the product's signature.
 */
export function citationRef(c: Citation): string {
  const session = c.examSession ? ` ${c.examSession.toUpperCase()}` : '';
  return `${c.examYear}${session} ${questionRef(c)}`;
}

export function questionRef(c: Pick<Citation, 'qNumber' | 'partLabel'>): string {
  return c.partLabel ? `Q${c.qNumber}(${c.partLabel})` : `Q${c.qNumber}`;
}

export function marksLabel(marks: number | null): string {
  return marks === null ? '-' : `${marks}m`;
}

const EXAM_TYPE_LABEL: Record<ExamType, string> = {
  endsem: 'End semester',
  assessment: 'Assessment',
  quiz: 'Quiz',
  supplementary: 'Supplementary',
  retest: 'Retest',
};

export function examTypeLabel(t: ExamType): string {
  return EXAM_TYPE_LABEL[t];
}

/** `null` college is not missing data - it means the paper was set centrally. */
export function collegeLabel(college: string | null): string {
  return college === null ? 'Centrally set' : college;
}

/* --- Numbers ------------------------------------------------------------- */

export function pct(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function marks(value: number, digits = 1): string {
  return value.toFixed(digits);
}

export function count(value: number): string {
  return new Intl.NumberFormat('en-IN').format(value);
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function yearRangeLabel(range: [number, number] | null): string {
  if (!range) return 'no sittings';
  const [from, to] = range;
  return from === to ? `${from}` : `${from}-${to}`;
}

/* --- Pipeline vocabularies ----------------------------------------------- */

/**
 * `Paper.status` is present-tense (`extracting`) and `IngestStage` is
 * past-tense (`extracted`). They are two different vocabularies over the same
 * pipeline, so the rail maps both into ONE ordered index rather than indexing
 * off whichever string arrived last.
 */
export const INGEST_STAGES = [
  'queued',
  'extracted',
  'segmented',
  'embedded',
  'clustered',
  'enriched',
  'ready',
] as const satisfies readonly IngestStage[];

export type CompletedStage = (typeof INGEST_STAGES)[number];

export const STAGE_LABEL: Record<CompletedStage, string> = {
  queued: 'Queued',
  extracted: 'Text extracted',
  segmented: 'Questions segmented',
  embedded: 'Embedded',
  clustered: 'Clustered',
  enriched: 'Concepts mapped',
  ready: 'Ready',
};

/** What the worker is doing while it sits between stage N and stage N+1. */
export const STAGE_ACTIVE_LABEL: Record<CompletedStage, string> = {
  queued: 'Reading the PDF',
  extracted: 'Splitting into questions',
  segmented: 'Computing embeddings',
  embedded: 'Matching against earlier years',
  clustered: 'Mapping to syllabus concepts',
  enriched: 'Recomputing statistics',
  ready: 'Done',
};

/** Index of a completed stage within INGEST_STAGES, or -1. */
export function stageIndex(stage: IngestStage): number {
  return (INGEST_STAGES as readonly string[]).indexOf(stage);
}

/** Map the POST /upload present-tense status onto the same ordered axis. */
export function statusToStageIndex(status: PaperStatus): number {
  switch (status) {
    case 'queued':
      return 0;
    case 'extracting':
      return 0;
    case 'segmenting':
      return 1;
    case 'embedding':
      return 2;
    case 'clustering':
      return 3;
    case 'enriching':
      return 4;
    case 'ready':
      return INGEST_STAGES.length - 1;
    case 'failed':
      return -1;
  }
}

/* --- Regime -------------------------------------------------------------- */

/**
 * Regime is a statement about how much the CORPUS repeats, not a verdict on
 * the subject. It is therefore hueless (see THE COLOUR LAW) and carries an
 * explicit sentence rather than a colour.
 */
export const REGIME_COPY: Record<Regime, { label: string; blurb: string }> = {
  high: {
    label: 'HIGH REPETITION',
    blurb: 'Questions recur often here. Per-question predictions are meaningful.',
  },
  medium: {
    label: 'MEDIUM REPETITION',
    blurb: 'Some recurrence. Trust concept-level ranking over single questions.',
  },
  low: {
    label: 'LOW REPETITION',
    blurb:
      'Questions rarely recur in this subject. Precedent falls back to concept frequency and syllabus priors.',
  },
};

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}
