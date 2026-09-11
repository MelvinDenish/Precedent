# Precedent — Design & Build Plan

## Context

A CS student at Anna University needs a portfolio project for an **AI/LLM + backend internship**, demonstrating load-bearing RAG, load-bearing agents, real distributed systems, and good UI/UX. Their existing project (CodeVault, a VCS clone) is being abandoned — nothing about it is novel and Oracle makes it unhostable.

Three adversarial passes were run before landing here. **Two of my own earlier ideas were killed with evidence:**

- **"Critical Path"** (syllabus as prerequisite DAG + knapsack study path + knowledge-frontier diagnosis) — **dead**. ALEKS has shipped "Ready to Learn" (= the knowledge frontier) for ~30 years on Knowledge Space Theory (Doignon & Falmagne, 1985). Embibe runs a 74,000-concept prerequisite graph across 500+ Indian exams. And **LearnOpt (arXiv 2606.15349, 13 June 2026)** does *"knapsack-variant optimization over prerequisite-aware subgraphs with Bayesian Knowledge Tracing"* on Indian exam PYQs, with public code.
- **"Halflife"** (self-auditing knowledge base) — salvageable but not student-focused; mechanism layer already taken (HALO, Graphiti/Zep, FActScore).

**What survived**, and why: students hand-compute exam question recurrence every semester and do it badly. Studocu hosts a document literally titled `AI MOST IMPORTANT QUESTIONS (Repeated 4 Years)` — a student computed it by hand and uploaded a static PDF. **The output is demonstrably in demand; the computation is done manually; no platform performs it.**

---

## What Precedent is

> Your syllabus tells you what you *could* be asked. Precedent tells you what you *will* be — and then teaches you it.

Students contribute their university's **syllabus + past question papers**. The system shreds every paper into individual questions, recognises when the same question reappears across years in different wording, aligns everything to the syllabus, and assembles a **shared knowledge graph of what a subject actually examines**. Study tools sit on that graph. Every number drills down to paper → year → question number.

### Why the syllabus is required (not optional)

Papers alone tell you what *recurred*; they cannot tell you what *exists*. Together they produce the **coverage matrix**, which is the real knowledge object:

| | Appears often | Appears rarely | Never appeared |
|---|---|---|---|
| **In syllabus** | 🟢 Certain core — cram this | 🟡 Long tail — mastery users | 🔵 Unexamined / possibly **overdue** |
| **Not in syllabus** | 🔴 Syllabus changed — discount those papers | — | — |

Three capabilities follow that are impossible without it: **honest confidence** ("these 18 questions cover ~64% of expected marks, here's the 36% they don't"), the **overdue signal** (a topic absent for three sittings is *more* likely, not less — raw frequency gets this backwards), and **syllabus-version discounting** (a 2022 revision makes 2018 papers weaker evidence).

---

## The core reframe: **concepts are the unit of study, not questions**

Predicting questions is fragile, for two independent reasons:

1. **Some subjects barely repeat questions at all.** A recurrence-only product silently becomes useless for them, with no way for the student to tell.
2. **Even when a question does repeat, reading its model answer is not learning.** You cannot answer a reworded variant — or parse the question at all — without the underlying concept.

**But concept recurrence is robust where question recurrence is not.** The syllabus is fixed, so examiners keep testing the same ideas in new clothes. A topic can be high-value even when *no single question ever repeats*, because expected marks accumulate across many different questions that test the same concept.

So the model inverts:

```
questions are EVIDENCE  (which concepts carry marks, and how they're angled)
questions are ASSESSMENT (real PYQs prove you learned it)
concepts  are the UNIT OF STUDY and the thing that gets TAUGHT
```

### Topic ROI replaces question recurrence as the ranking metric

```
expected_marks(c) = Σ over clusters k testing c:  p_next(k) × marks(k) × weight(k,c)
study_cost(c)     = est. minutes to learn c   (complexity + prerequisite depth)
ROI(c)            = expected_marks(c) / study_cost(c)
```

### Graceful degradation: the model adapts to the subject's repetition regime

Measure each subject's **cluster repetition rate** at ingest and classify its regime:

| Regime | Signal | ROI weighting shifts toward |
|---|---|---|
| **High** | Many multi-year clusters | `p_next` of specific clusters — near-certain predictions |
| **Medium** | Mixed | Balanced |
| **Low** | Few clusters recur | **Concept-level frequency + syllabus priors** (unit hours, marks distribution, historical unit-level rates) |

