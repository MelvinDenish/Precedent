/**
 * Corpus read routes: GET /subjects, /subjects/:subjectId, /papers/:paperId,
 * /papers/:paperId/questions.
 *
 * Every table touched here is part of the SHARED graph, which carries no
 * user_id at all -- so these routes are public to any authenticated student
 * and there is nothing to scope. That is the point of the split: the
 * possibility of leaking another student's notes, attempts or mastery is
 * removed structurally rather than guarded per query.
 *
 * Note what is NOT served: papers.blob_url. Uploaded PDFs are stored but
 * never redistributed by the API. Only extracted question text and citations
 * leave this process.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  Paper,
  PaperDetailResponse,
  Question,
  Regime,
  SubjectSummary,
} from '@precedent/shared';
import { pool } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { makeRequireAuth } from '../auth/guard.js';

const idSchema = z.string().regex(/^\d+$/);

interface SubjectRow {
  subject_id: string;
  university_id: string;
  regulation_id: string;
  code: string;
  name: string;
  semester: number | null;
  paper_count: number;
  question_count: number;
  cluster_count: number;
  concept_count: number;
  regime: string | null;
  repetition_rate: string | null;
  min_year: number | null;
  max_year: number | null;
}

function toSubjectSummary(row: SubjectRow): SubjectSummary {
  return {
    subjectId: String(row.subject_id),
    universityId: String(row.university_id),
    regulationId: String(row.regulation_id),
    code: row.code,
    name: row.name,
    semester: row.semester,
    paperCount: row.paper_count,
    questionCount: row.question_count,
    clusterCount: row.cluster_count,
    conceptCount: row.concept_count,
    regime: (row.regime as Regime | null) ?? null,
    repetitionRate: row.repetition_rate === null ? null : Number(row.repetition_rate),
    // Surfaced so the UI can state the corpus depth rather than implying that
    // three papers support the same confidence as fifteen.
    yearRange:
      row.min_year === null || row.max_year === null ? null : [row.min_year, row.max_year],
  };
}

/**
 * Counts come from correlated subqueries rather than a chain of LEFT JOINs.
 * Joining papers, questions, clusters and concepts in one statement multiplies
 * the rows together and every count(DISTINCT ...) then has to undo the damage.
 */
const SUBJECT_SELECT = `
  SELECT s.subject_id,
         s.university_id,
         s.regulation_id,
         s.code,
         s.name,
         s.semester,
         (SELECT count(*)::int FROM papers p WHERE p.subject_id = s.subject_id)
           AS paper_count,
         (SELECT count(*)::int FROM questions q
             JOIN papers p2 ON p2.paper_id = q.paper_id
            WHERE p2.subject_id = s.subject_id) AS question_count,
         (SELECT count(*)::int FROM clusters c WHERE c.subject_id = s.subject_id)
           AS cluster_count,
         (SELECT count(*)::int FROM concepts co WHERE co.subject_id = s.subject_id)
           AS concept_count,
         sr.regime,
         sr.repetition_rate,
         (SELECT min(p3.exam_year)::int FROM papers p3 WHERE p3.subject_id = s.subject_id)
           AS min_year,
         (SELECT max(p4.exam_year)::int FROM papers p4 WHERE p4.subject_id = s.subject_id)
           AS max_year
    FROM subjects s
    LEFT JOIN subject_regime sr ON sr.subject_id = s.subject_id
`;

interface PaperRow {
  paper_id: string;
  subject_id: string;
  exam_session: string | null;
  exam_year: number;
  exam_type: string;
  college: string | null;
  paper_set: string | null;
  content_hash: string;
  text_source: string;
  page_count: number | null;
  status: string;
  template: unknown;
  created_at: Date | string;
}

