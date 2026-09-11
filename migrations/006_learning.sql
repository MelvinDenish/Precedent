-- 006_learning: private per-user tables. Every one carries user_id.
-- Shared graph tables carry none, so a query cannot leak across students.

CREATE TABLE user_sources (
  source_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users    ON DELETE CASCADE,
  subject_id BIGINT NOT NULL REFERENCES subjects ON DELETE CASCADE,
  kind       VARCHAR(20) NOT NULL,
  title      VARCHAR(300),
  chunk_no   INTEGER NOT NULL,
  content    TEXT NOT NULL,
  embedding  VECTOR(384),
  CHECK (kind IN ('notes','textbook'))
);

CREATE TABLE attempts (
  attempt_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users    ON DELETE CASCADE,
  cluster_id  BIGINT NOT NULL REFERENCES clusters ON DELETE CASCADE,
  answer_text TEXT NOT NULL,
  score       NUMERIC(5,2),
  max_score   NUMERIC(5,2),
  breakdown   JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mastery (
  user_id      BIGINT NOT NULL REFERENCES users    ON DELETE CASCADE,
  concept_id   BIGINT NOT NULL REFERENCES concepts ON DELETE CASCADE,
  score        NUMERIC(4,3) NOT NULL,
  last_seen_at TIMESTAMPTZ,
  due_at       TIMESTAMPTZ,
  PRIMARY KEY (user_id, concept_id)
);

-- The Learn Loop is a state machine and MUST be resumable: a student closes
-- the tab at 2am and comes back. Every transition is a write.
CREATE TABLE learn_sessions (
  session_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users    ON DELETE CASCADE,
  subject_id BIGINT NOT NULL REFERENCES subjects ON DELETE CASCADE,
  mode       VARCHAR(20) NOT NULL,
  budget_min INTEGER,
  spent_min  INTEGER NOT NULL DEFAULT 0,
  plan       JSONB NOT NULL,
  cursor     JSONB NOT NULL,
  state      VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (mode  IN ('night_before','mastery')),
  CHECK (state IN ('SELECT','TEACH','TEST','STUCK','DONE'))
);

CREATE TABLE tutor_sessions (
  tutor_session_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  BIGINT REFERENCES learn_sessions ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES users ON DELETE CASCADE,
  concept_id  BIGINT REFERENCES concepts,
  cluster_id  BIGINT REFERENCES clusters,
  transcript  JSONB NOT NULL DEFAULT '[]'::jsonb,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  resolved    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The data flywheel. Concepts that repeatedly force Tier 2 are the genuinely
-- hard ones; aggregated into concept_stats.escalation_rate this corrects
-- study_cost_min, which sharpens ROI for every future student.
CREATE TABLE escalations (
  escalation_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users    ON DELETE CASCADE,
  concept_id BIGINT NOT NULL REFERENCES concepts ON DELETE CASCADE,
  from_tier  SMALLINT NOT NULL,
  to_tier    SMALLINT NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON attempts    (user_id, cluster_id);
CREATE INDEX ON mastery     (user_id, due_at);
CREATE INDEX ON escalations (concept_id);

-- Vector search. Candidate retrieval always filters by subject_id first,
-- so the HNSW scan stays inside one corpus.
CREATE INDEX ON questions    USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON concepts     USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON user_sources USING hnsw (embedding vector_cosine_ops);