A low-repetition subject doesn't break the product — it *automatically* stops making per-question claims and starts making per-topic ones, and the UI says which mode it's in. **The system knows what it doesn't know**, which is exactly the honesty the citation trail is there to enforce.

---

## The corpus scoping model — the architectural keystone

Anna University's R2021 applies to *"all Engineering Colleges affiliated to Anna University (other than Autonomous Colleges)"* and **papers are set centrally**. Every affiliated CSE student sitting CS3492 writes the same paper.

```
CORPUS KEY = (university, regulation, subject_code)     ← NOT college, NOT dept
```

College and department are **user attributes**, not graph keys — which makes each graph larger and its statistics sharper. Out of scope for v1: autonomous colleges and internal CAT exams (both college-set; they would need a second, narrower scope).

**What the shared master graph buys:**

| | Per-student | Master graph |
|---|---|---|
| Same paper uploaded by 40 students | 40× extract/segment/embed/adjudicate | **Once** — 39 rejected by content hash |
| Canonical model answer per cluster | Generated 40× | **Generated once, served to all** |
| Recurrence quality | 3 papers one student owns | Everything anyone ever uploaded |
| Free-tier LLM quota | Breaks at ~5 users | Cost is **per-corpus**, not per-user |

**Compute amortization is what makes this viable on free-tier APIs**, and it makes the concurrency work *necessary* rather than contrived: concurrent uploads mutating a shared graph is where idempotency and optimistic concurrency genuinely earn their place.

**Public/private split (mandatory):**
- **Shared:** papers, questions, clusters, concepts, syllabus units, recurrence stats, canonical answers
- **Private:** a user's uploaded notes, attempt history, mastery state, personalized answers

---

## Users: two modes, one engine

**Both modes teach.** The difference is *how many concepts*, *how deep*, and *in what order* — not whether teaching happens.

| | 🌙 **Night Before** (6–10 hrs) | 📈 **Mastery** (2–6 weeks) |
|---|---|---|
| Selection | Top concepts by **ROI**, subject to unit coverage | **Whole portions** — full syllabus |
| Ordering | ROI-descending | **Prerequisite order** |
| Lesson depth | 5-min exam-angled micro-lesson | Full treatment with derivations |
| Assessment | 1–2 real PYQs, fast | Full ladder: 2 → 8 → 16 mark |
| On failure | One prerequisite hop down, then move on | Recurse to root cause, re-teach |
| Coverage | 🟢 certain core | 🟢 + 🟡 + 🔵 long tail |
| Scheduler | Off (there is no tomorrow) | On |
| Simulator | Off | On, full-length |

These are **two traversal policies over one graph**, not two products.

### The Learn Loop — the engine both modes run

```
   pick concept (ROI order, or prerequisite order)
            │
            ▼
   ┌─ TEACH ──────────────────────────────────┐
   │ micro-lesson generated from:              │
   │   syllabus text + your notes + textbook   │
   │   + HOW IT IS ACTUALLY ASKED  ◀── the key │
   └───────────────────┬───────────────────────┘
                       ▼
   ┌─ TEST ────────────────────────────────────┐
   │ REAL past questions on this concept,      │
   │ ascending marks weight, agent-evaluated   │
   └───────┬───────────────────────┬───────────┘
        pass                     fail
           │                       │
           ▼                       ▼
     next concept        hop DOWN a prerequisite edge
     (marks counter ↑)   → teach the missing root cause
```

**The part that makes the teaching non-generic:** lessons are grounded in *how the exam actually angles the concept*. If functional dependencies are always examined as "find the candidate keys," the lesson teaches that, not the abstract relational theory a textbook opens with. **The exam corpus supplies the pedagogical emphasis** — that's something no textbook, no NotebookLM summary, and no pre-authored course can do, because it requires the university's own paper history.

---

## Features, architectures, and the decision behind each

### ⭐ MAIN — The Recurrence Atlas

The graph made navigable: syllabus units as regions, concepts sized by expected marks, clusters attached, colour = recurrence strength.

**Every statistic is clickable to source.** *"Appeared in 6 of 8 papers, avg 13 marks"* → the six original questions with paper, year, Q-number. **The citation trail is the product** — it's the only thing separating this from an LLM guessing, and it's why students will trust it.

*Mechanism:* graph query + React Flow. No LLM at read time.

### 1. 🎓 Teaching Engine — micro-lessons angled by the exam

