/**
 * Runtime validation. Fastify validates requests against these, and the
 * structured-output LLM calls validate their responses against them too --
 * a model that returns malformed JSON must fail loudly, not silently write
 * nulls into the corpus.
 */

import { z } from 'zod';

export const examTypeSchema = z.enum([
  'endsem', 'assessment', 'quiz', 'supplementary', 'retest',
]);

export const textSourceSchema = z.enum(['digital', 'vision', 'dirty_ocr_recovered']);
export const lessonDepthSchema = z.enum(['cram', 'full']);
export const learnModeSchema = z.enum(['night_before', 'mastery']);
export const regimeSchema = z.enum(['high', 'medium', 'low']);

// --- Auth -----------------------------------------------------------

export const registerSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(10).max(200),
  displayName: z.string().max(120).optional(),
  universityId: z.string().optional(),
  regulationId: z.string().optional(),
  college: z.string().max(200).optional(),
  dept: z.string().max(80).optional(),
});

export const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

// --- Segmentation ---------------------------------------------------

/**
 * The structured output the vision extractor is required to return. Shared
 * with the rule segmenter so both paths are validated identically.
 */
export const segmentedQuestionSchema = z.object({
  part: z.enum(['A', 'B', 'C']).nullable(),
  qNumber: z.string().min(1).max(20),
  partLabel: z.string().max(20).nullable(),
  text: z.string().min(1),
  marks: z.number().int().min(0).max(100).nullable(),
  orGroupId: z.number().int().nullable(),
  coCode: z.number().int().min(1).max(12).nullable(),
  blLevel: z.number().int().min(1).max(6).nullable(),
  pageNo: z.number().int().min(1).nullable(),
  confidence: z.number().min(0).max(1),
});

export const paperMetadataSchema = z.object({
  subjectCode: z.string().max(40).nullable(),
  subjectName: z.string().max(200).nullable(),
  regulationCode: z.string().max(40).nullable(),
  examYear: z.number().int().min(1990).max(2100).nullable(),
  examSession: z.string().max(20).nullable(),
  examType: examTypeSchema.nullable(),
  college: z.string().max(20).nullable(),
  paperSet: z.string().max(10).nullable(),
  semester: z.number().int().min(1).max(12).nullable(),
  totalMarks: z.number().int().min(0).max(1000).nullable(),
});

export const paperTemplateSchema = z.object({
  totalMarks: z.number().int().min(0).max(1000),
  parts: z.array(
    z.object({
      part: z.enum(['A', 'B', 'C']),
      slotCount: z.number().int().min(1),
      marksPerSlot: z.number().int().min(1),
      hasChoice: z.boolean(),
      note: z.string().nullable(),
    }),
  ),
});

export const segmentationResultSchema = z.object({
  metadata: paperMetadataSchema,
  template: paperTemplateSchema.nullable(),
  questions: z.array(segmentedQuestionSchema),
  method: z.enum(['rules', 'vision', 'llm_fallback']),
  overallConfidence: z.number().min(0).max(1),
  warnings: z.array(z.string()),
});

// --- Adjudicator ----------------------------------------------------

/**
 * The Adjudicator agent's output. The gate reads `confidence` and routes:
 * above 0.85 auto-apply, 0.60-0.85 review queue, below 0.60 auto-reject.
 * The OR-pair prohibition is enforced in CODE before and after this call --
 * never in the prompt.
 */
export const adjudicationSchema = z.object({
  decision: z.enum(['same', 'variant', 'different']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1),
  evidenceIds: z.array(z.string()),
});

// --- Concepts -------------------------------------------------------

export const conceptExtractionSchema = z.object({
  concepts: z.array(
    z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(2000),
      /** Multi-label: one question can test several concepts. */
      weight: z.number().min(0).max(1),
    }),
  ),
});

export const prerequisiteProposalSchema = z.object({
  edges: z.array(
    z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      confidence: z.number().min(0).max(1),
      rationale: z.string(),
    }),
  ),
});

// --- Generation -----------------------------------------------------

export const citationSchema = z.object({
  paperId: z.string(),
  examYear: z.number().int(),
  examSession: z.string().nullable(),
  examType: examTypeSchema,
  college: z.string().nullable(),
  qNumber: z.string(),
  partLabel: z.string().nullable(),
  marks: z.number().int().nullable(),
  sourceTitle: z.string().optional(),
});

export const gapFlagSchema = z.object({
  topic: z.string(),
  missingFrom: z.array(z.enum(['syllabus', 'notes', 'textbook', 'corpus'])),
  note: z.string(),
});

export const lessonGenerationSchema = z.object({
  body: z.string().min(1),
  sources: z.array(citationSchema),
  /** Non-empty means the sources did not cover the topic. Flagging beats inventing. */
  gapFlags: z.array(gapFlagSchema),
});

export const answerEvaluationSchema = z.object({
  score: z.number().min(0),
  maxScore: z.number().min(0),
  points: z.array(
    z.object({
      point: z.string(),
      awarded: z.number().min(0),
      possible: z.number().min(0),
      conceptId: z.string().nullable(),
      comment: z.string(),
    }),
  ),
  missedConceptIds: z.array(z.string()),
});

// --- Sessions -------------------------------------------------------

export const startSessionSchema = z.object({
  subjectId: z.string().min(1),
  mode: learnModeSchema,
  budgetMin: z.number().int().min(15).max(1440).optional(),
});

export const submitAttemptSchema = z.object({
  sessionId: z.string().optional(),
  clusterId: z.string().min(1),
  answerText: z.string().min(1).max(20000),
});

export const tutorMessageSchema = z.object({
  tutorSessionId: z.string().min(1),
  message: z.string().min(1).max(4000),
});
