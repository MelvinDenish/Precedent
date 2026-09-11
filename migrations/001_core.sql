-- 001_core: extensions, corpus scoping, users.
-- The corpus key is (university, regulation, subject_code). One shared
-- master graph per subjects row. See docs/DATA_MODEL.md section 2.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE universities (
  university_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,
  slug          VARCHAR(80)  NOT NULL UNIQUE
);

CREATE TABLE regulations (
  regulation_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  university_id  BIGINT NOT NULL REFERENCES universities ON DELETE CASCADE,
  code           VARCHAR(40) NOT NULL,        -- 'R2023', 'R2018'
  effective_from DATE,
  effective_to   DATE,
  UNIQUE (university_id, code)
);

-- THE CORPUS KEY.
CREATE TABLE subjects (
  subject_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  university_id BIGINT NOT NULL REFERENCES universities ON DELETE CASCADE,
  regulation_id BIGINT NOT NULL REFERENCES regulations  ON DELETE CASCADE,
  code          VARCHAR(40)  NOT NULL,        -- 'CS23501'
  name          VARCHAR(200) NOT NULL,
  semester      SMALLINT,
  UNIQUE (university_id, regulation_id, code)
);

-- Links a subject across a syllabus revision, so CS6111 (R2018) papers
-- can inform CS23502 (R2023) predictions at a discount.
CREATE TABLE subject_lineage (
  ancestor_subject_id  BIGINT NOT NULL REFERENCES subjects ON DELETE CASCADE,
  successor_subject_id BIGINT NOT NULL REFERENCES subjects ON DELETE CASCADE,
  overlap_ratio NUMERIC(4,3),   -- fraction of concepts surviving the revision
  discount      NUMERIC(4,3),   -- weight applied to ancestor evidence
  PRIMARY KEY (ancestor_subject_id, successor_subject_id),
  CHECK (ancestor_subject_id <> successor_subject_id)
);

-- PRIVATE. college and dept are user ATTRIBUTES, never corpus keys.
CREATE TABLE users (
  user_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         VARCHAR(200) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name  VARCHAR(120),
  university_id BIGINT REFERENCES universities,
  regulation_id BIGINT REFERENCES regulations,
  college       VARCHAR(200),
  dept          VARCHAR(80),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
