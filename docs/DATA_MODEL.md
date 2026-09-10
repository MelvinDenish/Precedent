# Precedent — Data Model

Postgres 16 + pgvector. One database, two access regimes.

---

## 1. The public/private split

This is the most important structural rule in the schema.

| | Shared graph | Private user data |
|---|---|---|
| Contains | papers, questions, clusters, concepts, syllabus units, statistics, canonical answers, lessons | uploaded notes, attempts, mastery, learn sessions, tutor transcripts, personalized answers |
| Keyed by | `(university, regulation, subject_code)` | `user_id` |
| Carries `user_id`? | **No** (except contribution credits) | **Always** |
| Visible to | everyone studying that subject | only the owner |

**Enforcement:** shared tables have no `user_id` column at all, so a query cannot accidentally leak one student's data into another's view. Private tables always filter by the authenticated user. The split is structural, not a convention.

---

## 2. Corpus scoping

```sql
CREATE TABLE universities (
  university_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,
  slug          VARCHAR(80)  NOT NULL UNIQUE
);

CREATE TABLE regulations (
  regulation_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  university_id  BIGINT NOT NULL REFERENCES universities ON DELETE CASCADE,
  code           VARCHAR(40) NOT NULL,        -- 'R2021', 'R2017'
  effective_from DATE,
  effective_to   DATE,
  UNIQUE (university_id, code)
);

-- THE CORPUS KEY. One shared master graph per row here.
CREATE TABLE subjects (
  subject_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  university_id BIGINT NOT NULL REFERENCES universities ON DELETE CASCADE,
  regulation_id BIGINT NOT NULL REFERENCES regulations  ON DELETE CASCADE,
  code          VARCHAR(40)  NOT NULL,        -- 'CS3492'
  name          VARCHAR(200) NOT NULL,
  semester      SMALLINT,
  UNIQUE (university_id, regulation_id, code)
);

-- Links a subject across a syllabus revision, so R2017 papers can
-- inform R2021 predictions at a discount.
CREATE TABLE subject_lineage (
  ancestor_subject_id BIGINT NOT NULL REFERENCES subjects ON DELETE CASCADE,
  successor_subject_id BIGINT NOT NULL REFERENCES subjects ON DELETE CASCADE,
  overlap_ratio NUMERIC(4,3),      -- fraction of concepts surviving the revision
  discount      NUMERIC(4,3),      -- weight applied to ancestor evidence
  PRIMARY KEY (ancestor_subject_id, successor_subject_id)
);
```

**Why college and department are absent.** Anna University sets papers centrally for all affiliated non-autonomous colleges, so every affiliated student sits the same paper. College and department live on `users` as attributes. Including them in the key would fragment the corpus and weaken every statistic for no gain.

---

## 3. Papers and questions

```sql
CREATE TABLE papers (
  paper_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id   BIGINT NOT NULL REFERENCES subjects ON DELETE CASCADE,
  exam_session VARCHAR(20),                  -- 'apr-may', 'nov-dec'
  exam_year    SMALLINT NOT NULL,
  content_hash CHAR(64) NOT NULL,            -- sha256 of NORMALIZED text
  blob_url     TEXT,
  page_count   SMALLINT,
  status       VARCHAR(20) NOT NULL DEFAULT 'queued',
  template     JSONB,                        -- units, slots, OR structure, marks
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subject_id, content_hash)          -- the idempotency guarantee
);

CREATE TABLE paper_contributions (
  paper_id BIGINT NOT NULL REFERENCES papers ON DELETE CASCADE,
  user_id  BIGINT NOT NULL REFERENCES users  ON DELETE CASCADE,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (paper_id, user_id)
);

CREATE TABLE questions (
  question_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  paper_id    BIGINT NOT NULL REFERENCES papers ON DELETE CASCADE,
  q_number    VARCHAR(20) NOT NULL,          -- '11'
  part_label  VARCHAR(20),                   -- 'a', 'i'
  text        TEXT NOT NULL,
  marks       SMALLINT,
  or_group_id INTEGER,                       -- PER-PAPER. NULL when no choice.
  unit_hint   SMALLINT,
  page_no     SMALLINT,
  embedding   VECTOR(384),
  seg_confidence NUMERIC(4,3),
  UNIQUE (paper_id, q_number, part_label)
);
```

