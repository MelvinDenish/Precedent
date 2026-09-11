/**
 * Blob storage driver contract.
 *
 * Uploaded PDFs are stored but NEVER redistributed by the API: only extracted
 * question text and citations are served. Nothing in api/src/routes reads a
 * blob back. `get` exists for the worker, which must fetch the bytes it was
 * asked to extract.
 */

export interface PutResult {
  /** Durable locator written to papers.blob_url: file://... or s3://bucket/key. */
  url: string;
  /** false when an object already occupied the key and the bytes were left alone. */
  created: boolean;
}

export interface BlobDriver {
  readonly name: 'local' | 's3';

  /**
   * Writes bytes only when the key is free, and reports which happened.
   *
   * Put-if-absent rather than put, because keys are content-addressed on the
   * NORMALIZED text hash: two archives' copies of one paper differ byte-wise
   * but share a key, so a plain put would let a later contributor's upload
   * silently overwrite the stored original behind an existing citation trail.
   */
  putIfAbsent(key: string, bytes: Buffer, contentType: string): Promise<PutResult>;

  exists(key: string): Promise<boolean>;

  get(key: string): Promise<Buffer | null>;
}

/**
 * Content-addressed, and scoped by subject because the uniqueness constraint
 * is UNIQUE (subject_id, content_hash) -- the same hash under two subjects is
 * two different papers.
 */
export function blobKey(subjectId: string, contentHash: string): string {
  return `papers/${subjectId}/${contentHash}.pdf`;
}
