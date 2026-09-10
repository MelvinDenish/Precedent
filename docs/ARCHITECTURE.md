# Precedent — Architecture

Companion docs: [DATA_MODEL.md](DATA_MODEL.md) for schema, [AGENTS.md](AGENTS.md) for the LLM components, [PEDAGOGY.md](PEDAGOGY.md) for the learning model.

---

## 1. System overview

```
                        +---------------+
   Browser -------------|   Web (SPA)   |  React + TS + React Flow
      |  SSE (tutor)    +-------+-------+
      |  WS  (ingest)           | REST
      |                 +-------v-------+
      +-----------------|      API      |  Fastify + TS
                        |  (stateless)  |
                        +--+-----+----+-+
                           |     |    |
             +-------------+     |    +-------------+
             |                   |                  |
     +-------v------+   +--------v-------+  +-------v-------+
     |  Postgres 16 |   | Redis (BullMQ) |  |  Blob store   |
     |  + pgvector  |   | queues + rate  |  |  original PDF |
     +-------^------+   +--------+-------+  +---------------+
             |                   |
             |          +--------v--------+
             +----------|   Worker pool   |  same TS codebase,
                        |  (N processes)  |  different entrypoint
                        +--------+--------+
                                 |
                     +-----------v------------+
                     |  LLM providers         |
                     |  Gemini (vision, bulk) |
                     |  Groq   (tutor, speed) |
                     |  local ONNX (embed)    |
                     +------------------------+
```

**Three deployable units, one codebase:** web, api, worker. The API is stateless and horizontally scalable; all long or expensive work happens in workers.

**Why the API never calls an LLM synchronously (one exception):** a request that blocks on a free-tier LLM call inherits its rate limits, its latency and its failures. Ingestion is queued and reported over WebSocket. The one exception is **Tutor Chat**, which streams over SSE, because a tutor that answers in 8 seconds is not a tutor.

---

## 2. The ingestion pipeline

```
 upload(syllabus | paper)
        |
        v
 +-- API: POST /upload -----------------------------+
 | 1. store raw bytes -> blob store                 |
 | 2. cheap text extraction for hashing             |
 | 3. normalize -> content_hash                     |
 | 4. INSERT ... ON CONFLICT DO NOTHING             |
 |    already present? -> credit contributor, STOP  |
 | 5. enqueue ingest job, return 202 + job id       |
 +------------------+-------------------------------+
                    v
 +-- WORKER: ingest stages -------------------------------------+
 |  S1  extract      pdfjs-dist text + coords                    |
 |                   -> Gemini vision if text layer is empty     |
 |  S2  SEGMENT      coordinate sort -> atomic questions,        |
 |                   sub-parts, marks, or_group_id, unit hints   |
 |  S3  embed        local ONNX MiniLM 384d -> pgvector          |
 |  S4  candidates   HNSW top-k in subject, excluding same paper |
 |  S5  ADJUDICATE   agent: same | variant | different + conf    |
 |  S6  gate         auto-apply / review queue / auto-reject     |
 |  S7  cluster      merge or split under optimistic concurrency |
 |  S8  concepts     extract, then align to syllabus units       |
 |  S9  stats        recompute cluster_stats, concept_stats,     |
 |                   subject_regime                              |
 +---------------------------------------------------------------+
```

Each stage S1..S9 is a **separate BullMQ job**, not one long function. Reasons: a failure retries only the failed stage; different stages need different rate limiters (vision vs text vs none); progress is reportable per stage; and a stage can be re-run in isolation when its implementation improves, for example re-segmenting without re-extracting.

### 2.1 Idempotency

The dedupe key is a SHA-256 of the **normalized extracted text**, not the raw bytes:

```
normalize(text) = lowercase
                -> collapse whitespace runs to a single space
                -> strip page numbers, headers, footers
                -> strip registration-number and seat-number lines
                -> trim
```

**Why not raw bytes:** the same paper downloaded from two archives differs byte-wise (different PDF producers, different compression, an added watermark). Raw-byte hashing silently fails to dedupe, and the corpus fills with duplicates that inflate every recurrence count.

Uniqueness is `UNIQUE (subject_id, content_hash)`. A second upload of the same paper records a contributor credit and returns the existing paper. No reprocessing.

### 2.2 Segmentation, the hard stage

The acknowledged schedule risk: **4-6 days**, versus roughly 2 days for recognition.

