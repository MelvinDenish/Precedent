/**
 * The HTTP contract.
 *
 * Frozen after Phase 0 so the frontend wave can be built against it in
 * parallel with the API wave, without either waiting on the other's runtime.
 */

import type {
  AnswerEvaluation, Citation, Cluster, Concept, ConceptStats, ClusterStats,
  ExamType, LearnMode, LearnSession, Lesson, LessonDepth, Paper, Question,
  Regime, ReviewItem, Subject, SyllabusUnit, TutorMessage,
} from './domain.js';

export const API_PREFIX = '/api/v1';

// --- Errors ---------------------------------------------------------

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// --- Auth -----------------------------------------------------------

export interface RegisterRequest {
  email: string;
  password: string;
  displayName?: string;
  universityId?: string;
  regulationId?: string;
  /** Attributes, never corpus keys. */
  college?: string;
  dept?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: {
    userId: string;
    email: string;
    displayName: string | null;
    universityId: string | null;
    regulationId: string | null;
  };
}

// --- Upload ---------------------------------------------------------

export interface UploadResponse {
  paperId: string;
  /**
   * false when the content hash already existed. The upload is credited to
   * the contributor and nothing is reprocessed: 5 identical uploads produce
   * 1 paper row, 4 contributor credits, and 0 reprocessing.
   */
  created: boolean;
  jobId: string | null;
  status: Paper['status'];
}

// --- Corpus browsing ------------------------------------------------

export interface SubjectSummary extends Subject {
  paperCount: number;
  questionCount: number;
  clusterCount: number;
  conceptCount: number;
  regime: Regime | null;
  repetitionRate: number | null;
  /** Earliest and latest sitting present, for the corpus-depth caveat in the UI. */
  yearRange: [number, number] | null;
}

/**
 * Statistics default to the centrally-set end-semester slice, because mixing
 * a quiz MCQ with a 13-mark question corrupts the marks bands.
 */
export interface StatsScope {
  examTypes?: ExamType[];
  /** null selects centrally-set papers; omit for all colleges. */
  college?: string | null;
}

export interface AtlasResponse {
  subject: SubjectSummary;
  units: AtlasUnit[];
  concepts: AtlasConcept[];
  edges: { from: string; to: string; confidence: number }[];
  scope: StatsScope;
}

export interface AtlasUnit extends SyllabusUnit {
  expectedMarks: number;
  conceptIds: string[];
}

export interface AtlasConcept extends Concept {
  stats: ConceptStats;
  unitIds: string[];
  clusterCount: number;
}

/** Every number in the UI resolves to one of these. */
export interface ConceptDetailResponse {
  concept: Concept;
  stats: ConceptStats;
  units: SyllabusUnit[];
  clusters: ClusterWithEvidence[];
  prerequisites: Concept[];
  dependents: Concept[];
}

export interface ClusterWithEvidence {
  cluster: Cluster;
  stats: ClusterStats;
  /** paper -> year -> question number. The citation trail, always present. */
  instances: (Citation & { questionId: string; text: string })[];
}

// --- Learn Loop -----------------------------------------------------

export interface StartSessionRequest {
  subjectId: string;
  mode: LearnMode;
  /** Night Before only. The optimizer reserves ~15% of this for prerequisite hops. */
  budgetMin?: number;
}

export interface SessionStateResponse {
  session: LearnSession;
  /** Populated when state is TEACH. */
  lesson: Lesson | null;
  /** Populated when state is TEST -- a real past question, not a generated one. */
  test: {
    clusterId: string;
    canonicalText: string;
    marks: number;
    instances: Citation[];
  } | null;
  /**
   * Surfaced BEFORE the student is confused, not after they fail. The graph
   * already knows what this concept depends on and what they have covered.
   */
  prerequisiteWarning: {
    conceptId: string;
    conceptName: string;
    estimatedMin: number;
  } | null;
  progress: {
    conceptsDone: number;
    conceptsTotal: number;
    expectedMarksCovered: number;
    expectedMarksTotal: number;
    minutesSpent: number;
    minutesBudget: number | null;
  };
}

export interface SubmitAttemptRequest {
  sessionId?: string;
  clusterId: string;
  answerText: string;
}

export interface SubmitAttemptResponse {
  evaluation: AnswerEvaluation;
  /** Set when the evaluation triggered a prerequisite hop. */
  hoppedToConceptId: string | null;
}

// --- Tutor (Tier 2) -------------------------------------------------

export interface TutorStartRequest {
  conceptId?: string;
  clusterId?: string;
  sessionId?: string;
}

export interface TutorStartResponse {
  tutorSessionId: string;
  /** Context is injected at session start, not discovered: on a free tier an
   *  agent that explores costs you the demo. */
  injectedContext: {
    conceptName: string | null;
    clusterInstanceCount: number;
    prerequisiteChain: string[];
    minutesRemaining: number | null;
  };
  transcript: TutorMessage[];
}

export interface TutorMessageRequest {
  tutorSessionId: string;
  message: string;
}

/** SSE frame emitted by POST /tutor/message. */
export type TutorStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'citation'; citation: Citation }
  | { type: 'tool'; name: string }
  | { type: 'refusal'; reason: 'off_syllabus' | 'budget_exhausted'; message: string }
  | { type: 'done'; tokensUsed: number };

// --- Review queue ---------------------------------------------------

export interface ResolveReviewRequest {
  reviewId: string;
  decision: 'accept' | 'reject' | 'edit';
  /** For segmentation corrections: the corrected questions. */
  correction?: unknown;
  note?: string;
}

// --- Routes ---------------------------------------------------------

/**
 * Every route the API exposes. The frontend imports these rather than
 * hardcoding strings, so a path change is a type error rather than a 404
 * discovered at runtime.
 */
export const ROUTES = {
  health: 'GET /health',

  register: 'POST /auth/register',
  login: 'POST /auth/login',
  me: 'GET /auth/me',

  upload: 'POST /upload',
  paper: 'GET /papers/:paperId',
  paperQuestions: 'GET /papers/:paperId/questions',

  subjects: 'GET /subjects',
  subject: 'GET /subjects/:subjectId',
  atlas: 'GET /subjects/:subjectId/atlas',
  concept: 'GET /concepts/:conceptId',
  cluster: 'GET /clusters/:clusterId',

  answer: 'GET /clusters/:clusterId/answer',
  lesson: 'GET /concepts/:conceptId/lesson',

  startSession: 'POST /sessions',
  session: 'GET /sessions/:sessionId',
  advanceSession: 'POST /sessions/:sessionId/advance',
  attempt: 'POST /attempts',

  tutorStart: 'POST /tutor/start',
  tutorMessage: 'POST /tutor/message',

  reviewQueue: 'GET /review',
  resolveReview: 'POST /review/:reviewId/resolve',

  gapMap: 'GET /subjects/:subjectId/gaps',
  simulate: 'POST /subjects/:subjectId/simulate',
  due: 'GET /due',
} as const;

export type RouteKey = keyof typeof ROUTES;

/** Response shapes not already named above, keyed by route. */
export interface PaperDetailResponse {
  paper: Paper;
  questions: Question[];
}

export interface LessonResponse {
  lesson: Lesson;
  /** 1 when served from lesson_cache at zero token cost, 2 when generated. */
  tier: 0 | 1 | 2;
}

export interface AnswerResponse {
  body: string;
  sources: Citation[];
  marksBand: number;
  tier: 0 | 1 | 2;
}

export interface ReviewQueueResponse {
  items: ReviewItem[];
  openCount: number;
}