For any concept, generate a lesson grounded in **four** sources: the syllabus text (scope), the student's uploaded notes (their vocabulary and their professor's framing), a textbook if supplied (rigour), and **the cluster instances that test this concept** (the exam's actual angle and depth).

Two depth levels: **`cram`** (~5 min: definition, the one worked example the exam always wants, the trap it always sets) and **`full`** (derivations, edge cases, why it matters).

*Mechanism:* RAG + generation, **lightly agentic** — retrieve four-way → assess whether the sources actually cover it → generate, or **flag the gap honestly** rather than inventing.
*Why agentic:* the coverage check is what prevents confident fabrication on a topic your notes never mention, and it doubles as a measurable retrieval-quality signal.
*Amortization:* lessons are **cached and shared** per `(concept_content_hash, depth)`. Generated once for the corpus, served to every student — same economics as canonical answers, which is what keeps this inside free-tier quota.

### 2. 🌙 Night Before — the ROI cram engine

Enter your hours → get a **time-budgeted Learn Loop**: highest-ROI concepts, each taught in 5 minutes, each immediately tested with real PYQs, with a live expected-marks counter that fills as you pass them.

**The detail most implementations would get wrong:** you cannot just take the globally top-N concepts. The paper *forces* an answer from every unit (one of two from each of five). If your top concepts all sit in Unit 1, you fail. So it's a **knapsack constrained by the paper's structural template**:

- *Phase 1* — for each unit, take concepts by ROI until that unit has minimum viable answer coverage
- *Phase 2* — spend remaining budget globally by marginal expected-marks-per-minute
- *Reserve* — hold back ~15% of the budget for prerequisite hops triggered by test failures, since the loop discovers gaps as it runs

*Mechanism:* **plain optimization code, no LLM.** **Why:** must be deterministic, instant, and *explainable* — the student needs to see why topic 3 outranks topic 4, and re-plan instantly when they fail a test. An LLM here is slower, worse, and unauditable.

### The escalation ladder — how a student gets unstuck, and why it's cheap

Every question a student faces resolves at the lowest tier that works. **This is not just UX — it's what makes the economics survive free-tier quota**, because Tiers 0 and 1 are amortized across every student in the corpus and only Tier 2 spends per-student tokens, and only when explicitly asked for.

| Tier | Trigger | Serves | Cost |
|---|---|---|---|
| **0 — Direct answer** | Student recognises the question | Cached canonical answer from the graph, cited | **0 tokens**, instant, shared |
| **1 — Concept lesson** | "I don't know the topic" | Cached micro-lesson, exam-angled | **0 tokens**, instant, shared |
| **2 — 🤖 Tutor chat** | "I still don't get it" / prerequisites missing | Live grounded conversation | Per-student tokens, on demand |

**Prerequisites are surfaced proactively, not reactively.** The graph already knows which concepts a question tests and what those depend on, and the student's mastery state says what they've covered. So before they get confused, the UI says *"this question needs Functional Dependencies, which you haven't covered — 4 min lesson first?"* Waiting for the student to fail and *then* diagnosing is the worse design; the graph makes the better one free.

### 3. Answer Studio — two tiers

| Tier | Grounding | Storage | Used by |
|---|---|---|---|
| **Canonical** | Shared corpus: syllabus + question + cluster instances | **Cached once per (cluster, marks_band), shared** | Night Before |
| **Personalized** | *Your* uploaded notes/textbook | Cached per user | Mastery |

Answers are generated **at the correct mark weight** — a 2-mark and a 16-mark answer are structurally different artifacts and universities reward the format.

*Mechanism:* RAG + generation, **lightly agentic**: retrieve → assess coverage → re-retrieve or **refuse**. **Why agentic:** the refuse-when-your-notes-don't-cover-it loop is what makes it honest, and it doubles as a retrieval-quality signal you can measure.

### 4. 🤖 Tutor Chat — the escalation agent

When Tiers 0 and 1 don't land, the student opens a chat **scoped to this concept and this question**. The tutor explains with examples and **works through the actual PYQ step by step** — not a generic textbook example.

**What makes it not-just-ChatGPT** (this is the whole justification for building it):

| | Generic chatbot | Precedent's tutor |
|---|---|---|
| Context | Whatever you paste | This concept, this cluster, **its versions in other years**, your notes, your mastery state — all pre-loaded from the graph |
| Prerequisites | Guesses | **Walks the actual prerequisite chain**: *"you're stuck on BCNF because you don't have functional dependencies — let me teach that first"* |
| Examples | Invented | The way **your university** has actually asked it, across years |
| Claims | Unverifiable | Citable back to a paper/year/Q-number or your own notes |
| Scope | Unbounded | Refuses off-syllabus drift; it's a subject tutor, not a companion |

*Mechanism:* 🤖 **AGENT.** Tools: `get_concept`, `get_lesson`, `get_cluster_instances`, `get_prerequisite_chain`, `retrieve_user_notes`, `get_solved_similar`.
*Why an agent:* it must decide *mid-conversation* whether the block is conceptual, prerequisite, or notational, then fetch different evidence for each and change tack. That's a tool-using loop with an uncertain path, which is exactly the test.

**Three design decisions worth defending:**

1. **Context is injected at session start, not discovered.** Concept, cluster instances, prerequisite chain and mastery state are loaded from the graph up front, so the agent makes few tool calls. On a free tier, an agent that explores costs you the demo.
2. **The tutor respects the clock.** Night Before sessions carry a time budget. When it's nearly spent the tutor says *"you have 40 minutes and 3 topics left — here's the minimum for this one"* and closes the thread. A tutor that lets a cramming student rabbit-hole at 3am is actively harmful.
3. **Every escalation is logged as signal.** Concepts that trigger the most Tier-2 escalations are the genuinely hard ones. That feeds back into `study_cost(c)`, which sharpens ROI for every future student — **a data flywheel that costs nothing extra to build.**

Chat threads attach to the `learn_session` cursor, so closing the tab and returning resumes the conversation in place.

### 5. Attempt & Evaluate — the assessment agent 🤖

You write an answer cold. The evaluator infers the mark scheme **from the cluster's instances** (marks distribution, part structure across years), then diffs your answer point-by-point and assigns partial credit, mapping each missed point to a concept.

*Mechanism:* **full agent.** Tools: `get_cluster_instances`, `retrieve_user_notes`, `get_concepts`. **Why an agent:** multi-step, retrieval-backed, and judgment-heavy — inferring an unwritten mark scheme then arguing partial credit against it is not a single call.

### 6. Gap Map

Attempt history projected onto the concept graph. Not "you scored 62%" but *"you've mastered concepts worth 41% of expected marks; your largest gap is Functional Dependencies (~14 marks), and three concepts you're failing depend on it."*

*Mechanism:* **graph traversal + aggregation in code**; one LLM call only to phrase the explanation. **Why:** the diagnosis is arithmetic over edges. An agent cannot do statistics better than statistics.

### 7. Exam Simulator

Generates a plausible **next paper** — samples clusters by `p_next` while respecting the real template (unit coverage, OR-choice pairs, marks distribution, "answer any five"). Timed, full-length. For Mastery users it also injects **novel questions on 🔵 unexamined concepts**.

*Mechanism:* constrained sampling in **code**; LLM used only to generate a **variant** (changed scenario/numbers) so memorising the original doesn't help. **Why:** sampling under structural constraints is a solved algorithmic problem; only the surface rewording needs a model.

### 8. Recall Scheduler

Spaced repetition **weighted by expected marks** — a 16-mark cluster recurring yearly is scheduled aggressively; a one-off 2-marker isn't. (Anki treats every card equally; that's wrong for exams.)

