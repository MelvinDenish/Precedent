/**
 * Types the API needs that the frozen shared contract does not yet declare.
 *
 * shared/ is frozen after Phase 0 precisely so concurrent waves cannot race
 * the contract, so anything new lands here and is promoted during the
 * inter-wave merge. Every export below is a promotion candidate; the report
 * lists them.
 */
import type { IngestProgressEvent } from '@precedent/shared';

// --- Auth -----------------------------------------------------------

/**
 * The JWT payload. Deliberately minimal: it is a bearer token a client can
 * read, so it carries an identity and nothing else. Everything about the user
 * that matters for authorization is re-read from the database per request.
 */
export interface JwtPayload {
  sub: string;
  email: string;
}

export interface AuthenticatedUser {
  userId: string;
  email: string;
}

// --- Upload ---------------------------------------------------------

/** Multipart fields accompanying the file on POST /upload. */
export interface UploadFields {
  subjectId: string;
  examYear: number;
  examSession: string | null;
  examType: string;
  college: string | null;
  paperSet: string | null;
}

/**
 * Result of the API's cheap text-layer read. Full extraction, vision fallback
 * and OCR quality gating all belong to the worker; this exists only to produce
 * a dedupe key.
 */
export interface CheapText {
  text: string;
  pageCount: number;
  /**
   * false when the text layer is missing or near-empty, which is the common
   * case: most of the corpus is image-only scans. The content hash then comes
   * from the bytes, because hashing empty text would make every scan in a
   * subject collide on UNIQUE (subject_id, content_hash).
   */
  hasTextLayer: boolean;
}

// --- WebSocket ------------------------------------------------------

/** Client -> server frames on the progress socket. */
export type WsClientMessage =
  | { type: 'subscribe'; channel: string }
  | { type: 'unsubscribe'; channel: string }
  | { type: 'ping' };

/** Server -> client frames on the progress socket. */
export type WsServerMessage =
  | { type: 'subscribed'; channel: string }
  | { type: 'unsubscribed'; channel: string }
  | { type: 'pong' }
  | { type: 'error'; message: string }
  | { type: 'progress'; channel: string; event: IngestProgressEvent };

// --- Queues ---------------------------------------------------------

/**
 * Rate limiters are keyed by PROVIDER, not by queue: Gemini quota is shared
 * across every queue that calls it, so a per-queue limiter permits N queues to
 * each spend the whole budget.
 */
export type ProviderName = 'gemini' | 'groq';

/** review_queue.payload for kind = 'dlq'. A dead job a human can act on. */
export interface DlqPayload {
  queue: string;
  jobId: string;
  jobName: string;
  attemptsMade: number;
  failedReason: string;
  data: unknown;
  failedAt: string;
}
