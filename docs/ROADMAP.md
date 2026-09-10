# Precedent — Roadmap

5-6 weeks, solo, free-tier APIs.

---

## Week 1 — Foundations and a live URL

| Deliverable | Notes |
|---|---|
| Monorepo: `web`, `api`, `worker`, `shared` | TypeScript throughout |
| Migrations 001-006, `npm run migrate` | No boot-time DDL |
| Auth: register, login, JWT | Secrets from env only |
| Blob storage wiring | Original PDFs, for the citation trail |
| `POST /upload` with **idempotency** | Content-hash on normalized text |
| BullMQ queues, worker entrypoint, DLQ | Retries with backoff and jitter |
| **Deployed: Vercel + Railway + Neon + Upstash** | **A live URL exists from week 1** |
| `.gitignore` excludes the corpus | Before the first seed commit |

**Why deploy first.** A live URL that exists from the start can never become the thing that got cut in week 6. Neon suspends idle compute, so add a keep-alive ping to `/health` or state the cold-start delay in the README.

**Exit test:** upload the same paper 5x under different filenames, get 1 row and 4 contributor credits. Kill a worker mid-job, watch it resume.

---

## Week 2 — Segmentation, the hard part

| Deliverable | Notes |
|---|---|
| `pdfjs-dist` extraction with coordinates | Gemini vision fallback for empty text layers |
| **Coordinate-sort pass** | Reading order for multi-column papers |
| Rule-based segmentation | Question numbers, sub-parts, marks, unit headers |
| **OR-group detection** | The load-bearing case |
| Structured-call fallback | For low-confidence rule output |
| Paper template extraction | Units, slots, OR pairs, marks -> `papers.template` |
| Segmentation review UI | Corrections stored, so accuracy is measurable |
| **Seed OS, Networks, DBMS, DSA** | Syllabi plus papers, user-supplied PDFs |

**Budget 4-6 days for segmentation alone.** Recognition is ~2 days; the structure is the problem.

### Two decisions that must be made this week, not later

1. **Count sittings per subject after the R2017 bridge.** If any subject is under ~6, drop it from the evaluation set or switch to pooled leave-one-year-out CV. Discovering a thin corpus in week 4 costs the headline result.
2. **Lock the evaluation protocol** and write it into EVALUATION.md.

**Exit test:** hand-label boundaries on 3 papers across 2 subjects; report segmentation precision and recall. Assert no same-paper OR-pair is emitted as one question.

---

## Week 3 — Clustering and concurrency

| Deliverable | Notes |
|---|---|
| Local ONNX MiniLM embeddings | 384d, offline-capable |
| pgvector HNSW candidate retrieval | Scoped to subject, excluding same paper |
| **Adjudicator agent** | same / variant / different plus confidence |
| **Confidence gate** | Auto / review / reject |
| Review queue plus UI | Human decisions become labelled data |
| **Optimistic concurrency** on merge and split | Version check; two-cluster lock ordered by id |
| ~150 hand-labelled question pairs | The most valuable few hours in the project |

**Exit tests:** cluster precision and recall on the labelled set. **Assert a known cross-year OR-slot pair DOES merge** (the silent failure of an over-strict rule). Drive two workers at one cluster; assert the version conflict is retried, not lost.

---

## Week 4 — The graph and the headline number

| Deliverable | Notes |
|---|---|
| Concept extraction, syllabus alignment | Structured calls, batched |
| Prerequisite induction | LLM proposes, corpus confirms, evidence stored |
| `subject_lineage` and version discounting | R2017 bridged into R2021 |
| **Regime classifier** | high / medium / low, from measured repetition rate |
| **ROI model** | Layer 1 cluster p_next, Layer 2 concept expected marks |
| `cluster_stats`, `concept_stats`, `subject_regime` | Recomputed by worker after ingest |
| **Held-out evaluation harness** | Baselines: naive syllabus order, raw frequency, random |

**Exit test — the headline.** Top-k concept marks coverage on a held-out year versus naive syllabus order, plus a calibration curve. Also assert the regime classifier labels a genuinely low-repetition subject as `low`, **and that its ROI ranking still beats syllabus order** — that is the proof the concept reframe works.

---

## Week 5 — Teaching and the loop

| Deliverable | Notes |
|---|---|
| **Recurrence Atlas UI** | React Flow. Every stat drills to paper/year/Q-number |
| **Teaching Engine** | Four-way grounding, `cram` and `full` depths, `lesson_cache` |
| Gap flagging | Flags rather than fabricates when sources omit a topic |
| **Attempt and Evaluate agent** | Mark scheme inferred from cluster instances |
| **Learn Loop state machine** | Persisted to `learn_sessions`, resumable |
| Escalation ladder Tiers 0-1 | Cached answers and lessons |

The loop is built **before** the mode UIs, because the modes are thin selection policies over it. Building a mode UI first would be a shell around nothing.

**Exit tests:** a lesson for a concept the notes deliberately omit must flag the gap, not invent. A deliberately partial answer must be scored with the specific missing points named and mapped to concepts. Fail a test and assert the loop hops to the correct prerequisite. Kill a session mid-loop and assert it resumes at the same cursor.

---

## Week 6 — Modes, tutor, and the demo

| Deliverable | Notes |
|---|---|
| **Tutor Chat agent** | SSE streaming, Groq primary, context injected at session start |
| Scope refusal, time-budget awareness, escalation logging | The three defensible design decisions |
| **Night Before optimizer** | Unit-constrained knapsack plus 15% reserve |
| **Mastery traversal** | Full syllabus, prerequisite order, ROI breaks ties |
| Answer Studio, canonical and personalized | Correct mark weight |
| Exam Simulator | Constrained sampling plus LLM variants |
| Gap Map, Recall Scheduler | Thin |
| **README with live URL, numbers, demo video** | Worth more than any single feature |

**Exit tests:** Night Before with a 6-hour budget must reach minimum viable coverage in every unit before deepening any. The reserve must absorb a prerequisite hop without overrunning. Tutor must decline an off-syllabus probe, walk to the right prerequisite when told "I do not understand this at all", and close down when the budget nears zero. **Unplug the network and confirm retrieval still works.**

---

## Cut order

If time compresses, cut in exactly this order:

1. Contribution **reputation** mechanics — the review queue stays; reputation has nothing to act on in a single-user demo
2. Recall Scheduler
3. Gap Map
4. Exam Simulator
5. Answer Studio personalized tier
6. Mastery mode's full-syllabus traversal — Night Before alone still demonstrates the loop

## Never cut

- **The citation trail.** Every statistic drills to paper, year, question number. Without it this is an LLM guessing.
- **The confidence gate and review queue.** Proves the system is built for where LLM judgment fails.
- **The held-out evaluation.** The difference between asserting quality and measuring it.
- **The Teaching Engine and Learn Loop.** Without them this is a question-prediction tool, which is the fragile thing the concept reframe exists to fix.
- **Tutor Chat.** The escalation floor. Without it a stuck student has nowhere to go and the loop dead-ends.

---

## Future work

| Item | Why deferred |
|---|---|
| **Prerequisite adjudication from student response data** | Asymmetric conditional failure is the strongest edge signal, but needs real users. Will not be demoed on synthetic data. |
| College-scoped corpora for autonomous colleges and internal CAT exams | Needs a second, narrower scope key |
| Photocopy and phone-photo OCR | Archive PDFs are mostly digital text; this is a robustness project of its own |
| Multi-language papers | Another extraction axis, no demo payoff |
| Cross-university concept transfer | The same concept taught under two regulations could share lessons |
| Contribution reputation and moderation at scale | Only matters with real multi-user load |