| Element to recover | Difficulty |
|---|---|
| Question number (Q11, "11.", "(11)") | Easy, regex |
| Sub-parts (a, i, A) with their own marks | Medium, nesting is inconsistent |
| Marks annotations ("[16]", "(8 marks)", right-aligned column) | Medium, often positional rather than textual |
| Unit / module headers | Medium |
| **OR-choice groups** | **Hard, and load-bearing** |
| Multi-column reading order | Hard, pdfjs-dist gives coordinates but not reading order |

**Approach:** rules first, since they cover the large majority of clean archive PDFs, with a single structured-output LLM call as fallback for papers where the rule pass yields low confidence. A **coordinate-sort pass** runs before the rules to establish reading order; that sits inside the 4-6 day estimate, not on top of it.

Every segmentation result is correctable through the review UI, and corrections are stored, so segmentation accuracy is measurable rather than assumed.

### 2.3 The OR rule, stated precisely

> Two questions may not be merged into the same cluster **if and only if they share a paper AND an or_group.**

The `or_group_id` column is scoped per-paper. The naive rule, "never merge questions sharing an or_group", is **wrong and dangerous**: 2023 Q11(a) and 2024 Q13(b) are the same question sitting in different OR-slots in different years, and those cross-year merges are precisely what the product exists to find.

| Rule strength | Failure mode |
|---|---|
| Too strong (id-only check) | Cross-year merges suppressed. Recurrence counts **deflated**. No error raised anywhere. |
| Too weak (no check) | Alternatives merged. Recurrence counts **inflated**. |

Both directions are asserted in the test suite. See [EVALUATION.md](EVALUATION.md).

### 2.4 Clustering and concurrency

Candidate retrieval is HNSW top-k over `questions.embedding`, scoped to the subject and **excluding questions from the same paper**. A paper does not duplicate itself, and this cheaply removes the OR-sibling case from the candidate set.

Embeddings alone cannot decide. "Explain 2NF with an example" and "Explain 3NF with an example" are near-identical vectors and completely different questions. That is why S5 is an agent rather than a similarity threshold.

**Optimistic concurrency on merge and split.** Clusters are mutable and multiple workers touch them at once:

```sql
-- read
SELECT cluster_id, version, canonical_text FROM clusters WHERE cluster_id = $1;

-- write, guarded by the version we read
UPDATE clusters
   SET canonical_text = $2, version = version + 1
 WHERE cluster_id = $1 AND version = $3;
-- 0 rows affected -> another worker won -> re-read and retry (bounded, then DLQ)
```

A **merge touches two clusters**, so both rows are locked inside one transaction with `SELECT ... FOR UPDATE` **ordered by cluster_id ascending**, which makes deadlock structurally impossible.

### 2.5 Confidence gate

| Adjudicator confidence | Action |
|---|---|
| above 0.85 | Auto-apply the merge |
| 0.60 to 0.85 | **Review queue**, a human decides |
| below 0.60 | Auto-reject, leave separate |

The gate is the point. LLM adjudication is reliable in the middle of the distribution and unreliable at the tails; the system is built for that rather than pretending otherwise. Human decisions are recorded and become labelled evaluation data for free.

---

## 3. The read path: Learn Loop and the escalation ladder

The Learn Loop is a **finite state machine over the graph**, executed server-side and persisted per session. It is deliberately not an agent: it must be deterministic, auditable and **resumable**, because a student closes the tab at 2am and comes back.

```
  states: SELECT -> TEACH -> TEST -> (PASS | FAIL) -> ...

  SELECT   pick next concept
           Night Before: ROI order, unit-coverage constrained
           Mastery:      prerequisite topological order, ROI breaks ties
  TEACH    serve lesson at depth (cram | full)   [Tier 1, cached]
  TEST     serve real PYQs on this concept, ascending marks
  PASS     mark mastery, advance cursor, bump expected-marks counter
  FAIL     resolve prerequisite chain, push the missing concept
           onto the stack, re-enter TEACH there
  STUCK    student escalates -> Tier 2 tutor session attaches here
```

Session state lives in `learn_sessions(plan JSONB, cursor, state)`. Every transition is a write, so a crash or a closed tab resumes exactly where it stopped.

### 3.1 The escalation ladder

| Tier | Trigger | Serves | Cost |
|---|---|---|---|
| 0 | Student recognises the question | Cached canonical answer, cited | 0 tokens, shared |
| 1 | Student does not know the topic | Cached micro-lesson, exam-angled | 0 tokens, shared |
| 2 | Still stuck, or prerequisites missing | Tutor Chat agent, streamed | Per-student, on demand |

