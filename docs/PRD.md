# Precedent — Product Requirements Document

**Status:** Approved, pre-implementation
**Owner:** L Melvin Denish
**Target:** Portfolio project for AI/LLM + backend internship applications
**Timeline:** 5-6 weeks

---

## 1. Problem

### 1.1 The study problem

A student has five days and five subjects. The syllabus lists everything the examiner *could* ask; the exam asks a narrow, repetitive subset. The gap between those two documents is where all wasted study time goes.

That gap is only visible **statistically, across many papers** — which is why no individual student can see it. No one owns all eight papers. They live in senior WhatsApp groups, Drive folders, and xerox shops.

### 1.2 Evidence this is real

Students quantify it themselves and already attempt the computation manually:

| Source | Evidence |
|---|---|
| r/Btechtards (56 votes) | "many faculty in colleges are permanent. So there are about 50-70% questions from pyq papers." |
| r/Btechtards (NIT student) | "definitely do pyq (many questions repeat directly from pyq)" |
| r/NirmaUniversity_Ahmd | "previous year paper le, sabke screenshot le, chatgpt ko bol ye papers ki pattern samajh, repeated topics and repeating questions ki list de" |
| Studocu | Hosts `AI MOST IMPORTANT QUESTIONS (Repeated 4 Years)` for East Point College — a student hand-computed recurrence and uploaded a static PDF |

The demand is proven. The computation is manual. **No platform performs it.**

### 1.3 Why existing tools do not solve it

| Tool | Why it fails |
|---|---|
| **NotebookLM** | Document Q&A over sources you already own. No per-question representation, so it cannot count. No cross-document statistical layer. 50 sources/notebook, 50 chats/day. No persistent learner model. |
| **Studocu / Course Hero** | PDF repositories with document-level AI. Store papers as opaque blobs; cannot individuate or cluster questions. |
| **ALEKS / Knewton / Embibe** | Real adaptive learning, but over a **pre-authored closed catalog**. Cannot ingest your professor's syllabus or your university's papers. |
| **Anki / Quizlet** | Flat cards you must author yourself. No marks weighting, no exam evidence. |
| **ChatGPT** | Will confidently invent recurrence statistics it has no data for. |

---

## 2. Users

### 2.1 Primary personas

**Ravi — the Night Before student (6-10 hours out)**
Wants maximum marks per hour. Cannot afford to attempt-then-learn; needs to be *taught fast* and to know he has covered enough. Will abandon anything that costs more than a few minutes before producing value.
*Success:* walks in having covered a measurably large share of expected marks, and knows the number.

**Priya — the Mastery student (2-6 weeks out)**
Wants genuine competence and a high grade. Willing to attempt questions cold and be told she is wrong. Wants full syllabus coverage including topics that have never been examined.
*Success:* full coverage in prerequisite order, with diagnosed and closed gaps.

### 2.2 Contributor persona (overlaps both)

Uploads papers and resolves ambiguous merges in the review queue. Motivated by the corpus getting better for their own subject.

### 2.3 Explicit non-user

Anyone outside a university with centrally-set exams and a published syllabus. v1 does not serve autonomous colleges or internal CAT exams.

---

## 3. Product principles

1. **Every number is clickable to its source.** A statistic without a paper/year/question-number trail does not ship. This is the only thing separating Precedent from an LLM guessing, and it is non-negotiable.
2. **The system says what it does not know.** Low-repetition subjects are labelled as such. A lesson whose sources do not cover the topic flags the gap instead of inventing content.
3. **Teach, do not just predict.** Reading a model answer is not learning. Prediction ranks; teaching delivers.
4. **Cheap tiers first.** A student gets unstuck at the lowest-cost tier that works. Expensive generation is opt-in.
5. **Deterministic where determinism is possible.** Agents are used where judgment under uncertainty is genuinely required, and nowhere else.

---

## 4. The core model

### 4.1 Concepts are the unit of study

Questions are **evidence** (which concepts carry marks, and how they are angled) and **assessment** (real PYQs prove learning). Concepts are what gets taught.

Rationale: question recurrence is fragile — some subjects barely repeat, and a repeated question is useless if you do not understand the concept. Concept recurrence is robust because the syllabus is fixed.

### 4.2 Corpus scoping

```
CORPUS KEY = (university, regulation, subject_code)
```

Anna University R2021 applies to all affiliated non-autonomous colleges and **papers are set centrally** — every affiliated student sits the same paper. College and department are therefore *user attributes*, not graph keys.

One shared master graph per key. Consequences:

- A paper uploaded by 40 students is processed **once**
- Canonical answers and lessons are generated **once** and served to all
- Recurrence statistics improve for everyone with every upload
- LLM cost is **per-corpus**, not per-user

### 4.3 The coverage matrix

|  | Appears often | Appears rarely | Never appeared |
|---|---|---|---|
| **In syllabus** | Certain core — cram this | Long tail — mastery users | Unexamined / possibly overdue |
| **Not in syllabus** | Syllabus changed — discount those papers | — | — |

This requires **both** syllabus and papers. Papers alone tell you what recurred; they cannot tell you what exists.

---

## 5. Features

### 5.1 Must ship (never cut)

