-- 005_caches: shared generation caches + the review queue.
--
-- NEITHER CACHE IS KEYED ON A SURROGATE ID, AND THAT IS DELIBERATE.
-- Clusters and concepts are mutable by design (merge/split under optimistic
-- concurrency). An id-keyed cache would ORPHAN entries when cluster A absorbs
-- B, and SERVE STALE content when a split reuses an id. Content addressing
-- makes merge and split naturally cache-safe, and yields free reuse when two
-- clusters turn out to be the same question.

CREATE TABLE answer_cache (
  canonical_text_hash CHAR(64) NOT NULL,
  marks_band          SMALLINT NOT NULL,
  body                TEXT NOT NULL,
  sources             JSONB NOT NULL,
  model               VARCHAR(60),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (canonical_text_hash, marks_band)
);

CREATE TABLE lesson_cache (
  concept_content_hash CHAR(64) NOT NULL,
  depth                VARCHAR(10) NOT NULL,
  body                 TEXT NOT NULL,
  sources              JSONB NOT NULL,
  gap_flags            JSONB,
  model                VARCHAR(60),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (concept_content_hash, depth),
  CHECK (depth IN ('cram','full'))
);

-- Dead-lettered jobs a human could fix land here as kind = dlq rather than
-- disappearing into a log. Every resolution is a labelled example.
CREATE TABLE review_queue (
  review_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id  BIGINT NOT NULL REFERENCES subjects ON DELETE CASCADE,
  kind        VARCHAR(30) NOT NULL,
  payload     JSONB NOT NULL,
  confidence  NUMERIC(4,3),
  status      VARCHAR(20) NOT NULL DEFAULT 'open',
  resolved_by BIGINT REFERENCES users,
  resolution  JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CHECK (kind IN ('merge','split','segmentation','dlq'))
);

CREATE INDEX ON review_queue (subject_id, status, confidence);
