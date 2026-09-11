-- 007_corpus_reality: columns the real Anna University R2023 corpus forced.
--
-- docs/DATA_MODEL.md was written before the papers were in hand. Three of its
-- assumptions do not hold for this corpus, and each one would corrupt
-- statistics silently if left unaddressed:
--
--   1. "Archive PDFs are mostly digital text." FALSE. 19 of 31 papers are
--      image-only scans, and several more carry a GARBAGE OCR text layer
--      (TOC-R2023-EndSem-25S5 reads "Define ambiquous qrammar"). A non-empty
--      text layer is therefore not evidence of a usable one; text_source
--      records which path actually produced the text.
--   2. "College is not a corpus key." True for centrally-set end-semester
--      papers, false for CEG/MIT internal assessments and quizzes, which sit
--      in the same corpus. Recorded as columns, not as a new key, so the
--      shared graph stays whole while statistics can be scoped.
--   3. unit_hint was a guess. The R2023 papers PRINT a CO (course outcome)
--      code and a BL (Bloom's taxonomy level) against every question. That is
--      free ground-truth supervision for syllabus alignment.

ALTER TABLE papers
  ADD COLUMN exam_type   VARCHAR(20) NOT NULL DEFAULT 'endsem',
  ADD COLUMN college     VARCHAR(20),
  ADD COLUMN paper_set   VARCHAR(10),
  ADD COLUMN text_source VARCHAR(20) NOT NULL DEFAULT 'digital';

COMMENT ON COLUMN papers.college IS
  'NULL = centrally set by the university. Non-NULL (CEG, MIT) = college-set '
  'internal paper. Recurrence statistics default to the centrally-set slice.';
COMMENT ON COLUMN papers.exam_type IS
  'Mixing a quiz MCQ with a 13-mark end-semester question would corrupt the '
  'marks bands, so statistics are scoped by this.';
COMMENT ON COLUMN papers.text_source IS
  'Which extraction path produced the text. dirty_ocr_recovered means the PDF '
  'had a text layer that failed the quality gate and was re-read with vision.';

ALTER TABLE papers
  ADD CONSTRAINT papers_exam_type_ck
    CHECK (exam_type IN ('endsem','assessment','quiz','supplementary','retest')),
  ADD CONSTRAINT papers_text_source_ck
    CHECK (text_source IN ('digital','vision','dirty_ocr_recovered'));

ALTER TABLE questions
  ADD COLUMN part     CHAR(1),
  ADD COLUMN co_code  SMALLINT,
  ADD COLUMN bl_level SMALLINT;

COMMENT ON COLUMN questions.part IS
  'A (10x2=20), B (5x13=65, OR-paired), or C (1x15=15) in the R2023 template.';
COMMENT ON COLUMN questions.co_code IS
  'Course outcome printed on the paper. Supervision for syllabus alignment.';
COMMENT ON COLUMN questions.bl_level IS
  'Blooms taxonomy level 1-6, printed on the paper.';

ALTER TABLE questions
  ADD CONSTRAINT questions_part_ck     CHECK (part IS NULL OR part IN ('A','B','C')),
  ADD CONSTRAINT questions_bl_level_ck CHECK (bl_level IS NULL OR bl_level BETWEEN 1 AND 6);

-- The statistics slice: centrally-set end-semester papers only.
CREATE INDEX ON papers (subject_id, exam_type, college, exam_year DESC);
