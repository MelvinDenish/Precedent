# Precedent — The Learning Model

Why this teaches rather than just predicts, and how the ranking works.

---

## 1. The reframe: concepts are the unit of study

An earlier version of this product ranked and served **questions**. That was wrong for two independent reasons.

**Reason 1 — some subjects barely repeat questions.** A recurrence-only product silently becomes useless for them, and the student has no way to tell. The system would keep producing confident rankings from almost no signal.

**Reason 2 — a repeated question is useless if you do not understand it.** Reading a model answer is not learning. You cannot answer a reworded variant, and often cannot even parse the question, without the underlying concept.

**But concept recurrence is robust where question recurrence is fragile.** The syllabus is fixed, so examiners keep testing the same ideas in new clothes. A topic can be high-value even when *no single question ever repeats*, because expected marks accumulate across many different questions that test it.

So the model inverts:

```
questions are EVIDENCE    which concepts carry marks, and how they are angled
questions are ASSESSMENT  real PYQs prove you actually learned it
concepts  are the UNIT OF STUDY and the thing that gets TAUGHT
```

---

## 2. Topic ROI

### 2.1 Layer 1 — cluster appearance probability

Used directly when repetition is high; feeds Layer 2 always.

```
p_next(k) proportional to
      w1 * decayed_frequency(k)     sum of lambda^(years_ago) over appearances,
                                    zeroed for evidence predating a syllabus revision
    + w2 * overdue_ratio(k)         gap_since_last / mean_gap   (renewal hazard)
    + w3 * unit_quota_pressure(k)   the paper must fill N slots from this unit
    + w4 * marks_weight(k)
```

**The overdue term matters and is counter-intuitive.** A topic absent for three sittings is *more* likely to appear, not less, because examiners rotate through units. Raw frequency counting gets this exactly backwards, which is one reason hand-computed "important questions" lists go stale.

**Syllabus-version discounting** is not decorative. Anna University R2021 has only about 3-4 sittings per subject, so R2017 papers must be bridged in via `subject_lineage`, discounted by concept overlap. The real corpus requires the feature.

### 2.2 Layer 2 — concept expected marks

```
expected_marks(c) = sum over clusters k testing c of
                       p_next(k) * marks(k) * weight(k, c)

study_cost(c)     = f(concept complexity, prerequisite depth, escalation_rate)

ROI(c)            = expected_marks(c) / study_cost(c)
```

In a **low-repetition** subject `p_next` flattens, but `expected_marks` stays meaningful because it sums across *many different* questions that test the same concept. This is precisely why the reframe makes the product work on subjects that would break a pure-recurrence system.

`study_cost` starts as a function of prerequisite depth and concept kind, then is corrected by `escalation_rate` — the share of students who needed Tier 2 help on that concept. Concepts students actually find hard get costed correctly over time, without anyone hand-tuning them.

---

## 3. Graceful degradation: the repetition regime

Every subject is measured at ingest and classified. The ROI weighting adapts, and **the UI states which regime it is in.**

| Regime | Signal | Weighting shifts toward | What the UI says |
|---|---|---|---|
| **High** | Many clusters span multiple years | `p_next` of specific clusters | "12 questions have repeated across 8 papers" |
| **Medium** | Mixed | Balanced | "Some questions repeat; topic-level guidance is stronger" |
| **Low** | Few clusters recur | Concept-level frequency plus syllabus priors: unit hours, marks distribution, historical unit-level rates | "Questions rarely repeat in this subject. Guidance here is topic-level." |

A low-repetition subject does not break the product. It automatically stops making per-question claims and starts making per-topic ones. **The system knows what it does not know** — the same honesty principle the citation trail exists to enforce.

---

## 4. The Learn Loop

Both modes run this engine. They differ in *which* concepts, *how deep*, and *in what order* — never in whether teaching happens.

```
   SELECT next concept
        |
        v
   +-- TEACH ------------------------------------+
   |  micro-lesson generated from:                |
   |    syllabus text     (scope)                 |
   |    your notes        (your prof's framing)   |
   |    textbook          (rigour)                |
   |    CLUSTER INSTANCES (the exam's angle)  <-- |
   +----------------------+-----------------------+
                          v
   +-- TEST --------------------------------------+
   |  REAL past questions on this concept,         |
   |  ascending marks weight, agent-evaluated      |
   +------+------------------------------+---------+
       pass                            fail
          |                              |
          v                              v
    mark mastery,              resolve prerequisite chain,
    advance cursor,            push missing concept on stack,
    marks counter up           re-enter TEACH there
```

### 4.1 Why the teaching is not generic

