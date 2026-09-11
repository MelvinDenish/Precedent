/**
 * POST /upload -- the idempotent ingestion entry point, and the only one.
 *
 * The order below is deliberate and differs slightly from the sketch in
 * ARCHITECTURE.md section 2, which stores the bytes first:
 *
 *   1. read the file
 *   2. cheap text-layer extraction (NOT full extraction -- that is S1's job)
 *   3. content hash: normalized text where the text layer is usable,
 *      raw bytes where it is not (see pdf/text.ts for why this matters)
 *   4. store the bytes under a CONTENT-ADDRESSED key, if absent
 *   5. INSERT ... ON CONFLICT (subject_id, content_hash) DO NOTHING
 *   6. already present -> credit the contributor and STOP. No reprocessing.
 *   7. otherwise enqueue the ingest job and return 202.
 *
 * The blob key derives from the hash, so hashing has to come first; the
 * payoff is that five uploads of one paper write one object instead of five
 * orphans. The write still precedes the INSERT, because a papers row whose
 * blob_url points at nothing can never heal itself: every later upload of
 * that paper returns created:false and skips the store.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  QUEUES,
  examTypeSchema,
  type ExtractJob,
  type IngestProgressEvent,
  type UploadResponse,
} from '@precedent/shared';
import { pool, withTransaction } from '../db.js';
import { badRequest, notFound, payloadTooLarge, unsupportedMedia } from '../errors.js';
import { authOf, makeRequireAuth } from '../auth/guard.js';
import { blobKey, blobStore } from '../blob/index.js';
import { extractCheapText, looksLikePdf, paperContentHash } from '../pdf/text.js';
import { forUser } from '../private-db.js';
import { queue } from '../queue/index.js';
import { publishProgress } from '../ws/progress.js';
import { config } from '../config.js';

const fieldsSchema = z.object({
  subjectId: z.string().regex(/^\d+$/, 'subjectId must be a numeric id'),
  examYear: z.coerce.number().int().min(1990).max(2100),
  examSession: z.string().max(20).nullable().default(null),
  examType: examTypeSchema.default('endsem'),
  /** NULL means centrally set by the university, which is the common case. */
  college: z.string().max(20).nullable().default(null),
  paperSet: z.string().max(10).nullable().default(null),
});

interface ParsedUpload {
  bytes: Buffer;
  filename: string;
  fields: z.infer<typeof fieldsSchema>;
}

async function parseMultipart(request: FastifyRequest): Promise<ParsedUpload> {
  const raw: Record<string, string> = {};
  let bytes: Buffer | null = null;
  let filename = 'upload.pdf';

  // parts() rather than file(): file() only exposes fields that arrived
  // BEFORE the file part, which makes the contract depend on how the client
  // happened to order its form.
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (bytes) throw badRequest('Exactly one file may be uploaded per request.');
      filename = part.filename || filename;
      bytes = await part.toBuffer();
      if (part.file.truncated) {
        throw payloadTooLarge(`The file exceeds ${config.upload.maxBytes} bytes.`);
      }
    } else if (typeof part.value === 'string') {
      raw[part.fieldname] = part.value;
    }
  }

  if (!bytes) throw badRequest('A PDF file part is required.');

  const parsed = fieldsSchema.safeParse({
    subjectId: raw['subjectId'],
    examYear: raw['examYear'],
    examSession: raw['examSession'] ?? null,
    examType: raw['examType'] ?? undefined,
    college: raw['college'] ?? null,
    paperSet: raw['paperSet'] ?? null,
  });
  if (!parsed.success) throw badRequest('Invalid upload fields.', parsed.error.flatten());

  return { bytes, filename, fields: parsed.data };
}

