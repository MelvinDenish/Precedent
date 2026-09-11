-- 003_graph: clusters, syllabus units, concepts, induced prerequisite edges.

CREATE TABLE clusters (
  cluster_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id          BIGINT NOT NULL REFERENCES subjects ON DELETE CASCADE,
  canonical_text      TEXT NOT NULL,
  canonical_text_hash CHAR(64) NOT NULL,   -- answer_cache key. Content-addressed.
  marks_band          SMALLINT,            -- 2 | 5 | 8 | 13 | 15
  version             INTEGER NOT NULL DEFAULT 1,  -- optimistic concurrency
  confidence          NUMERIC(4,3),
  status              VARCHAR(20) NOT NULL DEFAULT 'provisional',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A question belongs to exactly one cluster, hence question_id as the PK.
CREATE TABLE question_cluster (
  question_id BIGINT PRIMARY KEY REFERENCES questions ON DELETE CASCADE,
  cluster_id  BIGINT NOT NULL REFERENCES clusters  ON DELETE CASCADE,
  similarity  NUMERIC(5,4),
  decided_by  VARCHAR(20) NOT NULL,        -- 'agent' | 'human' | 'rule'
  confidence  NUMERIC(4,3),
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE syllabus_units (
  unit_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id BIGINT NOT NULL REFERENCES subjects ON DELETE CASCADE,
  unit_no    SMALLINT NOT NULL,
  title      VARCHAR(300) NOT NULL,
  hours      SMALLINT,                     -- prior on marks weight
  raw_text   TEXT,
  UNIQUE (subject_id, unit_no)
);

CREATE TABLE concepts (
  concept_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id   BIGINT NOT NULL REFERENCES subjects ON DELETE CASCADE,
  name         VARCHAR(200) NOT NULL,
  description  TEXT,
  content_hash CHAR(64) NOT NULL,          -- lesson_cache key. Content-addressed.
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
  weight     NUMERIC(4,3) NOT NULL,   -- multi-label: a question can test several
  PRIMARY KEY (cluster_id, concept_id)
);

-- Prerequisite edges are INDUCED, never hand-authored. Provenance is mandatory:
-- that is what separates this from ALEKS's hand-built curriculum graph.
CREATE TABLE concept_edges (
  from_concept BIGINT NOT NULL REFERENCES concepts ON DELETE CASCADE,
  to_concept   BIGINT NOT NULL REFERENCES concepts ON DELETE CASCADE,
  kind         VARCHAR(20) NOT NULL DEFAULT 'prerequisite',
  confidence   NUMERIC(4,3) NOT NULL,
  evidence     JSONB NOT NULL,   -- {proposed_by, corpus_support, ...}
  PRIMARY KEY (from_concept, to_concept, kind),
  CHECK (from_concept <> to_concept)   -- multi-edge cycles guarded in app code
);

CREATE INDEX ON question_cluster (cluster_id);
CREATE INDEX ON clusters         (subject_id, status);
CREATE INDEX ON cluster_concepts (concept_id);
CREATE INDEX ON concept_edges    (to_concept);   -- prerequisite walks go upward
