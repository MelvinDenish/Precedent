# Precedent — Evaluation

The difference between "I built a question predictor" and "I built a question predictor and here is its measured accuracy against a baseline."

---

## 1. Why this document exists first

Most portfolio projects assert quality. This one measures it, because the central product claim — *these topics carry the marks* — is exactly the kind of claim an interviewer will probe. A measured number with a stated baseline survives that; a screenshot does not.

**Decide the protocol in Week 2, not Week 4.** See section 3; this is a scheduling risk, not a nicety.

---

## 2. The headline metric

### Top-k concept marks coverage, on a held-out year

```
Train on all sittings up to year Y-1.
Rank concepts by ROI.
Take the top k.
Score = share of the ACTUAL marks in year Y's paper
        that those k concepts account for.
```

**Why concept-level and not question-level.** It works in every repetition regime. A question-level metric collapses on low-repetition subjects and invites the one-line rebuttal *"but questions don't repeat in my subject"*. The concept metric cannot be dismissed that way, because the syllabus is fixed and concepts recur even when wording does not.

### Baselines it must beat

| Baseline | Why it is the right comparison |
|---|---|
| **Naive syllabus order** | **The primary baseline.** This is literally what students do: start at Unit 1, page 1. Beating it is the product's reason to exist. |
| Uniform random concept selection | Floor. |
| Raw frequency, no recency | Isolates the contribution of the overdue and decay terms. |
| Unit-hours prior only | Isolates the contribution of paper evidence over syllabus structure. |

Report at k = 5, 10, 20. The Night Before mode's realistic budget is roughly k = 10.

### Secondary metrics

| Metric | Scope |
|---|---|
| Top-k **cluster** marks coverage | Only meaningful in high-repetition subjects; report per regime, never pooled |
| Calibration curve | Of clusters assigned ~0.7 probability, what share appeared? Reliability diagram plus Brier score |
| Per-regime breakdown | The low-repetition subject must still beat syllabus order. **This is the proof the concept reframe works.** |

---

## 3. Corpus adequacy, and the protocol decision

**The risk.** Anna University R2021 began in 2021-22, so a 4th-semester subject like CS3492 has only about **3-4 sittings**. A held-out design on four papers gives 3 train / 1 test, and "our top 10 concepts covered 71% of marks" computed from three papers dies to a single interviewer question.

**The mitigation, in order:**

1. **Bridge to R2017** via `subject_lineage`, discounting older evidence by concept overlap. CS8492 (R2017) has substantially more sittings than CS3492 (R2021).
2. **Count sittings per subject during Week 2 seeding.** Write the number down.
3. **If any subject lands under ~6 sittings**, either drop it from the evaluation set, or switch the whole protocol to **pooled leave-one-year-out cross-validation across all four subjects**, which yields many more folds from the same corpus.

Discovering the corpus is too thin in Week 4 costs the headline result with two weeks remaining. This is why the decision is scheduled early.

---

## 4. Pipeline quality

### 4.1 Segmentation

Hand-label question boundaries on **3 papers across 2 subjects**. Report precision and recall **separately from clustering** — conflating them hides which stage is failing.

| Assertion | Why |
|---|---|
| No same-paper OR-pair is emitted as a single question | Merging alternatives inflates every downstream count |
| Sub-part marks are recovered, not just totals | Mark-band drives answer depth and ROI |
| Multi-column papers produce correct reading order | The coordinate-sort pass is the thing being tested |

### 4.2 Clustering

Hand-label **~150 question pairs** as same / variant / different. This is the single most valuable few hours in the project: it produces the adjudicator's accuracy number, calibrates the confidence gate, and doubles as a regression suite.

| Assertion | Why |
|---|---|
| Precision >= 0.90 | A wrong merge corrupts statistics silently |
| **A known cross-year OR-slot pair DOES merge** (e.g. 2023 Q11a vs 2024 Q13b) | The over-strict OR rule breaks exactly this case, and breaks it silently |
| A same-paper OR-pair does NOT merge | The under-strict failure, in the other direction |
| Gate calibration | Errors should concentrate in the 0.60-0.85 review band, not above 0.85 |

Human decisions from the review queue accumulate as additional labelled data at no extra cost.

### 4.3 Generation honesty

| Test | Assertion |
|---|---|
| Lesson for a concept the notes deliberately omit | **Flags the gap. Does not fabricate.** |
| Answer Studio, personalized tier, uncovered topic | Refuses rather than inventing |
| Any generated body | Carries citations; the UI renders no uncited claim |

Principle 2 of the PRD — *the system says what it does not know* — is only real if it is tested.

---

## 5. System quality

| Test | Assertion |
|---|---|
| Upload the same paper 5x under different filenames | Exactly 1 `papers` row, 4 contributor credits, **zero reprocessing** |
| Upload the same paper from two different archives | Still deduplicates, because the hash is on normalized text, not raw bytes |
| Kill a worker mid-job | Job resumes from the queue; no partial state committed |
| Two workers mutate one cluster concurrently | Version conflict **detected and retried**, never silently lost |
| Merge two clusters that both have cached answers | Cached answers survive; nothing orphaned or stale (content-addressed keys) |
| Exhaust the LLM provider quota | Jobs defer and retry; papers do not fail permanently |
| **Unplug the network** | Local ONNX embeddings still serve retrieval |

The last one runs before any live demo.

---

## 6. Learning-loop behaviour

| Test | Assertion |
|---|---|
| Fail a test question | Loop hops to the **correct** prerequisite, per the graph |
| Kill a session mid-loop, resume | Continues from the same cursor and prerequisite stack |
| Night Before, 6-hour budget | Every unit reaches minimum viable coverage **before** any unit is deepened |
| Night Before, forced failure | Reserve budget absorbs the prerequisite hop without overrunning the total |
| Tutor, off-syllabus probe | Declined, not answered |
| Tutor, "I don't understand any of this" | Walks to the correct prerequisite rather than re-explaining the same thing |
| Tutor, budget nearly spent | Summarises and closes rather than continuing |
| Any escalation | Writes a row that moves `concept_stats.escalation_rate` |

---

## 7. What gets reported in the README

Only numbers that survived the protocol above, each with its baseline stated:

```
Top-10 concept marks coverage, held-out 2024 paper
  Precedent          XX%
  Naive syllabus     XX%     <- what students actually do
  Raw frequency      XX%
  Random             XX%

Cluster precision / recall     X.XX / X.XX   (n=150 hand-labelled pairs)
Segmentation precision / recall X.XX / X.XX  (n=3 papers, 2 subjects)
Calibration (Brier)            X.XXX
```

**No number ships without its baseline and its sample size.** A percentage with neither is the kind of claim this whole document exists to avoid making.