**`or_group_id` is per-paper and only meaningful with `paper_id`.** Two questions are alternatives only when they share **both**. See the OR rule in [ARCHITECTURE.md](ARCHITECTURE.md#23-the-or-rule-stated-precisely) — getting this wrong deflates every recurrence count with no error raised.

**`papers.template`** stores the recovered exam structure: how many units, how many slots per unit, which slots are OR pairs, marks per slot. The Night Before optimizer and the Exam Simulator both consume it as a hard constraint.

---

## 4. Clusters, concepts, and the graph

```sql
CREATE TABLE clusters (
  cluster_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id         BIGINT NOT NULL REFERENCES subjects ON DELETE CASCADE,
  canonical_text     TEXT NOT NULL,
  canonical_text_hash CHAR(64) NOT NULL,     -- cache key, see section 6
  marks_band         SMALLINT,               -- 2 | 8 | 13 | 16
  version            INTEGER NOT NULL DEFAULT 1,   -- optimistic concurrency
  confidence         NUMERIC(4,3),
  status             VARCHAR(20) NOT NULL DEFAULT 'provisional',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE question_cluster (
  question_id BIGINT PRIMARY KEY REFERENCES questions ON DELETE CASCADE,
  cluster_id  BIGINT NOT NULL REFERENCES clusters  ON DELETE CASCADE,
  similarity  NUMERIC(5,4),
  decided_by  VARCHAR(20) NOT NULL,          -- 'agent' | 'human' | 'rule'
  confidence  NUMERIC(4,3),
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

A question belongs to exactly one cluster, hence `question_id` as the primary key. `decided_by` makes every merge auditable and turns human review decisions into free labelled evaluation data.

```sql
CREATE TABLE syllabus_units (
  unit_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id BIGINT NOT NULL REFERENCES subjects ON DELETE CASCADE,
  unit_no    SMALLINT NOT NULL,
  title      VARCHAR(300) NOT NULL,
  hours      SMALLINT,                       -- prior on marks weight
  raw_text   TEXT,
  UNIQUE (subject_id, unit_no)
);

CREATE TABLE concepts (
  concept_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id   BIGINT NOT NULL REFERENCES subjects ON DELETE CASCADE,
  name         VARCHAR(200) NOT NULL,
  description  TEXT,
  content_hash CHAR(64) NOT NULL,            -- lesson cache key
  embedding    VECTOR(384),
  UNIQUE (subject_id, name)
);

CREATE TABLE concept_units (
  concept_id BIGINT NOT NULL REFERENCES concepts       ON DELETE CASCADE,
  unit_id    BIGINT NOT NULL REFERENCES syllabus_units ON DELETE CASCADE,
  PRIMARY KEY (concept_id, unit_id)
);

CREATE TABLE cluster_concepts (
  cluster_id BIGINT NOT NULL REFERENCES clusters ON DELETE CASCADE,
  concept_id BIGINT NOT NULL REFERENCES concepts ON DELETE CASCADE,
  weight     NUMERIC(4,3) NOT NULL,          -- multi-label: a question can test several
  PRIMARY KEY (cluster_id, concept_id)
);

-- Prerequisite edges are INDUCED, never hand-authored. Provenance is mandatory.
CREATE TABLE concept_edges (
  from_concept BIGINT NOT NULL REFERENCES concepts ON DELETE CASCADE,
  to_concept   BIGINT NOT NULL REFERENCES concepts ON DELETE CASCADE,
  kind         VARCHAR(20) NOT NULL DEFAULT 'prerequisite',
  confidence   NUMERIC(4,3) NOT NULL,
  evidence     JSONB NOT NULL,               -- {proposed_by, corpus_support, ...}
  PRIMARY KEY (from_concept, to_concept, kind),
  CHECK (from_concept <> to_concept)
);
```

**Every prerequisite edge carries `evidence`.** An edge is proposed by an LLM and then confirmed or demoted by corpus structure. Storing the provenance is what separates this from a hand-authored curriculum graph, and it is what lets the graph improve as the corpus grows. See [PEDAGOGY.md](PEDAGOGY.md).

The `CHECK` prevents self-loops; cycle prevention across multiple edges is enforced in application code at insert time, and every traversal additionally carries a path-array cycle guard.

---

## 5. Derived statistics

```sql
CREATE TABLE cluster_stats (
  cluster_id       BIGINT PRIMARY KEY REFERENCES clusters ON DELETE CASCADE,
  appearances      SMALLINT NOT NULL,
  decayed_freq     NUMERIC(6,4),
  last_seen_year   SMALLINT,
  mean_gap_years   NUMERIC(4,2),
  overdue_ratio    NUMERIC(5,3),
  p_next           NUMERIC(5,4),
  expected_marks   NUMERIC(6,2),
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE concept_stats (
  concept_id            BIGINT PRIMARY KEY REFERENCES concepts ON DELETE CASCADE,
  expected_marks        NUMERIC(6,2) NOT NULL,
  study_cost_min        SMALLINT NOT NULL,
  roi                   NUMERIC(7,3) NOT NULL,
  escalation_rate       NUMERIC(5,4),        -- share of students needing Tier 2
  evidence_cluster_count SMALLINT NOT NULL,
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subject_regime (
  subject_id      BIGINT PRIMARY KEY REFERENCES subjects ON DELETE CASCADE,
  repetition_rate NUMERIC(5,4) NOT NULL,
  regime          VARCHAR(10) NOT NULL,      -- 'high' | 'medium' | 'low'
  paper_count     SMALLINT NOT NULL,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`subject_regime` drives graceful degradation: when few clusters recur, ROI weighting shifts away from per-question `p_next` toward concept-level frequency and syllabus priors, and the UI states which mode it is in. `escalation_rate` feeds back into `study_cost_min`, so concepts that students actually find hard get costed correctly over time.

---

## 6. Shared caches, and why they are content-addressed

```sql
CREATE TABLE answer_cache (
  canonical_text_hash CHAR(64) NOT NULL,
  marks_band          SMALLINT NOT NULL,
  body                TEXT NOT NULL,
  sources             JSONB NOT NULL,        -- citations: paper, year, q_number
  model               VARCHAR(60),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (canonical_text_hash, marks_band)
);

CREATE TABLE lesson_cache (
  concept_content_hash CHAR(64) NOT NULL,
  depth                VARCHAR(10) NOT NULL, -- 'cram' | 'full'
  body                 TEXT NOT NULL,
  sources              JSONB NOT NULL,
  gap_flags            JSONB,                -- what the sources did NOT cover
  model                VARCHAR(60),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (concept_content_hash, depth)
);
```

**Neither cache is keyed on a surrogate id, and that is deliberate.**

Clusters and concepts are mutable by design — optimistic-concurrency merge and split is a core mechanism. An id-keyed cache would:

- **orphan** entries when cluster A absorbs cluster B (B's answers become unreachable but still occupy rows), and
- **serve stale content** when a split reuses or reassigns an id.

Content addressing makes merge and split naturally cache-safe, and gives free reuse when two clusters turn out to be the same question. The alternative — id keys plus explicit invalidation inside every merge/split transaction — is more code and more bugs for no benefit.

**`gap_flags`** records what the source material did not cover, so an honest lesson is cached as honestly as a complete one.

---

## 7. Review queue

```sql
CREATE TABLE review_queue (
  review_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id BIGINT NOT NULL REFERENCES subjects ON DELETE CASCADE,
  kind       VARCHAR(30) NOT NULL,   -- 'merge' | 'split' | 'segmentation' | 'dlq'
  payload    JSONB NOT NULL,
  confidence NUMERIC(4,3),
  status     VARCHAR(20) NOT NULL DEFAULT 'open',
  resolved_by BIGINT REFERENCES users,
  resolution JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
```

Dead-lettered jobs a human could fix land here as `kind = 'dlq'` rather than disappearing into a log. Every resolution is a labelled example.

---

## 8. Private tables

```sql
CREATE TABLE users (
  user_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         VARCHAR(200) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name  VARCHAR(120),
  university_id BIGINT REFERENCES universities,
  regulation_id BIGINT REFERENCES regulations,
  college       VARCHAR(200),   -- attribute, NOT a corpus key
  dept          VARCHAR(80),    -- attribute, NOT a corpus key
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_sources (            -- private RAG corpus: notes, textbook
  source_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users    ON DELETE CASCADE,
  subject_id BIGINT NOT NULL REFERENCES subjects ON DELETE CASCADE,
  kind       VARCHAR(20) NOT NULL,     -- 'notes' | 'textbook'
  title      VARCHAR(300),
  chunk_no   INTEGER NOT NULL,
  content    TEXT NOT NULL,
  embedding  VECTOR(384)
);

CREATE TABLE attempts (
  attempt_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users    ON DELETE CASCADE,
  cluster_id BIGINT NOT NULL REFERENCES clusters ON DELETE CASCADE,
  answer_text TEXT NOT NULL,
  score      NUMERIC(5,2),
  max_score  NUMERIC(5,2),
  breakdown  JSONB,                    -- per-point credit, missed concepts
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mastery (
  user_id      BIGINT NOT NULL REFERENCES users    ON DELETE CASCADE,
  concept_id   BIGINT NOT NULL REFERENCES concepts ON DELETE CASCADE,
  score        NUMERIC(4,3) NOT NULL,
  last_seen_at TIMESTAMPTZ,
  due_at       TIMESTAMPTZ,            -- spaced repetition, marks-weighted
  PRIMARY KEY (user_id, concept_id)
);
```

```sql
-- The Learn Loop is a state machine and MUST be resumable:
-- a student closes the tab at 2am and comes back.
CREATE TABLE learn_sessions (
  session_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users    ON DELETE CASCADE,
  subject_id BIGINT NOT NULL REFERENCES subjects ON DELETE CASCADE,
  mode       VARCHAR(20) NOT NULL,      -- 'night_before' | 'mastery'
  budget_min INTEGER,
  spent_min  INTEGER NOT NULL DEFAULT 0,
  plan       JSONB NOT NULL,            -- ordered concept list + unit coverage
  cursor     JSONB NOT NULL,            -- position + prerequisite stack
  state      VARCHAR(20) NOT NULL,      -- SELECT|TEACH|TEST|STUCK|DONE
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tutor_sessions (
  tutor_session_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id BIGINT REFERENCES learn_sessions ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users ON DELETE CASCADE,
  concept_id BIGINT REFERENCES concepts,
  cluster_id BIGINT REFERENCES clusters,
  transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  resolved   BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE escalations (
  escalation_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users    ON DELETE CASCADE,
  concept_id BIGINT NOT NULL REFERENCES concepts ON DELETE CASCADE,
  from_tier  SMALLINT NOT NULL,
  to_tier    SMALLINT NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`escalations` is the data flywheel: concepts that repeatedly push students from Tier 1 to Tier 2 are the genuinely hard ones. Aggregated into `concept_stats.escalation_rate`, it corrects `study_cost_min`, which sharpens ROI for every future student. It costs nothing extra to collect.

---

## 9. Indexes

```sql
-- vector search
CREATE INDEX ON questions    USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON concepts     USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON user_sources USING hnsw (embedding vector_cosine_ops);

-- hot paths
CREATE INDEX ON papers          (subject_id, exam_year DESC);
CREATE INDEX ON questions       (paper_id);
CREATE INDEX ON question_cluster(cluster_id);
CREATE INDEX ON clusters        (subject_id, status);
CREATE INDEX ON cluster_concepts(concept_id);
CREATE INDEX ON concept_edges   (to_concept);        -- prerequisite walks go upward
CREATE INDEX ON attempts        (user_id, cluster_id);
CREATE INDEX ON mastery         (user_id, due_at);   -- scheduler sweep
CREATE INDEX ON review_queue    (subject_id, status, confidence);
CREATE INDEX ON escalations     (concept_id);
```

Candidate retrieval always filters by `subject_id` before the vector search, so the HNSW scan stays inside one corpus.

---

## 10. Migrations

Numbered files applied in order, each inside a transaction:

```
migrations/
  001_core.sql          universities, regulations, subjects, users
  002_corpus.sql        papers, questions, contributions
  003_graph.sql         clusters, concepts, units, edges
  004_stats.sql         cluster_stats, concept_stats, subject_regime
  005_caches.sql        answer_cache, lesson_cache, review_queue
  006_learning.sql      attempts, mastery, learn_sessions, tutor, escalations
```

Tracked in `schema_migrations(version, applied_at, checksum)`, run via `npm run migrate`.

**No boot-time DDL.** The predecessor project ran 400 lines of `CREATE TABLE` on every server start while swallowing errors, and ended up with two schemas that silently diverged. Migrations are the only path by which this schema changes.

---

## 11. Notes on choices

| Choice | Reason |
|---|---|
| `VECTOR(384)` | Matches local ONNX MiniLM. Gemini output is reduced to 384 so one column serves both providers. |
| `BIGINT GENERATED ALWAYS AS IDENTITY` | Standard SQL, no sequence management, no accidental id insertion. |
| `TIMESTAMPTZ` everywhere | A student in one timezone, a server in another, exams scheduled in a third. |
| `JSONB` for `template`, `plan`, `breakdown`, `evidence` | Genuinely schemaless payloads whose shape will change during development. Everything queried or aggregated is a real column. |
| Statistics in tables, not views | Recomputed by a worker after ingest, read thousands of times. Precomputation is correct here. |
| One database, no separate vector store | Hybrid queries — relational predicates AND vector similarity in one statement — are impossible across two systems. |
