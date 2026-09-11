# Precedent

> Your syllabus tells you what you *could* be asked.
> Precedent tells you what you **will** be — and then teaches you it.

Students pool their university's **syllabus + past question papers**. Precedent shreds every paper into individual questions, recognises when the same question reappears across years in different wording, aligns everything to the syllabus, and assembles a **shared knowledge graph of what a subject actually examines**.

Then it teaches you — highest-return topics first, in lessons angled the way *your* university actually asks them, tested against *real* past questions.

Every number in the product drills down to **paper -> year -> question number**.

---

## The problem

It's five days before exams. Five subjects. You open Unit 1, page 1, run out of time at Unit 3, and walk in having studied the wrong things.

Meanwhile the information you needed was sitting in eight PDFs nobody has all of — in senior WhatsApp groups, Drive folders and xerox shops. Students already know this and already try to solve it by hand:

> *"many faculty in colleges are permanent. So there are about **50-70% questions from pyq papers**."*
> — r/Btechtards

> *"previous year paper le, sabke screenshot le, chatgpt ko bol ye papers ki pattern samajh, **repeated topics and repeating questions ki list de**"*
> — r/NirmaUniversity_Ahmd

That is a product being simulated by hand, badly, every semester, by millions of students. Studocu even hosts a file literally titled `AI MOST IMPORTANT QUESTIONS (Repeated 4 Years)` — a student computed recurrence manually and uploaded a static PDF.

**The output is in demand. The computation is done by hand. No platform performs it.**

---

## How it works

```
 syllabus + past papers --> shred into atomic questions
                        --> cluster near-duplicates across years
                        --> map to concepts and syllabus units
                        --> compute per-concept expected marks (ROI)
                        --> TEACH the highest-ROI concepts
                        --> TEST with real past questions
                        --> fail? walk down a prerequisite edge, re-teach
```

### Concepts, not questions

Predicting questions is fragile — some subjects barely repeat, and reading a model answer isn't learning anyway. But **concept recurrence is robust where question recurrence is not**: the syllabus is fixed, so examiners keep testing the same ideas in new clothes.

So questions became *evidence* (which concepts carry marks, and how they're angled) and *assessment* (real PYQs prove you learned it). **Concepts are the unit of study.**

The system measures each subject's repetition regime and adapts: high-repetition subjects get sharp per-question predictions; low-repetition subjects fall back to concept-level frequency and syllabus priors — and the UI says which mode it's in.

### Two modes, one engine

|  | Night Before (6-10 hrs) | Mastery (2-6 weeks) |
|---|---|---|
| Selection | Top concepts by ROI, subject to unit coverage | Whole portions — full syllabus |
| Ordering | ROI-descending | Prerequisite order |
| Lesson depth | 5-min exam-angled micro-lesson | Full treatment with derivations |
| On failure | One prerequisite hop, then move on | Recurse to root cause, re-teach |

### The escalation ladder

| Tier | Trigger | Cost |
|---|---|---|
| **0** — cached canonical answer, cited | you recognise the question | **0 tokens**, shared |
| **1** — cached micro-lesson, exam-angled | you don't know the topic | **0 tokens**, shared |
| **2** — Tutor chat (agent) | still stuck, or prerequisites missing | per-student, on demand |

Tiers 0 and 1 are amortized across every student sharing the corpus. Only Tier 2 spends per-student tokens. **That's what makes this viable on free-tier APIs.**

---

## What's actually new here

Every stage of the ingestion pipeline is published prior art — [BLUEX v2](https://arxiv.org/abs/2606.22723) (OCR -> segment -> dedupe on university entrance exams), [QDup](https://arxiv.org/abs/2301.05150) (near-duplicate detection over 114,804 CBSE questions), LLM-as-Judge for question-to-syllabus mapping. And teaching concepts in prerequisite order with adaptive assessment *is* adaptive learning, which ALEKS has done since the 1990s.

**The claim that survives scrutiny:**

> Every existing adaptive-learning system teaches from a **pre-authored catalog**. Precedent derives what to teach, in what order, and *at what angle* from a **contributed corpus of one university's own exam papers plus the student's own notes**. And that corpus property is what forces the interesting engineering: duplicate uploads, adversarial scans, no ground truth, and clusters that merge and split as the corpus grows.

In one line: **ALEKS knows what you're ready to learn. Precedent knows what your examiner is going to ask, and teaches you that.**

This is *deployment* novelty, not research novelty. See [docs/PRIOR_ART.md](docs/PRIOR_ART.md) for the full, unflattering accounting.

---

## Architecture at a glance

```
 uploads --> QUEUE (idempotent: content-hash on NORMALIZED text)
                |
   +------------v--------------------------------------+
   | WORKER POOL - BullMQ, retries + DLQ, rate limiters |
   |  extract -> SEGMENT -> embed -> retrieve candidates|
   |  -> ADJUDICATE (agent) -> gate -> REVIEW QUEUE     |
   |  -> cluster merge/split (optimistic concurrency)   |
   |  -> concepts -> syllabus align -> recompute ROI    |
   +------------+--------------------------------------+
                v
      +=== SHARED MASTER GRAPH ===+
      |  keyed (university,       |
      |   regulation, subject)    |
      +==+=====================+==+
       NIGHT BEFORE        MASTERY
```

**Three agents out of fourteen components.** Duplicate adjudication, tutor chat, and answer evaluation earned it; everything else is deterministic code or a single LLM call. See [docs/AGENTS.md](docs/AGENTS.md) for the test applied and what failed it.

**Stack:** React + TypeScript + React Flow · Fastify · Postgres 16 + pgvector · Redis + BullMQ · local ONNX embeddings (offline-capable) · Gemini + Groq free tiers. Deployed on AWS free tier — see [DEPLOY_AWS.md](docs/DEPLOY_AWS.md).

---

## Documentation

| Doc | What's in it |
|---|---|
| [PRD.md](docs/PRD.md) | Problem, users, modes, features, success metrics, non-goals |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Services, pipeline, queues, concurrency, deployment |
| [DATA_MODEL.md](docs/DATA_MODEL.md) | Schema, indexes, public/private split, migrations |
| [PEDAGOGY.md](docs/PEDAGOGY.md) | The concepts-not-questions reframe, ROI model, Learn Loop |
| [AGENTS.md](docs/AGENTS.md) | Agent/no-agent scorecard with reasoning, tools, gates |
| [EVALUATION.md](docs/EVALUATION.md) | Held-out protocol, baselines, metrics |
| [PRIOR_ART.md](docs/PRIOR_ART.md) | What already exists, and what's genuinely ours |
| [ROADMAP.md](docs/ROADMAP.md) | 6-week build order, cut order, future work |
| [DEPLOY_AWS.md](docs/DEPLOY_AWS.md) | AWS free-tier deployment, both paths, verification |

---

## Status

In development. See [ROADMAP.md](docs/ROADMAP.md).

---

## A note on the corpus

Question papers are **not committed to this repository**. The seed corpus lives locally; the repo contains the loader and a small synthetic fixture set for tests. See `.gitignore`.