export function registerUploadRoute(app: FastifyInstance): void {
  const requireAuth = makeRequireAuth(app);

  app.post(
    '/upload',
    {
      onRequest: requireAuth,
      config: {
        rateLimit: {
          max: config.upload.ratePerWindow,
          timeWindow: config.upload.rateWindow,
          /**
           * Per user, not per IP. A whole college behind one campus NAT would
           * otherwise share a single allowance.
           *
           * request.auth is preferred but may not be set yet: @fastify/rate-limit
           * keys in onRequest, and hook ordering between the plugin and this
           * route is not something to depend on. The bearer token is a stable
           * per-user value available on the raw request either way, and it is
           * hashed so that tokens never reach the limiter's Redis keys or logs.
           */
          keyGenerator: (request: FastifyRequest) => {
            if (request.auth?.userId) return `user:${request.auth.userId}`;
            const header = request.headers.authorization;
            if (header) {
              return `token:${createHash('sha256').update(header).digest('hex').slice(0, 32)}`;
            }
            return `ip:${request.ip}`;
          },
        },
      },
    },
    async (request, reply) => {
      const { userId } = authOf(request);
      const { bytes, filename, fields } = await parseMultipart(request);

      if (!looksLikePdf(bytes)) {
        throw unsupportedMedia('Only PDF uploads are accepted.');
      }

      // Checked before anything is written: the FK would fail at INSERT
      // anyway, but only after a pointless parse and a blob write.
      const { rows: subjectRows } = await pool.query<{ subject_id: string }>(
        'SELECT subject_id FROM subjects WHERE subject_id = $1',
        [fields.subjectId],
      );
      if (subjectRows.length === 0) throw notFound(`No subject ${fields.subjectId}.`);

      let cheap;
      try {
        cheap = await extractCheapText(bytes);
      } catch (err) {
        request.log.warn({ err, filename }, 'cheap text extraction failed');
        throw badRequest('The file could not be read as a PDF.');
      }

      const { hash, provisional, reason } = paperContentHash(bytes, cheap);

      const key = blobKey(fields.subjectId, hash);
      const stored = await blobStore().putIfAbsent(key, bytes, 'application/pdf');

      /**
       * text_source doubles as the provisional-hash marker, which avoids a
       * migration in a schema this wave does not own.
       *
       * THE INVARIANT, as the worker must read it: the value written HERE, at
       * insert time, is what marks the hash.
       *
       *   'digital' -> content_hash is the normalized-text hash. Final.
       *   'vision'  -> content_hash is the raw-byte fallback, and PROVISIONAL.
       *
       * Note the trigger is not "the worker ran vision". The API assesses the
       * cheap pdfjs text-layer read; S1 assesses its own, better extraction,
       * and the two are different strings that can disagree. A paper can be
       * inserted 'vision' and later be found to have usable text by S1 -- it
       * still carries a byte hash and still needs re-hashing. So the rule for
       * the worker is: if the paper was inserted with text_source='vision',
       * re-hash on whatever text S1 finally produced, by whichever path, and
       * UPDATE content_hash.
       *
       * If that UPDATE hits UNIQUE (subject_id, content_hash) it has found a
       * cross-archive duplicate. Merge toward the EXISTING row, and move the
       * credits BEFORE deleting anything -- paper_contributions.paper_id is
       * ON DELETE CASCADE, so dropping the losing paper first would destroy
       * the very contributions being preserved:
       *
       *   INSERT INTO paper_contributions (paper_id, user_id)
       *   SELECT $winner, user_id FROM paper_contributions WHERE paper_id = $loser
       *   ON CONFLICT DO NOTHING;
       *   DELETE FROM papers WHERE paper_id = $loser;
       *
       * The worker already knows which papers these are, so no job-body
       * change is needed.
       */
      const textSource = provisional ? 'vision' : 'digital';

      const result = await withTransaction(async (tx) => {
        const { rows } = await tx.query<{ paper_id: string; status: string }>(
          `INSERT INTO papers
             (subject_id, exam_session, exam_year, exam_type, college, paper_set,
              content_hash, text_source, blob_url, page_count, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued')
           ON CONFLICT (subject_id, content_hash) DO NOTHING
           RETURNING paper_id, status`,
          [
            fields.subjectId,
            fields.examSession,
            fields.examYear,
            fields.examType,
            fields.college,
            fields.paperSet,
            hash,
            textSource,
            stored.url,
            cheap.pageCount,
          ],
        );

        const inserted = rows[0];
        if (inserted) {
          const paperId = String(inserted.paper_id);

          /**
           * Enqueued INSIDE the transaction, before COMMIT, and the ordering
           * is chosen for which failure it leaves behind.
           *
           * Enqueue-then-commit: if the enqueue throws, the insert rolls back
           * and the client can simply retry. If the commit then fails, a job
           * references a paper that does not exist -- the worker fails it,
           * retries, and it lands in the review queue. Loud and recoverable.
           *
           * Commit-then-enqueue: a failed enqueue leaves a papers row that
           * nothing will ever process, and because the row exists, every
           * later upload of that paper returns created:false and skips the
           * enqueue too. The paper is permanently stuck with no error
           * anywhere. That is the worse failure, so it is the one designed
           * out.
           */
          const job: ExtractJob = { paperId, blobUrl: stored.url };
          // Deterministic, so a client retrying a timed-out upload cannot
          // start a second extraction of the same paper. BullMQ rejects ':'
          // in a custom job id.
          const jobId = `extract-${paperId}`;
          await queue(QUEUES.ingest).add('extract', job, { jobId });

          return { paperId, status: inserted.status, created: true, jobId };
        }

        // The paper is already in the corpus. Credit the contributor and
        // stop: no re-extraction, no re-segmentation, no re-clustering.
        //
        // Only this path writes paper_contributions. The first uploader is
        // recorded by the papers row itself, so five uploads of one paper by
        // five students produce one paper row and four contribution credits.
        const { rows: existingRows } = await tx.query<{ paper_id: string; status: string }>(
          'SELECT paper_id, status FROM papers WHERE subject_id = $1 AND content_hash = $2',
          [fields.subjectId, hash],
        );
        const existing = existingRows[0];
        if (!existing) {
          // ON CONFLICT found a row that this SELECT cannot: only reachable
          // if the paper was deleted between the two statements.
          throw new Error('upload: conflicting paper vanished mid-transaction');
        }
        await forUser(userId, tx).creditContribution(existing.paper_id);
        return {
          paperId: String(existing.paper_id),
          status: existing.status,
          created: false,
          jobId: null,
        };
      });

      if (!result.created) {
        const body: UploadResponse = {
          paperId: result.paperId,
          created: false,
          jobId: null,
          status: result.status as UploadResponse['status'],
        };
        request.log.info(
          { paperId: result.paperId, blobCreated: stored.created },
          'duplicate upload credited; nothing reprocessed',
        );
        return reply.status(200).send(body);
      }

      const event: IngestProgressEvent = {
        paperId: result.paperId,
        stage: 'queued',
        counts: { pages: cheap.pageCount },
        message: provisional ? `queued for vision extraction: ${reason}` : 'queued',
        at: new Date().toISOString(),
      };
      await publishProgress(event).catch((err: unknown) => {
        // Progress is a nicety; losing the event must not fail the upload,
        // which has already been durably recorded.
        request.log.warn({ err }, 'failed to publish queued progress event');
      });

      const body: UploadResponse = {
        paperId: result.paperId,
        created: true,
        jobId: result.jobId,
        status: 'queued',
      };
      return reply.status(202).send(body);
    },
  );
}