*Mechanism:* **code.** Forgetting curve × marks weight, over a job queue.

### 9. Contribution & Trust

Students upload papers and resolve the review queue's uncertain merges. Contribution reputation; low-confidence clusters marked provisional.

*Mechanism:* queue + UI. **Why it exists:** it's how the corpus grows, and it's the honest answer to "where does the data come from."

### The agent/no-agent scorecard

**Three real agents, two lightly-agentic RAG loops, everything else deterministic.** The test applied: *an agent is justified only when the task is multi-step, needs tools, and has an uncertain tail requiring self-assessment.*

| Component | Mechanism |
|---|---|
| Segmentation | Rules + 1 structured-output call fallback |
| **Duplicate adjudication** | 🤖 **AGENT** |
| Concept extraction / syllabus mapping | 1 structured call |
| Prerequisite induction | 1 call proposes + statistics confirm |
| **Topic ROI / recurrence** | 🚫 **No LLM — statistical model** |
| Night Before optimizer | Code |
| **Teaching Engine** | RAG + generation, lightly agentic |
| Answer Studio | RAG + generation, lightly agentic |
| **Tutor Chat** | 🤖 **AGENT** |
| **Attempt & Evaluate** | 🤖 **AGENT** |
| **Learn Loop controller** | Code (state machine over the graph) |
| Gap Map | Code + 1 call to phrase |
| Exam Simulator | Code + 1 call for variants |
| Recall Scheduler | Code |