**This is the cost model, not just UX.** Tiers 0 and 1 are generated once per corpus and served to every student sharing that `(university, regulation, subject)` key. Only Tier 2 spends per-student tokens, and only when explicitly requested. That is what makes a free-tier deployment survive more than a handful of users.

**Prerequisites surface proactively.** The graph already knows which concepts a question tests and what those depend on, and `mastery` says what the student has covered. So the UI warns before the student is confused rather than diagnosing after they fail.

### 3.2 Caching and amortization

| Cache | Key | Scope |
|---|---|---|
| `answer_cache` | `(canonical_text_hash, marks_band)` | Shared across all students |
| `lesson_cache` | `(concept_content_hash, depth)` | Shared across all students |
| Personalized answers | `(user_id, cluster_id, marks_band)` | Private |

Both shared caches are **content-addressed, never keyed on a surrogate id**. Clusters and concepts are mutable by design, so an id-keyed cache orphans entries on merge and serves stale content under a reused id on split. Content addressing makes merge and split naturally cache-safe, and yields free reuse when two clusters turn out to be the same question.

---

## 4. Queues, reliability and rate limits

| Queue | Jobs | Concurrency | Limiter |
|---|---|---|---|
| `ingest` | S1 extract, S2 segment | low, CPU bound | vision calls limited separately |
| `embed` | S3 | high, local ONNX, no network | none |
| `adjudicate` | S4, S5, S6, S7 | medium | per-provider token bucket |
| `enrich` | S8 concepts, S9 stats | low | per-provider token bucket |
| `generate` | canonical answers, lessons | low, lazy or warmed | per-provider token bucket |
| `schedule` | spaced-repetition due sweep | 1 | none |

**Reliability rules applied to every queue:**

- **Retries** with exponential backoff plus jitter, capped attempts, then dead-letter.
- **Idempotent job bodies.** Every job carries the ids it needs and re-derives nothing from wall-clock time, so a retry after partial success is safe.
- **DLQ is inspectable in the review UI.** A failure a human can fix is a review item, not a lost job.
- **Rate limiters are per provider, not per queue**, because Gemini quota is shared across every queue that calls it.
- **Graceful degradation.** If Gemini is exhausted, vision extraction defers rather than failing the paper; if Groq is down, Tutor Chat falls back to Gemini with a visible latency warning.

### 4.1 Progress reporting

Ingestion is asynchronous, so the client subscribes over WebSocket to `paper:{id}` and receives stage transitions (`extracted`, `segmented`, `clustered`, `ready`) plus counts. Tutor Chat uses SSE instead, since it is one-way server-to-client token streaming and does not need a bidirectional channel.

---

## 5. Deployment

| Component | Host | Notes |
|---|---|---|
| `web` | Vercel | Static SPA |
| `api` | Railway or Render | Stateless, scale horizontally |
| `worker` | Railway or Render | Separate process, scale independently of API |
| Postgres + pgvector | Neon free tier | Suspends when idle; first request after sleep is slow |
| Redis | Upstash free tier | BullMQ backend |
| Blobs | Cloudflare R2 or Supabase Storage | Original PDFs, for the citation trail |

**Deploy in Week 1, not Week 6.** A live URL that exists from the start can never become the thing that got cut. Neon suspends idle compute, so either add a keep-alive ping to `/health` or state the cold-start delay in the README.

### 5.1 Migrations

Numbered `NNN_name.sql` files applied in order inside a transaction, tracked in `schema_migrations(version, applied_at, checksum)`, run by `npm run migrate`.

**No boot-time `CREATE TABLE`.** The predecessor project ran 400 lines of DDL on every server start and swallowed the errors, which produced two schemas that silently diverged. That mistake is not repeated here.

---

## 6. Security and privacy

- **Public/private split is enforced at the query layer.** Shared graph tables carry no `user_id`; private tables always filter by the authenticated user. No endpoint returns another student's notes, attempts or mastery.
- JWT auth, bcrypt-hashed passwords, secrets from environment only, no hardcoded fallback secret.
- CORS restricted to the deployed frontend origin.
- Rate limiting on upload and on Tutor Chat, per user.
- Uploaded PDFs are stored but **never redistributed by the API**; only extracted question text and citations are served.