function toPaper(row: PaperRow): Paper {
  return {
    paperId: String(row.paper_id),
    subjectId: String(row.subject_id),
    examSession: row.exam_session,
    examYear: row.exam_year,
    examType: row.exam_type as Paper['examType'],
    college: row.college,
    paperSet: row.paper_set,
    contentHash: row.content_hash,
    textSource: row.text_source as Paper['textSource'],
    // Never served. The stored original exists for the citation trail, not
    // for redistribution.
    blobUrl: null,
    pageCount: row.page_count,
    status: row.status as Paper['status'],
    template: (row.template as Paper['template']) ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

interface QuestionRow {
  question_id: string;
  paper_id: string;
  q_number: string;
  part_label: string | null;
  part: string | null;
  text: string;
  marks: number | null;
  or_group_id: number | null;
  co_code: number | null;
  bl_level: number | null;
  unit_hint: number | null;
  page_no: number | null;
  seg_confidence: string | null;
}

function toQuestion(row: QuestionRow): Question {
  return {
    questionId: String(row.question_id),
    paperId: String(row.paper_id),
    qNumber: row.q_number,
    partLabel: row.part_label,
    part: (row.part as Question['part']) ?? null,
    text: row.text,
    marks: row.marks,
    // Per-paper, and only meaningful together with paperId.
    orGroupId: row.or_group_id,
    coCode: row.co_code,
    blLevel: row.bl_level,
    unitHint: row.unit_hint,
    pageNo: row.page_no,
    segConfidence: row.seg_confidence === null ? null : Number(row.seg_confidence),
  };
}

const QUESTION_SELECT = `
  SELECT question_id, paper_id, q_number, part_label, part, text, marks,
         or_group_id, co_code, bl_level, unit_hint, page_no, seg_confidence
    FROM questions
   WHERE paper_id = $1
   ORDER BY part NULLS LAST,
            -- q_number is text ('11', '9', '10'); sorting it as text puts 10
            -- before 9 and scrambles the paper's own ordering.
            NULLIF(regexp_replace(q_number, '\\D', '', 'g'), '')::int NULLS LAST,
            q_number,
            part_label NULLS FIRST
`;

export function registerCorpusRoutes(app: FastifyInstance): void {
  const requireAuth = makeRequireAuth(app);

  app.get('/subjects', { onRequest: requireAuth }, async () => {
    const { rows } = await pool.query<SubjectRow>(`${SUBJECT_SELECT} ORDER BY s.code`);
    return rows.map(toSubjectSummary);
  });

  app.get('/subjects/:subjectId', { onRequest: requireAuth }, async (request) => {
    const { subjectId } = request.params as { subjectId: string };
    if (!idSchema.safeParse(subjectId).success) throw badRequest('subjectId must be numeric.');

    const { rows } = await pool.query<SubjectRow>(
      `${SUBJECT_SELECT} WHERE s.subject_id = $1`,
      [subjectId],
    );
    const row = rows[0];
    if (!row) throw notFound(`No subject ${subjectId}.`);
    return toSubjectSummary(row);
  });

  app.get('/papers/:paperId', { onRequest: requireAuth }, async (request) => {
    const { paperId } = request.params as { paperId: string };
    if (!idSchema.safeParse(paperId).success) throw badRequest('paperId must be numeric.');

    const { rows } = await pool.query<PaperRow>(
      `SELECT paper_id, subject_id, exam_session, exam_year, exam_type, college,
              paper_set, content_hash, text_source, page_count, status, template,
              created_at
         FROM papers WHERE paper_id = $1`,
      [paperId],
    );
    const row = rows[0];
    if (!row) throw notFound(`No paper ${paperId}.`);

    const { rows: questionRows } = await pool.query<QuestionRow>(QUESTION_SELECT, [paperId]);
    const body: PaperDetailResponse = {
      paper: toPaper(row),
      questions: questionRows.map(toQuestion),
    };
    return body;
  });

  app.get('/papers/:paperId/questions', { onRequest: requireAuth }, async (request) => {
    const { paperId } = request.params as { paperId: string };
    if (!idSchema.safeParse(paperId).success) throw badRequest('paperId must be numeric.');

    const { rows: exists } = await pool.query('SELECT 1 FROM papers WHERE paper_id = $1', [
      paperId,
    ]);
    if (exists.length === 0) throw notFound(`No paper ${paperId}.`);

    const { rows } = await pool.query<QuestionRow>(QUESTION_SELECT, [paperId]);
    return rows.map(toQuestion);
  });
}