Note the Learn Loop controller specifically: teach → test → branch on failure → hop a prerequisite edge is a **finite state machine over a graph**, not an agent. It must be deterministic and resumable (a student closes the tab at 2am and returns). Making it an agent would trade auditability and resumability for nothing.

State this ratio explicitly in interviews. "Everything is an agent" reads as inexperience; "I applied this test and it justified agents in three of fourteen components — here's the one I *removed* after applying it" reads as judgment.

---

## The knowledge graph

**Nodes:** `Paper` · `Question` (one instance, one paper) · `Cluster` (canonical question) · `Concept` · `SyllabusUnit`

**Edges:**
```
Question ──instance_of──▶ Cluster       Cluster ──tests──▶ Concept  (weighted, multi-label)
Question ──appears_in──▶ Paper          Concept ──part_of──▶ SyllabusUnit
Concept  ──prerequisite_of──▶ Concept   User ──attempted──▶ Cluster (score)
```

### Prerequisite edges are **induced, not authored** — the anti-ALEKS defense

ALEKS/Embibe/Knewton ship **hand-authored** graphs built by curriculum teams over years. Precedent derives its graph from evidence:

1. **LLM proposes** candidate edges from concept definitions — cheap, plausible, unreliable alone
2. **Corpus structure confirms** — if A's questions cluster in Unit 2 and B's in Unit 4, and B's questions require A's vocabulary, that supports A→B
3. *(future work)* **Student response data adjudicates** — asymmetric conditional failure is the strongest signal, but needs real users. **Documented as future work; not demoed on synthetic data.**

Every edge carries provenance and confidence.

---

## The pipeline

```
 syllabus.pdf ──┐
 papers[] ──────┴──▶ QUEUE  (idempotent: content-hash on NORMALIZED text, not raw bytes)
                       │
   ┌───────────────────▼──────────────────────────────────────┐
   │ WORKER POOL (BullMQ, retries + DLQ, per-provider limiter) │
   │  1 extract    pdfjs-dist text+coords → Gemini vision fallback
   │  2 SEGMENT    atomic questions, sub-parts, marks, OR-groups  ← 4-6 days
   │  3 normalize + embed (local ONNX 384d) → pgvector
   │  4 retrieve top-k duplicate candidates
   │  5 🤖 ADJUDICATE  same | variant | different + confidence
   │  6 confidence gate:  >0.85 auto · <0.60 reject · else REVIEW QUEUE
   │  7 cluster merge/split  (optimistic concurrency, version check)
   │  8 concept extraction → syllabus alignment
   │  9 recompute recurrence stats
   └──────────────────────┬───────────────────────────────────┘
                          ▼
              ╔═══ THE SHARED GRAPH ═══╗
              ╚═══╤═══════════════╤════╝
              🌙 NIGHT BEFORE   📈 MASTERY
```

**Two hard constraints enforced in code, never in a prompt:**

- **The OR rule, stated precisely:** two questions may not merge **if and only if they share a paper AND an `or_group`**. `or_group_id` is per-paper, so the naive rule "never merge questions sharing an or_group" is *wrong* and dangerous — 2023 Q11(a) and 2024 Q13(b) are the same question sitting in different OR-slots, and those cross-year merges are precisely what the product exists to find. Get the rule too strong and recurrence counts come out **deflated with no error raised anywhere**; too weak and they come out inflated.
- The content hash is computed on **normalized extracted text** — the same paper differs byte-wise across sources, so raw-byte hashing silently fails to dedupe.

**Why segmentation is the schedule risk, not OCR:** recognition is easy (Gemini free tier = 1,500 req/day with vision; most archive PDFs are digital text that `pdfjs-dist` handles free). The hard part is `Q3 a) b) c)` with per-part marks, module headers, and OR-choice structure — plus a **coordinate-sort pass**, since `pdfjs-dist` gives text with coordinates but no reading-order guarantee on the multi-column layouts these papers sometimes use. **Segmentation ≈ 4–6 days (the sort pass is inside that estimate); recognition ≈ 2 days.** Skewed photocopy photos are a stretch goal, not a demo requirement.

---

## The ROI model — and how you prove it isn't a guess

**No LLM.** The product's core claim must be calibrated and defensible.

**Layer 1 — cluster appearance** (used when repetition is high):
```
p_next(k) ∝ w₁·decayed_frequency     // Σ λ^(years_ago), zeroed before syllabus revision
          + w₂·overdue_ratio         // gap_since_last / mean_gap  (renewal hazard)
          + w₃·unit_quota_pressure   // paper must fill N slots from this unit
          + w₄·marks_weight
```

