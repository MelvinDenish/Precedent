/**
 * Web-local types.
 *
 * `shared/` is frozen, so anything the frontend needed that the contract does
 * not name is declared here and reported for promotion at the inter-wave
 * merge. Nothing in this file should survive long: each entry is either a real
 * hole in the contract or a purely presentational type.
 *
 * PROMOTION CANDIDATES (in priority order):
 *   1. UploadRequestFields - `ROUTES.upload` is `POST /upload` with NO request
 *      type in contract.ts. These multipart field names are invented here. If
 *      the API wave picks different names the upload screen breaks silently,
 *      so this is the single highest-value thing to reconcile.
 *   2. WS_CHANNEL / IngestSocketFrame - jobs.ts documents the channel as
 *      `paper:{id}` but names neither the socket URL nor the subscribe frame.
 *   3. ListSubjectsResponse / MeResponse - `ROUTES.subjects` and `ROUTES.me`
 *      have no named response type. Inferred here from adjacent types.
 */

import type { ExamType, IngestProgressEvent, SubjectSummary, AuthResponse } from '@precedent/shared';

/* -------------------------------------------------------------------------
   1. Upload request  (PROMOTE)
   ------------------------------------------------------------------------- */

/**
 * Multipart field names for `POST /upload`. The file part is `file`; the rest
 * are string form fields. `college` omitted means "centrally set", matching
 * `Paper.college === null`.
 */
export interface UploadRequestFields {
  subjectId: string;
  examYear: number;
  examType: ExamType;
  examSession?: string;
  college?: string;
  paperSet?: string;
}

export const UPLOAD_FILE_FIELD = 'file' as const;

/* -------------------------------------------------------------------------
   2. Ingest socket  (PROMOTE)
   ------------------------------------------------------------------------- */

/** Channel name for a paper's ingest progress. Documented in jobs.ts prose. */
export function ingestChannel(paperId: string): string {
  return `paper:${paperId}`;
}

/** Frame the client sends to join a channel. */
export interface IngestSubscribeFrame {
  type: 'subscribe';
  channel: string;
}

/** Frame the server pushes. `event` is the contract's IngestProgressEvent. */
export interface IngestSocketFrame {
  type: 'ingest';
  channel: string;
  event: IngestProgressEvent;
}

/* -------------------------------------------------------------------------
   3. Unnamed response shapes  (PROMOTE)
   ------------------------------------------------------------------------- */

export type ListSubjectsResponse = SubjectSummary[];
export type MeResponse = AuthResponse['user'];

/* -------------------------------------------------------------------------
   Presentational only - these should NOT be promoted.
   ------------------------------------------------------------------------- */

export type ThemeChoice = 'system' | 'light' | 'dark';

/** Certainty is a presentation axis, not a domain one. See DESIGN.md. */
export type Certainty = 'established' | 'provisional' | 'unknown';

export type ToastTone = 'neutral' | 'positive' | 'danger';

export interface Toast {
  id: string;
  title: string;
  body?: string;
  tone: ToastTone;
  /** ms; 0 keeps it until dismissed. */
  duration: number;
}

/** One row of the upload screen: a local file plus everything we learn about it. */
export interface UploadItem {
  localId: string;
  fileName: string;
  fileSize: number;
  meta: UploadRequestFields;
  state: 'draft' | 'uploading' | 'tracking' | 'done' | 'error';
  paperId: string | null;
  /** false = the content hash already existed; credited, not reprocessed. */
  created: boolean | null;
  events: IngestProgressEvent[];
  error: string | null;
}
