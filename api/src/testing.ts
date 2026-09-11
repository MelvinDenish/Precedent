/**
 * Test helpers. Not a .test.ts, so vitest does not collect it as a suite.
 *
 * The PDFs are built by hand rather than committed as fixtures because the
 * repository is public and .gitignore excludes *.pdf: the dedup tests need
 * two files that differ BYTE-wise while carrying the same text, which is
 * exactly the cross-archive case, and generating them makes that difference
 * explicit instead of hiding it inside a binary.
 */
import type { FastifyInstance } from 'fastify';
import { pool } from './db.js';
import { buildServer } from './server.js';

// --- PDF construction -----------------------------------------------

/** Wraps a raw content stream in a minimal single-page PDF. */
function buildPdf(contentStream: string, producer: string): Buffer {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
    `<< /Producer (${producer}) >>`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = pdf.length;
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

const escapePdfText = (s: string): string => s.replace(/[\\()]/g, (c) => `\\${c}`);

/** A PDF with a real, extractable text layer. */
export function makeTextPdf(lines: string[], producer = 'ArchiveOne'): Buffer {
  const body = lines.map((l) => `(${escapePdfText(l)}) Tj T*`).join('\n');
  return buildPdf(`BT\n/F1 11 Tf\n13 TL\n54 740 Td\n${body}\nET\n`, producer);
}

/**
 * A PDF with NO text layer, standing in for the image-only scans that are
 * most of this corpus. `seed` varies the drawing so two calls produce two
 * genuinely different files, which is the point of the collision test.
 */
export function makeScanPdf(seed: number, producer = 'ScannerOutput'): Buffer {
  const strokes = Array.from(
    { length: 6 },
    (_, i) => `${40 + seed * 7 + i * 11} ${90 + seed * 13 + i * 5} m ` +
      `${300 + seed * 3 + i * 17} ${400 + seed * 2 + i * 9} l S`,
  ).join('\n');
  return buildPdf(`0 0 0 RG\n2 w\n${strokes}\n`, `${producer}-${seed}`);
}

/**
 * Exam text long and ordinary enough to pass assessTextQuality(): it needs
 * 200+ characters, 50+ words, a high alphabetic ratio and a decent share of
 * common English words.
 */
export const SAMPLE_EXAM_LINES = [
  'B.E. DEGREE EXAMINATION, NOVEMBER 2024',
  'Fifth Semester Computer Science and Engineering',
  'CS23501 OPERATING SYSTEMS',
  'Answer all of the questions that are given in this paper.',
  'PART A',
  '1. Define a deadlock and list the conditions which are required for it to occur.',
  '2. What is the difference between a process and a thread in an operating system?',
  '3. State the purpose of a semaphore and describe how it is used by the kernel.',
  '4. Explain what is meant by thrashing and how it can be detected from the page rate.',
  'PART B',
  '11. (a) Explain paging with a diagram and discuss how the page table is organised.',
  '    (b) Describe the banker algorithm for deadlock avoidance with an example.',
  '12. (a) Compare the first fit and best fit allocation strategies for main memory.',
  '    (b) Discuss the role of the scheduler and the dispatcher in a modern system.',
];

// --- Multipart ------------------------------------------------------

export interface MultipartResult {
  payload: Buffer;
  headers: Record<string, string>;
}

/** Builds a multipart/form-data body for app.inject(). */
export function multipart(
  fields: Record<string, string>,
  file: { buffer: Buffer; filename: string; contentType?: string } | null,
): MultipartResult {
  const boundary = `----precedenttest${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }

  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.contentType ?? 'application/pdf'}\r\n\r\n`,
        'utf8',
      ),
      file.buffer,
      Buffer.from('\r\n', 'utf8'),
    );
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

// --- Fixtures -------------------------------------------------------

export interface TestCorpus {
  universityId: string;
  regulationId: string;
  subjectId: string;
  /** A second subject, for asserting that the hash is scoped per subject. */
  otherSubjectId: string;
}

let sequence = 0;
const unique = (): string => `${process.pid}-${Date.now()}-${sequence++}`;

/**
 * Creates an isolated university/regulation/subject triple. Seeded rows are
 * left alone: tests that mutated shared corpus rows would depend on whether
 * `npm run seed` had been run.
 */
export async function createTestCorpus(): Promise<TestCorpus> {
  const slug = `test-university-${unique()}`;
  const { rows: uni } = await pool.query<{ university_id: string }>(
    'INSERT INTO universities (name, slug) VALUES ($1, $2) RETURNING university_id',
    ['Test University', slug],
  );
  const universityId = String(uni[0]!.university_id);

  const { rows: reg } = await pool.query<{ regulation_id: string }>(
    'INSERT INTO regulations (university_id, code) VALUES ($1, $2) RETURNING regulation_id',
    [universityId, 'R2023'],
  );
  const regulationId = String(reg[0]!.regulation_id);

  const makeSubject = async (code: string, name: string): Promise<string> => {
    const { rows } = await pool.query<{ subject_id: string }>(
      `INSERT INTO subjects (university_id, regulation_id, code, name, semester)
       VALUES ($1, $2, $3, $4, 5) RETURNING subject_id`,
      [universityId, regulationId, code, name],
    );
    return String(rows[0]!.subject_id);
  };

  return {
    universityId,
    regulationId,
    subjectId: await makeSubject('CS23501', 'Operating Systems'),
    otherSubjectId: await makeSubject('CS23502', 'Networks and Data Communication'),
  };
}

/** Cascades to regulations, subjects, papers, questions and contributions. */
export async function dropTestCorpus(corpus: TestCorpus): Promise<void> {
  await pool.query('DELETE FROM universities WHERE university_id = $1', [corpus.universityId]);
}

export interface TestUser {
  userId: string;
  email: string;
  token: string;
}

export async function registerUser(app: FastifyInstance, label = 'student'): Promise<TestUser> {
  const email = `${label}-${unique()}@example.edu`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'a-sufficiently-long-password', displayName: label },
  });
  if (response.statusCode !== 201) {
    throw new Error(`registerUser failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json() as { token: string; user: { userId: string } };
  return { userId: body.user.userId, email, token: body.token };
}

export async function dropUsers(users: TestUser[]): Promise<void> {
  if (users.length === 0) return;
  await pool.query('DELETE FROM users WHERE user_id = ANY($1::bigint[])', [
    users.map((u) => u.userId),
  ]);
}

export const bearer = (user: TestUser): Record<string, string> => ({
  authorization: `Bearer ${user.token}`,
});

/** Background Redis consumers stay off; suites that need them say so. */
export function buildTestServer(): Promise<FastifyInstance> {
  return buildServer({ background: false });
}
