/**
 * S3 blob driver.
 *
 * Signs SigV4 by hand against fetch rather than pulling in @aws-sdk/client-s3.
 * The API makes exactly three S3 calls (HEAD, PUT, GET) with no streaming, no
 * multipart and no presigning, which is a few dozen lines here against several
 * megabytes of SDK in the API image -- and adding a dependency would mean
 * touching the root lockfile while other waves are running.
 */
import { createHash, createHmac } from 'node:crypto';
import type { BlobDriver, PutResult } from './driver.js';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';

export interface S3Options {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Set for MinIO or a test double; otherwise the real AWS endpoint is derived. */
  endpoint?: string | null;
}

const sha256Hex = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 escaping; S3 rejects the '!' '*' "'" '(' ')' that encodeURIComponent leaves. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export class S3BlobDriver implements BlobDriver {
  readonly name = 's3' as const;

  constructor(private readonly opts: S3Options) {}

  private get origin(): string {
    return (
      this.opts.endpoint ?? `https://${this.opts.bucket}.s3.${this.opts.region}.amazonaws.com`
    );
  }

  /** Path-style for a custom endpoint (MinIO), virtual-host style for real AWS. */
  private pathFor(key: string): string {
    const encoded = key.split('/').map(uriEncode).join('/');
    return this.opts.endpoint ? `/${this.opts.bucket}/${encoded}` : `/${encoded}`;
  }

  private async send(
    method: 'GET' | 'PUT' | 'HEAD',
    key: string,
    body?: Buffer,
    contentType?: string,
  ): Promise<Response> {
    const url = new URL(this.origin);
    url.pathname = this.pathFor(key);

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(body ?? '');

    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (contentType) headers['content-type'] = contentType;

    const signedHeaders = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaders.map((h) => `${h}:${headers[h]}\n`).join('');
    const signedHeaderList = signedHeaders.join(';');

    const canonicalRequest = [
      method,
      url.pathname,
      '', // no query string is ever sent
      canonicalHeaders,
      signedHeaderList,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${this.opts.region}/${SERVICE}/aws4_request`;
    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

    const signingKey = ['aws4_request'].reduce(
      (k, part) => hmac(k, part),
      hmac(hmac(hmac(`AWS4${this.opts.secretAccessKey}`, dateStamp), this.opts.region), SERVICE),
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    headers['authorization'] =
      `${ALGORITHM} Credential=${this.opts.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaderList}, Signature=${signature}`;

    return fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined });
  }

  private locator(key: string): string {
    return `s3://${this.opts.bucket}/${key}`;
  }

  async putIfAbsent(key: string, bytes: Buffer, contentType: string): Promise<PutResult> {
    if (await this.exists(key)) return { url: this.locator(key), created: false };

    const res = await this.send('PUT', key, bytes, contentType);
    if (!res.ok) {
      throw new Error(`s3 put failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
    return { url: this.locator(key), created: true };
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.send('HEAD', key);
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`s3 head failed: ${res.status}`);
    return true;
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await this.send('GET', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`s3 get failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
