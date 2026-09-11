/**
 * Blob driver selection, by BLOB_DRIVER.
 */
import { config } from '../config.js';
import type { BlobDriver } from './driver.js';
import { LocalBlobDriver } from './local.js';
import { S3BlobDriver } from './s3.js';

export { blobKey } from './driver.js';
export type { BlobDriver, PutResult } from './driver.js';

export function createBlobDriver(): BlobDriver {
  if (config.blob.driver === 's3') {
    const { bucket, accessKeyId, secretAccessKey, region, endpoint } = config.blob;
    // Fail at construction, not on the first upload: a misconfigured bucket
    // should stop a deploy, not surface as a 500 to the student who happened
    // to be the first to contribute a paper.
    if (!bucket) throw new Error('BLOB_DRIVER=s3 requires S3_BUCKET.');
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('BLOB_DRIVER=s3 requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.');
    }
    return new S3BlobDriver({ bucket, region, accessKeyId, secretAccessKey, endpoint });
  }
  return new LocalBlobDriver(config.blob.localDir);
}

let cached: BlobDriver | null = null;

/** Single instance per process; the drivers are stateless and cheap to share. */
export function blobStore(): BlobDriver {
  cached ??= createBlobDriver();
  return cached;
}
