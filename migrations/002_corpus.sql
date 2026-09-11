-- 002_corpus: papers, contributions, questions.

CREATE TABLE papers (
  paper_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id   BIGINT NOT NULL REFERENCES subjects ON DELETE CASCADE,
  exam_session VARCHAR(20),                -- 'apr-may', 'nov-dec'
  exam_year    SMALLINT NOT NULL,
  content_hash CHAR(64) NOT NULL,          -- sha256 of NORMALIZED text
  blob_url     TEXT,
  page_count   SMALLINT,
  status       VARCHAR(20) NOT NULL DEFAULT 'queued',
  template     JSONB,                      -- units, slots, OR structure, marks
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subject_id, content_hash)        -- the idempotency guarantee
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
  q_number    VARCHAR(20) NOT NULL,        -- '11'
  part_label  VARCHAR(20),                 -- 'a', 'i'
  text        TEXT NOT NULL,
  marks       SMALLINT,
  -- PER-PAPER. NULL when the question offers no choice. Two questions are
  -- alternatives only when they share BOTH paper_id AND or_group_id.
  or_group_id INTEGER,
  unit_hint   SMALLINT,
  page_no     SMALLINT,
  embedding   VECTOR(384),
  seg_confidence NUMERIC(4,3),
  UNIQUE (paper_id, q_number, part_label)
);

CREATE INDEX ON papers    (subject_id, exam_year DESC);
CREATE INDEX ON questions (paper_id);