Lessons are grounded in **how the exam actually angles the concept**. If functional dependencies are always examined as "find the candidate keys", the lesson teaches that — not the abstract relational theory a textbook opens with.

**The exam corpus supplies the pedagogical emphasis.** No textbook can do this, no NotebookLM summary can do this, and no pre-authored adaptive course can do this, because it requires that specific university's paper history. This is the sharpest single differentiator in the product.

A `cram` lesson is roughly five minutes: the definition, the one worked example the exam always wants, and the trap it always sets. A `full` lesson adds derivations, edge cases, and why the concept matters.

### 4.2 Retrieval practice, deliberately

Mastery mode tests **before** it explains where possible. The testing effect is the best-evidenced intervention in the learning literature, and re-reading notes is the worst — it produces the feeling of competence without the substance.

Night Before mode inverts this out of necessity: with six hours left there is no time to fail productively, so it teaches first and tests to confirm. This is a deliberate concession to the constraint, not an oversight.

### 4.3 Why the loop is a state machine, not an agent

Teach, test, branch on failure, hop a prerequisite edge is a **finite state machine over a graph**. It must be:

- **deterministic** — the same state produces the same next step, so behaviour is explainable and testable
- **auditable** — a student can see why they were sent to a prerequisite
- **resumable** — a student closes the tab at 2am; every transition is persisted to `learn_sessions`

Making it an agent would trade all three for nothing. See [AGENTS.md](AGENTS.md).

---

## 5. The two modes

|  | Night Before (6-10 hrs) | Mastery (2-6 weeks) |
|---|---|---|
| Selection | Top concepts by ROI, unit-coverage constrained | Whole portions, full syllabus |
| Ordering | ROI descending | Prerequisite topological order, ROI breaks ties |
| Lesson depth | `cram` | `full` |
| Assessment | 1-2 real PYQs, fast | Ladder: 2 mark, then 8, then 16 |
| On failure | One prerequisite hop, then move on | Recurse to root cause, re-teach |
| Coverage | Certain core only | Core, long tail, and unexamined topics |
| Scheduler | Off, there is no tomorrow | On |
| Simulator | Off | On, full length |

### 5.1 The Night Before optimizer

The detail that a naive implementation gets wrong: **you cannot simply take the globally top-N concepts.**

The paper forces an answer from every unit — typically one of two from each of five. If the top concepts all sit in Unit 1, the student fails regardless of how well they know Unit 1. So it is a knapsack **constrained by the paper's structural template** (`papers.template`):

```
Phase 1  for each unit:
             take concepts by ROI until that unit has
             minimum viable answer coverage
Phase 2  spend remaining budget globally by
             marginal expected-marks-per-minute
Reserve  hold back ~15% of the budget for prerequisite hops
             triggered by test failures
```

The reserve exists because the loop **discovers gaps while running**. A plan with no slack either overruns or abandons the student mid-repair.

The optimizer is plain deterministic code. It must be instant, re-runnable after every failure, and **explainable** — the student needs to see why topic 3 outranks topic 4. An LLM here would be slower, worse, and unauditable.

---

## 6. Prerequisite edges are induced, not authored

This is the substantive difference from ALEKS, Knewton and Embibe, all of which ship **hand-authored** knowledge graphs built by curriculum teams over years.

| Stage | Mechanism | Strength |
|---|---|---|
| 1. **Propose** | One LLM call over concept definitions | Cheap, plausible, unreliable alone |
| 2. **Confirm** | Corpus structure: if A's questions cluster in Unit 2 and B's in Unit 4, and B's questions use A's vocabulary, that supports A to B | Evidence-based |
| 3. **Adjudicate** *(future work)* | Student response data: **asymmetric conditional failure** — students failing B also fail A, but not conversely | Strongest signal, needs real users |

Every edge stores `evidence` and a confidence score. Stage 3 is documented as future work and **is not demoed on synthetic response data** — inventing student data to validate a claim about student data would undermine the honesty the rest of the system is built on.

The consequence: this graph **improves as the corpus and the user base grow**. A hand-authored graph never does.

---

## 7. What this does not claim

- It does **not** claim to predict exact question wording. It predicts what will be examined.
- It does **not** claim novelty in adaptive learning. Prerequisite-ordered teaching with adaptive assessment is decades old. See [PRIOR_ART.md](PRIOR_ART.md).
- It does **not** claim per-faculty insight. Affiliating-university papers carry no faculty identity, so any such claim would be fabricated.
- It does **not** claim certainty. The held-out evaluation reports measured accuracy, and the regime classifier says out loud when the signal is weak.