**Layer 2 — concept expected marks** (robust in every regime, and what actually drives study order):
```
expected_marks(c) = Σ_k  p_next(k) × marks(k) × weight(k,c)
ROI(c)            = expected_marks(c) / study_cost(c)
```
In a **low-repetition** subject `p_next` flattens, but `expected_marks` stays meaningful because it sums across *many different* questions testing the same concept. The regime classifier shifts weight toward concept-level frequency and syllabus priors. **This is why the reframe makes the product work on subjects that would break a pure-recurrence system.**

**Evaluation — two headline numbers.** Hold out the most recent year:

| Metric | Claim it supports |
|---|---|
| **Top-k concept marks coverage** | *"Our top 10 concepts covered 71% of the actual marks in the held-out 2024 paper vs 38% for a syllabus-order baseline"* — **the primary number, and it works in every regime** |
| Top-k cluster coverage | Secondary; only meaningful for high-repetition subjects |
| Calibration curve | Of clusters called 70% likely, how many appeared? |

Baselines to beat: **naive syllabus order** (what students actually do), uniform-random, and raw frequency without recency. The concept-level metric is the one to lead with — it degrades gracefully and cannot be dismissed by "but questions don't repeat in my subject."

---

## Data model (Postgres 16 + pgvector)

**Shared:** `universities` · `regulations` · `subjects(university_id, regulation_id, code)` ← corpus key · `papers(subject_id, session, year, content_hash UNIQUE per subject, status)` · `questions(paper_id, q_number, part_label, text, marks, or_group_id, embedding vector(384))` · `clusters(subject_id, canonical_text, marks_band, version, confidence, status)` · `question_cluster(question_id, cluster_id, similarity, decided_by, confidence)` · `concepts` · `cluster_concepts(weight)` · `syllabus_units(unit_no, title, hours)` · `concept_units` · `concept_edges(kind, confidence, evidence)` · `cluster_stats` (materialized) · `answer_cache(canonical_text_hash, marks_band, body, sources)` ← **shared** · `review_queue`

⚠️ **`answer_cache` is keyed on `canonical_text_hash`, NOT `cluster_id`.** Clusters are mutable by design (OCC merge/split), so an id-keyed cache orphans entries on merge and serves stale answers under a reused id on split. Content-addressing makes merges and splits naturally cache-safe and gives free reuse when two clusters turn out to be the same question. The alternative — id keys plus explicit invalidation inside the merge/split transaction — is more code and more bugs.

**Also shared:** `concept_stats(concept_id, expected_marks, study_cost_min, roi, escalation_rate, evidence_cluster_count)` (materialized) · `subject_regime(subject_id, repetition_rate, regime, computed_at)` · `lesson_cache(concept_content_hash, depth, body, sources)` ← **shared, same amortization as `answer_cache`**

**Private:** `users(college, dept, university_id, regulation_id)` · `user_sources(kind, content, embedding)` · `attempts(cluster_id, answer, score, breakdown)` · `mastery(concept_id, score, due_at)` · `learn_sessions(user_id, subject_id, mode, budget_min, plan JSONB, cursor, state)` ← **the Learn Loop must be resumable; a student closes the tab at 2am and comes back** · `tutor_sessions(learn_session_id, concept_id, cluster_id, transcript JSONB, tokens_used, resolved)` · `escalations(user_id, concept_id, from_tier, to_tier, at)` ← feeds `concept_stats.escalation_rate`

**Indexes:** HNSW on `questions.embedding` and `concepts.embedding`; btree on `(subject_id, year)`, `(cluster_id)`, `(origin, status)`.

**Optimistic concurrency on merge/split:** `clusters.version` integer. A worker reads at version N and writes `WHERE version = N`; zero rows affected → re-read and retry. Merges touching two clusters lock both rows **in id order** inside one transaction to avoid deadlock.

**Migrations:** numbered `NNN_*.sql` in a transaction, tracked in `schema_migrations`. No boot-time `CREATE TABLE` (the mistake CodeVault made).

---

