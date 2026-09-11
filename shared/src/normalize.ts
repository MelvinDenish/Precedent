/**
 * Content-hash normalization -- the idempotency guarantee.
 *
 * The dedupe key is a SHA-256 of the NORMALIZED extracted text, not of the
 * raw bytes. The same paper downloaded from two archives differs byte-wise
 * (different PDF producers, different compression, an added watermark), so
 * raw-byte hashing silently fails to dedupe and the corpus fills with
 * duplicates that inflate every recurrence count.
 *
 * See docs/ARCHITECTURE.md section 2.1.
 */

import { createHash } from 'node:crypto';

/** Lines that identify a sitting or a candidate, not the paper's content. */
const STRIP_PATTERNS: RegExp[] = [
  /^\s*page\s+\d+\s*(of\s+\d+)?\s*$/gim, // 'Page 3 of 8'
  /^\s*-?\s*\d+\s*-?\s*$/gm, // a bare page number on its own line
  /reg(?:ister)?\.?\s*(?:no|number)\.?\s*[:.]?\s*[A-Z0-9]*/gi,
  /roll\.?\s*(?:no|number)\.?\s*[:.]?\s*[A-Z0-9]*/gi,
  /seat\s*(?:no|number)\.?\s*[:.]?\s*[A-Z0-9]*/gi,
  /question\s+paper\s+code\s*[:.]?\s*[A-Z0-9]*/gi,
];

/**
 * lowercase -> strip identifiers -> collapse whitespace runs -> trim.
 *
 * Deliberately aggressive: two scans of one paper should collide even when
 * OCR disagrees about spacing or the archive stamped a registration number
 * across the header.
 */
export function normalizeForHash(text: string): string {
  let out = text.toLowerCase();
  for (const pattern of STRIP_PATTERNS) {
    out = out.replace(pattern, ' ');
  }
  out = out
    .replace(/[\u2018\u2019]/g, "'") // smart quotes differ between producers
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return out;
}

/** The value stored in papers.content_hash and used by UNIQUE (subject_id, content_hash). */
export function contentHash(text: string): string {
  return createHash('sha256').update(normalizeForHash(text), 'utf8').digest('hex');
}

/**
 * Cache key for answer_cache and lesson_cache.
 *
 * Content-addressed, never keyed on a surrogate id: clusters and concepts are
 * mutable by design, so an id key would orphan entries on merge and serve
 * stale content on split.
 */
export function cacheHash(text: string): string {
  return createHash('sha256').update(normalizeForHash(text), 'utf8').digest('hex');
}
