# Precedent — Prior Art

An honest accounting of what already exists.

**Why this document is in the repository.** Naming your own prior art before an interviewer finds it converts the weakest point in a project into the strongest signal. Everything below was found by deliberately trying to kill this idea. Two earlier versions of it *were* killed, and are recorded here as well.

---

## 1. Ideas that were killed before this one

### 1.1 "Critical Path" — DEAD

Syllabus as a prerequisite DAG, knapsack study path under a time budget, knowledge-frontier diagnosis by walking down prerequisite edges.

| Prior art | What it already does |
|---|---|
| **ALEKS** (McGraw Hill) | Ships a feature named **"Ready to Learn"**: topics not yet learned but whose prerequisites are satisfied. That is the "knowledge frontier", as a product label, for roughly 30 years. Locates a student's state in ~25-30 questions over a ~350-concept domain. |
| **Knowledge Space Theory** (Doignon and Falmagne, 1985) | The theory underneath ALEKS. The frontier is the *outer fringe* of a knowledge state. |
| **LearnOpt**, [arXiv 2606.15349](https://arxiv.org/abs/2606.15349) (13 June 2026) | Indian exam PYQs 2016-2024, LLM-built exam knowledge graph, and — quoting the abstract — *"a knapsack-variant optimization over prerequisite-aware subgraphs with Bayesian Knowledge Tracing."* Public code and dataset. **The pitch, verbatim, three months old.** |
| **RPKT**, [arXiv 2508.11892](https://arxiv.org/abs/2508.11892) | *"Recursively traces prerequisite concepts in real-time until reaching a learner's actual knowledge boundary."* The downward-traversal mechanic, as its own paper. |
| **Knewton / Wiley alta** | Prerequisite knowledge graph; recommendation criteria named *"frontier learning, building on prerequisites, and remediation."* |
| **Embibe** | 74,000-concept knowledge graph with prerequisite edges and mastery propagation, across 500+ Indian exams. |
| **Math Academy** | Adaptive diagnostic explicitly to *"identify the student's knowledge frontier"*, then hierarchical spaced repetition where reviewing a topic credits its prerequisites. Strictly more sophisticated than a flat forgetting curve. |

**Verdict: dead as pitched.** Every pillar was separately prior art, and one 2026 paper combined all four in the same country and exam category.

### 1.2 "Halflife" — abandoned

A knowledge base that decomposes documents into atomic claims, predicts each claim's volatility, and re-verifies on a schedule.

Mechanism layer already occupied: **HALO** ([arXiv 2505.07509](https://arxiv.org/abs/2505.07509)) predicts per-fact half-lives; **Graphiti/Zep** ([arXiv 2501.13956](https://arxiv.org/abs/2501.13956)) does bi-temporal validity; **FActScore** and **SAFE** solved claim decomposition. The product layer had a genuine seam, but the idea was not student-focused, so it was dropped rather than killed.

---

## 2. Prior art for Precedent itself

### 2.1 Every pipeline stage is published

| Work | Stage it claims |
|---|---|
| **BLUEX v2**, [arXiv 2606.22723](https://arxiv.org/abs/2606.22723) | Brazilian university entrance exams: OCR, **segmentation into questions and subquestions**, and **duplicate question identification**. The ingestion pipeline, published, on university exams. |
| **QDup**, [arXiv 2301.05150](https://arxiv.org/abs/2301.05150) (WSDM 2023) | Unsupervised near-duplicate detection over **114,804 CBSE questions**. The clustering stage, published, on Indian exam questions, at a far larger scale than this demo will reach. |
| **LiveK12Bench**, arXiv 2605.26781 | OCR plus LLM parsing of exam PDFs into structured question fields. |
| **LLM-as-Judge in Education**, arXiv 2606.17507 | Mapping a question to syllabus topics and subtopics. The alignment stage. |

**None of these stages is novel here, and the documentation says so.**

### 2.2 Adaptive learning is decades old

Teaching concepts in prerequisite order with adaptive assessment is what ALEKS, Knewton, Embibe and Math Academy do. Precedent's Mastery mode is genuinely adjacent to LearnOpt. **Do not claim otherwise in an interview.**

### 2.3 Products in the adjacent space

| Product | What it is | Why it is not this |
|---|---|---|
| **Google NotebookLM** | Document Q&A over sources you supply. Quiz, flashcards, mind map as one-shot artifacts. | **No per-question representation**, so it cannot count anything. No cross-document statistical layer. No persistent learner model, no mastery state, no scheduling. Caps at 50 sources per notebook and 50 chats/day. You must already own every paper. |
| **Studocu** (~100M docs), Course Hero, Scribd | Document repositories with document-level AI. | Store papers as **opaque blobs**. Cannot individuate, cluster, or cite a question. See section 3. |
| **vtuadda, AKTU/VTU apps, FirstRanker** | PYQ archives, well organised by scheme and subject code. | Storage and retrieval of PDFs. No computation over them. |
| **Paper Predict, ANALYXX** | Exam question prediction. | **National exams with public corpora only.** Not university semester exams. |
| **findskill.ai "Exam Question Predictor"** | Claims to find "professor patterns". | Inspected: **a one-shot LLM prompt template** where the user manually types in the patterns they noticed. Not a product. |
| **Anki, SuperMemo, RemNote, Quizlet** | Spaced repetition. | Flat cards you author yourself. No marks weighting, no exam evidence, no concept graph. Only Math Academy propagates review credit through a hierarchy, and only inside its own closed catalog. |
| **Turbo AI, Coconote** (acquired by Quizlet, Feb 2026), **StudyFetch** | Lecture capture to study artifacts. | Generate artifacts, not models. No prerequisite structure, no expected-marks weighting. |

---

## 3. The evidence that the gap is real

Studocu hosts a document titled **`AI MOST IMPORTANT QUESTIONS (Repeated 4 Years)`** for East Point College of Engineering.

A student computed recurrence **by hand**, exported a static PDF, and uploaded it. Studocu stores it as an opaque blob — its document-level AI cannot cite the source questions and cannot recompute anything when a new paper arrives.

> **The output is demonstrably in demand. The computation is being done manually. No platform performs it.**

Students describe the manual process themselves: *"previous year paper le, sabke screenshot le, chatgpt ko bol ye papers ki pattern samajh, repeated topics and repeating questions ki list de"* (r/NirmaUniversity_Ahmd).

---

## 4. What is actually new

### 4.1 The claim

> Every existing adaptive-learning system teaches from a **pre-authored catalog**. Precedent derives what to teach, in what order, and **at what angle** from a *contributed corpus of one university's own exam papers plus the student's own notes* — so the pedagogical emphasis comes from how that university actually examines the concept, not from a textbook's ordering.
>
> And that corpus property is what forces the interesting engineering: duplicate uploads, adversarial scans, no ground truth, and clusters that merge and split as the corpus grows.

In one line: **ALEKS knows what you are ready to learn. Precedent knows what your examiner is going to ask, and teaches you that.**

### 4.2 The specific unclaimed pieces

1. **Composition over a contributed, un-curated, shared corpus.** ALEKS, Math Academy, Knewton and Embibe all operate over pre-authored content. None can ingest your professor's syllabus or your university's papers. This is the most defensible gap found.
2. **The syllabus x papers coverage matrix.** Papers alone say what recurred; the syllabus says what exists. Together they yield honest confidence and the "overdue" signal.
3. **Regime-adaptive ROI with held-out evaluation.** The model measures its own subject's repetition rate and degrades gracefully, then reports measured accuracy against a naive-syllabus-order baseline.
4. **A cram optimizer constrained by the paper's OR-choice template.** Nobody optimizes revision against the structural constraints of the actual paper under a time budget.
5. **Exam-angled lesson grounding.** Teaching a concept the way *this university* examines it requires that university's paper history. No textbook or general summarizer can produce it.

### 4.3 Deployment novelty, not research novelty

**Research novelty — a new method — is not reachable solo in six weeks. LearnOpt proves that.**

Deployment novelty — a composition of known methods over a corpus and a surface nobody ships — is reachable, and is a legitimate answer to "what is new here?" The distinction should be stated plainly rather than blurred.

---

## 5. How to handle this in an interview

**Name it first.** "Every stage of my pipeline is published — BLUEX v2 does segmentation and dedup on university exams, QDup does near-duplicate detection on 114,804 CBSE questions. And teaching in prerequisite order is what ALEKS has done since the 1990s. What is not shipped anywhere is the composition over a contributed corpus, and that property is what created the engineering problems worth solving."

Then point at section 4.2, and at the measured numbers in [EVALUATION.md](EVALUATION.md).

The failure mode to avoid is overclaiming and being corrected. The strong position is having already done the correcting.