## Tech stack, with reasons

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + Vite + **TypeScript**, Tailwind, React Flow, Zustand | TS matters with a schema this size; React Flow is the graph UI |
| Backend | Node + **Fastify** + TypeScript | Faster than Express, first-class schema validation |
| DB | **Postgres 16 + pgvector** (Neon free) | One store for relational + vector; hybrid SQL queries a vector DB can't do |
| Queue | **Redis + BullMQ** (Upstash free) | Retries, DLQ, rate limiters, scheduled jobs — all four needed |
| Blobs | Cloudflare R2 / Supabase Storage | Original PDFs for the citation trail |
| Embeddings | **local ONNX all-MiniLM-L6-v2 (384d)** primary, Gemini fallback | Zero cost, no rate limit, works offline in a demo |
| LLM | Gemini free tier → Groq fallback | 1,500 req/day incl. vision; **Groq is the primary for Tutor Chat** — token latency is what makes a tutor feel alive |
| Streaming | SSE for tutor tokens; WebSocket for ingest progress | Different shapes: chat is one-way server→client, ingest needs bidirectional |
| PDF | `pdfjs-dist` (text + coordinates) | Coordinates make segmentation tractable; keeps one language, no Python sidecar |
| Deploy | Vercel + Railway + Neon + Upstash | Live URL in week 1 |

---

## Build order (5–6 weeks)

| Week | Deliverable |
|---|---|
| **1** | Repo, migrations, auth, upload + **idempotency**, extraction, blob storage, **deployed skeleton with live URL** |
| **2** | **Segmentation** (the hard one) + a review UI to correct it. Seed OS/Networks/DBMS/DSA syllabi + papers |
| **3** | Embeddings, candidate retrieval, **🤖 Adjudicator agent**, confidence gate, review queue, **OCC merge/split** |
| **4** | Concept extraction, syllabus alignment, graph assembly, **regime classifier + ROI model + held-out evaluation** |
| **5** | **Recurrence Atlas UI**, **🎓 Teaching Engine**, **🤖 Attempt & Evaluate**, **Learn Loop** state machine, escalation ladder Tiers 0–1 |
| **6** | **🤖 Tutor Chat** (streaming), **Night Before** optimizer + Mastery traversal, Answer Studio, Exam Simulator, Gap Map, Scheduler (thin), README + demo video |

Teaching Engine, Attempt & Evaluate and the Learn Loop move **ahead** of the mode UIs — the loop is the product, and the two modes are thin policies that select and order concepts for it. Building a mode UI before the loop exists would be building a shell around nothing.

**Seed corpus:** user-supplied PDFs for **OS, Networks, DBMS, DSA** (syllabus + papers per subject). User-supplied avoids any scraping/ToS question. Multiple subjects proves the pipeline isn't hand-tuned to one paper format. ⚠️ Anna University **R2021 has only ~3–4 sittings** per subject — bridge to **R2017** papers with syllabus-version discounting to get enough history. This makes that feature load-bearing rather than decorative.

⚠️ **Decide the evaluation protocol in Week 2, not Week 4.** Held-out evaluation needs train years *plus* a test year. With 4 sittings you get 3 train / 1 test, and a headline number computed from three papers dies to one interviewer question. **When seeding, count actual sittings per subject after the R2017 bridge.** If any subject lands under ~6, either drop it from the evaluation set or switch to **leave-one-year-out cross-validation pooled across all four subjects**, which yields far more folds from the same corpus. Discovering the corpus is too thin in Week 4 costs the headline result with two weeks left.

🔒 **`.gitignore` the corpus directory before the first seed commit.** This repo goes on GitHub for recruiters; redistributing university question papers is a different question from using them locally. Seed PDFs stay on disk — the repo holds the loader plus a small synthetic fixture set for tests.

---

## Documents to create at `C:\Users\L Melvin Denish\projects\Precedent\`

```
README.md              product pitch, live URL, demo video, prior-art note
docs/PRD.md            problem, users, two modes, features, success metrics, non-goals
docs/ARCHITECTURE.md   services, pipeline, queues, concurrency, deployment, sequence diagrams
docs/DATA_MODEL.md     full schema, indexes, public/private split, migration strategy
docs/AGENTS.md         the agent/no-agent scorecard + reasoning, tool defs, prompts, gates
docs/PEDAGOGY.md       concepts-not-questions reframe, ROI model, regime classifier,
                       Learn Loop state machine, escalation ladder, lesson grounding + depths
docs/EVALUATION.md     held-out protocol, baselines, cluster precision/recall, seg accuracy
docs/PRIOR_ART.md      ALEKS, LearnOpt, BLUEX v2, QDup, Embibe, NotebookLM + what's actually new
docs/ROADMAP.md        6-week plan, cut order, future work
```

`PRIOR_ART.md` is not optional. **Naming your own prior art before an interviewer finds it converts the weakest point into the strongest signal.**

---

## Honest positioning

