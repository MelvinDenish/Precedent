/**
 * Queue job contracts.
 *
 * Each ingestion stage S1..S9 is a SEPARATE BullMQ job, not one long
 * function. A failure retries only the failed stage; different stages need
 * different rate limiters (vision vs text vs none); progress is reportable
 * per stage; and a stage can be re-run in isolation when its implementation
 * improves -- re-segmenting without re-extracting, for instance.
 *
 * Every job body is IDEMPOTENT: it carries the ids it needs and re-derives
 * nothing from wall-clock time, so a retry after partial success is safe.
 */

export const QUEUES = {
  /** S1 extract, S2 segment. Low concurrency, CPU bound. */
  ingest: 'ingest',
  /** S3 embed. High concurrency -- local ONNX, no network, no rate limit. */
  embed: 'embed',
  /** S4 candidates, S5 adjudicate, S6 gate, S7 cluster. */
  adjudicate: 'adjudicate',
  /** S8 concepts, S9 stats. */
  enrich: 'enrich',
  /** Canonical answers and lessons. Lazy or warmed. */
  generate: 'generate',
  /** Spaced-repetition due sweep. Concurrency 1. */
  schedule: 'schedule',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface ExtractJob {
  paperId: string;
  blobUrl: string;
}

export interface SegmentJob {
  paperId: string;
}

export interface EmbedJob {
  /** Batched: embedding is the highest-volume call in the system. */
  questionIds: string[];
}

export interface AdjudicateJob {
  questionId: string;
  candidateQuestionIds: string[];
}

export interface ClusterMutationJob {
  kind: 'merge' | 'split';
  clusterIds: string[];
  /** The version each cluster was read at. A mismatch means retry, not overwrite. */
  expectedVersions: Record<string, number>;
  decidedBy: 'agent' | 'human' | 'rule';
  confidence: number;
}

export interface ConceptExtractionJob {
  clusterIds: string[];
  subjectId: string;
}

export interface StatsRecomputeJob {
  subjectId: string;
}

export interface GenerateJob {
  kind: 'answer' | 'lesson';
  /** Content hash, never a surrogate id -- the caches are content-addressed. */
  contentHash: string;
  marksBand?: number;
  depth?: 'cram' | 'full';
  subjectId: string;
}

/** Stage transitions pushed to the client over WebSocket on channel paper:{id}. */
export type IngestStage =
  | 'queued'
  | 'extracted'
  | 'segmented'
  | 'embedded'
  | 'clustered'
  | 'enriched'
  | 'ready'
  | 'failed';

export interface IngestProgressEvent {
  paperId: string;
  stage: IngestStage;
  /** e.g. { questions: 26, clustersTouched: 4 } */
  counts: Record<string, number>;
  message: string | null;
  at: string;
}
