-- 004_stats: derived statistics. Recomputed by a worker after ingest and read
-- thousands of times, so these are tables, not views.

CREATE TABLE cluster_stats (
  cluster_id     BIGINT PRIMARY KEY REFERENCES clusters ON DELETE CASCADE,
  appearances    SMALLINT NOT NULL,
  decayed_freq   NUMERIC(6,4),
  last_seen_year SMALLINT,
  mean_gap_years NUMERIC(4,2),
  overdue_ratio  NUMERIC(5,3),
  p_next         NUMERIC(5,4),
  expected_marks NUMERIC(6,2),
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE concept_stats (
  concept_id             BIGINT PRIMARY KEY REFERENCES concepts ON DELETE CASCADE,
  expected_marks         NUMERIC(6,2) NOT NULL,
  study_cost_min         SMALLINT NOT NULL,
  roi                    NUMERIC(7,3) NOT NULL,
  escalation_rate        NUMERIC(5,4),
  evidence_cluster_count SMALLINT NOT NULL,
  computed_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Drives graceful degradation. When few clusters recur, ROI weighting shifts
-- away from per-question p_next toward concept frequency and syllabus priors,
-- and the UI states which mode it is in.
CREATE TABLE subject_regime (
  subject_id      BIGINT PRIMARY KEY REFERENCES subjects ON DELETE CASCADE,
  repetition_rate NUMERIC(5,4) NOT NULL,
  regime          VARCHAR(10) NOT NULL,
  paper_count     SMALLINT NOT NULL,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (regime IN ('high','medium','low'))
);