Every pipeline *stage* is published — BLUEX v2 (OCR→segment→dedupe on university exams), QDup (near-duplicate detection over 114,804 CBSE questions), LLM-as-Judge (question→syllabus mapping). Mastery Mode's prerequisite-ordered path is adjacent to LearnOpt.

**Say this plainly:** teaching concepts in prerequisite order with adaptive assessment *is* adaptive learning, and ALEKS/Knewton/Embibe have done it for years. Do not pretend otherwise.

**The claim that survives scrutiny:**

> Every existing adaptive-learning system teaches from a **pre-authored catalog**. Precedent derives what to teach, in what order, and *at what angle* from a **contributed corpus of one university's own exam papers plus the student's own notes** — so the pedagogical emphasis comes from how that university actually examines the concept, not from a textbook's ordering. Nothing ships that. And the corpus property is what forces the interesting engineering: duplicate uploads, adversarial scans, no ground truth, and clusters that merge and split as the corpus grows. Plus the syllabus×papers coverage matrix, the regime-adaptive ROI model with held-out evaluation, and a cram optimizer constrained by the paper's OR-choice template.

The sharpest one-line version: **ALEKS knows what you're ready to learn. Precedent knows what your examiner is going to ask, and teaches you that.**

This is **deployment novelty**, not research novelty. Research novelty is unreachable solo in 6 weeks — LearnOpt proves it. Deployment novelty is reachable and is a legitimate answer to "what's new here?"

**Cut order if time compresses:** contribution *reputation* mechanics (the review queue itself stays — reputation has nothing to act on in a single-user demo) → Recall Scheduler → Gap Map → Exam Simulator → Answer Studio's personalized tier → Mastery mode's full-syllabus traversal (Night Before alone still demonstrates the loop).

**Never cut:** the citation trail · the confidence gate + review queue · the held-out evaluation · **the Teaching Engine, the Learn Loop, and Tutor Chat**. The first two are the product — without them this is a question-prediction tool, which is the fragile thing the reframe exists to fix. Tutor Chat is the escalation floor: without it a stuck student has nowhere to go, and the whole loop dead-ends.

---

## Verification

- **W1:** Upload the same paper 5× under different filenames → exactly 1 `papers` row, 4 contributor credits, zero re-processing. Kill a worker mid-job → the job resumes from the queue.
- **W2:** Hand-label question boundaries on 3 papers across 2 subjects → report segmentation precision/recall. **Assert no same-paper OR-pair is ever emitted as a single question.** Also: **count sittings per subject after the R2017 bridge and lock the evaluation protocol** (held-out year vs. pooled leave-one-year-out) before building toward it.
- **W3:** Hand-label ~150 question pairs → cluster precision/recall. **Assert a known cross-year OR-slot pair (e.g. 2023 Q11a vs 2024 Q13b) DOES merge** — this is the case the over-strong OR rule silently breaks. Drive two workers at the same cluster concurrently → assert the version conflict is detected and retried, not silently lost. Assert the confidence gate routes the uncertain tail to review rather than auto-applying. Merge two clusters → assert cached canonical answers survive (content-hash key), with nothing orphaned or stale.
- **W4:** Hold out the most recent year per subject; report **top-k concept marks coverage** vs a naive syllabus-order baseline, plus a calibration curve. **This is the headline number.** Also assert the **regime classifier** labels a genuinely low-repetition subject as `low` and that its ROI ranking still beats syllabus order — this is the proof the reframe works.
- **W5:** Generate a lesson for a concept whose source notes deliberately omit it → assert it **flags the gap instead of fabricating**. Attempt a question with a deliberately partial answer → assert the evaluator names the specific missing points and maps them to concepts. Fail a test → assert the Learn Loop hops to the correct prerequisite. Kill the session mid-loop and resume → assert it continues from the same cursor.
- **W6:** Night Before with a 6-hour budget → assert every unit reaches minimum viable coverage before any unit is deepened, and that the reserve budget absorbs a prerequisite hop without blowing the total. Verify every displayed statistic drills to a real paper/year/Q-number. Simulator output must satisfy the paper template (unit coverage, OR pairs, marks total). **Tutor Chat:** assert it opens with graph context already loaded (few tool calls, not exploratory); assert it declines an off-syllabus question instead of answering; assert it walks to the correct prerequisite when told "I don't understand this at all"; assert it truncates and summarises when the session's time budget nears zero; assert an escalation writes a row that moves `concept_stats.escalation_rate`.
- **Offline check before any demo:** disconnect the network and confirm local ONNX embeddings still serve retrieval.