| # | Feature | Description |
|---|---|---|
| M1 | **Ingestion pipeline** | Upload syllabus + papers; extract, segment, cluster, map to concepts. Idempotent. |
| M2 | **Recurrence Atlas** | Navigable graph. Units as regions, concepts sized by expected marks, clusters attached. Every stat drills to source. |
| M3 | **Teaching Engine** | Micro-lessons grounded in syllabus + your notes + textbook + **how the exam actually angles it**. Two depths: cram and full. |
| M4 | **Learn Loop** | Teach, then test with real PYQs. Pass advances; fail hops down a prerequisite edge. Resumable. |
| M5 | **Tutor Chat** | Agent escalation tier. Explains with examples, solves the actual PYQ, walks the real prerequisite chain. |
| M6 | **Attempt and Evaluate** | Infers the mark scheme from cluster instances; diffs your answer point-by-point; maps misses to concepts. |
| M7 | **Confidence gate + review queue** | Uncertain merges go to humans, never auto-applied. |
| M8 | **Held-out evaluation** | Measured accuracy against baselines. The headline result. |

### 5.2 Should ship

| # | Feature | Description |
|---|---|---|
| S1 | **Night Before mode** | Time-budgeted ROI cram path with live expected-marks counter |
| S2 | **Mastery mode** | Full-syllabus traversal in prerequisite order |
| S3 | **Answer Studio** | Canonical (shared, cached) plus personalized (your notes) model answers at correct mark weight |

### 5.3 Nice to have (cut first, in this order)

| Order | Feature |
|---|---|
| 1st | Contribution reputation mechanics — nothing to act on in a single-user demo |
| 2nd | Recall Scheduler |
| 3rd | Gap Map |
| 4th | Exam Simulator |

### 5.4 The escalation ladder

| Tier | Trigger | Serves | Cost |
|---|---|---|---|
| 0 | Recognises the question | Cached canonical answer, cited | 0 tokens, shared |
| 1 | Does not know the topic | Cached micro-lesson, exam-angled | 0 tokens, shared |
| 2 | Still stuck / missing prerequisites | Tutor chat agent | Per-student, on demand |

**Prerequisites surface proactively.** Before a student gets confused, the UI says "this needs Functional Dependencies, which you have not covered — 4 min lesson first?" The graph already knows; waiting for failure is the worse design.

---

## 6. Success metrics

### 6.1 Product quality — the numbers that go in the README

| Metric | Target | Why it matters |
|---|---|---|
| **Top-k concept marks coverage** (held-out year) | Beat naive syllabus order by a wide margin | **The headline.** Works in every repetition regime; cannot be dismissed with "questions do not repeat in my subject" |
| Cluster precision / recall | >= 0.90 precision on ~150 hand-labelled pairs | Wrong clusters mean wrong statistics |
| Segmentation precision / recall | Reported separately, hand-labelled | The known schedule risk; must be measured, not asserted |
| Calibration | Of clusters called 70% likely, ~70% appear | Honesty about uncertainty |
| Lesson gap-flag rate | Flags rather than fabricates when notes omit a topic | Principle 2, made measurable |

### 6.2 System quality

| Metric | Target |
|---|---|
| Duplicate upload | 5 identical uploads produce 1 paper row and 0 reprocessing |
| Worker crash | Job resumes from queue, no data loss |
| Concurrent cluster mutation | Version conflict detected and retried, never silently lost |
| Offline demo | Local ONNX embeddings serve retrieval with no network |

---

## 7. Non-goals

| Non-goal | Reason |
|---|---|
| Autonomous colleges and internal CAT exams | College-set papers never reach public archives; needs a second, narrower corpus scope |
| Per-faculty recurrence analytics | Affiliating-university papers carry no faculty or college identity. Showing per-faculty stats would be **fabricated data** |
| Photocopied phone-photo OCR | Stretch goal. Archive PDFs are mostly digital text |
| Multi-language / non-English papers | Adds an extraction axis with no payoff for the demo |
| Mobile app | Responsive web only |
| Real-time collaboration between students | The corpus is shared; the study session is single-player |
| Predicting exact question wording | The product predicts what will be examined, not verbatim text |

---

## 8. Key risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Segmentation complexity** — sub-parts, OR-choice, per-part marks, multi-column reading order | High, the schedule killer | 4-6 days budgeted explicitly. Review UI to correct failures. Measured, not assumed |
| **Thin corpus for evaluation** — R2021 has only ~3-4 sittings | High, kills the headline number | Bridge to R2017 with syllabus-version discounting. **Count sittings and lock the protocol in Week 2, not Week 4.** Fallback: pooled leave-one-year-out CV |
| Free-tier quota exhaustion | Medium | Tiers 0-1 amortized and cached; local ONNX embeddings; per-provider rate limiters |
| Prior-art challenge in interview | Medium | PRIOR_ART.md names it first, unflatteringly |
| Cluster corruption from an over- or under-strict OR rule | Medium, and silent | Rule stated precisely (same paper AND same or_group); both directions asserted in tests |

---

## 9. Open questions

1. Should low-confidence clusters be visible to students as "provisional", or hidden until reviewed? *(Leaning: visible with a badge — honesty principle.)*
2. Does study_cost per concept need a manual prior per concept kind, or is escalation-rate feedback enough once there is usage? *(Leaning: seed with prerequisite depth, refine from escalation data.)*
3. Should Mastery mode prerequisite ordering be strict, or may ROI break ties within a topological layer? *(Leaning: ROI breaks ties.)*
