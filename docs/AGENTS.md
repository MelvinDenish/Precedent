# Precedent — Agents, and Where They Are Not

The decision record for every LLM-touching component.

---

## 1. The test

> **An agent is justified only when the task is multi-step, needs tools, and has an uncertain tail requiring self-assessment.**

If a task is a single classification, it gets one structured-output call. If it is arithmetic or graph traversal, it gets code. Reaching for an agent because the domain sounds "AI-ish" adds latency, nondeterminism, cost and debugging difficulty in exchange for nothing.

**Applying this test honestly produced three agents out of fourteen components.** That ratio is a deliberate result, not an accident of scope.

---

## 2. The scorecard

| # | Component | Mechanism | Why |
|---|---|---|---|
| 1 | Segmentation | Rules + 1 structured call fallback | Parsing with a known grammar. Rules cover most clean PDFs; one call handles the messy tail. An agent adds nondeterminism to something that must be reproducible. |
| 2 | **Duplicate adjudication** | **AGENT** | See 3.1 |
| 3 | Concept extraction | 1 structured call | Multi-label extraction against a fixed syllabus taxonomy. Batchable, cheap, one shot. |
| 4 | Syllabus alignment | 1 structured call | Classification into known units. |
| 5 | Prerequisite induction | 1 call proposes, statistics confirm | The evidence half is arithmetic over the corpus. An agent cannot do statistics better than statistics. |
| 6 | Topic ROI / recurrence | **No LLM at all** | See 4.1 |
| 7 | Night Before optimizer | Code | Constrained knapsack. Must be instant, re-runnable and explainable. |
| 8 | Teaching Engine | RAG + generation, lightly agentic | Retrieve four-way, assess coverage, then generate or flag the gap. The coverage check is the agentic part and it is what prevents fabrication. |
| 9 | Answer Studio | RAG + generation, lightly agentic | Same shape: retrieve, assess, answer or refuse. |
| 10 | **Tutor Chat** | **AGENT** | See 3.2 |
| 11 | **Attempt and Evaluate** | **AGENT** | See 3.3 |
| 12 | Learn Loop controller | Code, state machine | See 4.2 |
| 13 | Gap Map | Code + 1 call to phrase | Aggregation over graph edges. Only the wording needs a model. |
| 14 | Exam Simulator | Code + 1 call for variants | Constrained sampling is a solved algorithm. The LLM only rewords, so memorising the original does not help. |
| 15 | Recall Scheduler | Code | Forgetting curve times marks weight. Arithmetic. |

---

## 3. The three agents

### 3.1 Adjudicator

**Job.** Given two questions that vector search says are similar, decide `same` / `variant` / `different`, with a confidence score.

**Why an agent.** Embeddings cannot do this. "Explain 2NF with an example" and "Explain 3NF with an example" are near-identical vectors and completely different questions. The agent must fetch the surrounding context, check whether the pair are OR-alternatives in the same paper, compare how each was marked and structured across years, and then **assess its own certainty** so the gate can route it. That is a tool-using loop with an uncertain path.

**Tools.** `get_question`, `get_cluster_members`, `get_sibling_questions`, `check_or_group`, `get_marks_history`.

**Output.** `{ decision, confidence, reasoning, evidence_ids }`

**Gate.**

| Confidence | Action |
|---|---|
| above 0.85 | Auto-apply |
| 0.60 to 0.85 | Review queue, human decides |
| below 0.60 | Auto-reject, leave separate |

**Hard constraint enforced in code, never in the prompt:** two questions may not merge if they share a paper AND an `or_group`. Prompts are not a safety mechanism. See [ARCHITECTURE.md](ARCHITECTURE.md#23-the-or-rule-stated-precisely).

### 3.2 Tutor

**Job.** Tier 2 of the escalation ladder. When a cached answer and a cached lesson both fail to land, explain the concept with examples and **work through the actual past question step by step**.

**Why an agent.** It must decide *mid-conversation* whether the student's block is conceptual, prerequisite, or notational, then fetch different evidence for each and change tack. A student who says "I still don't get it" has given no information about which. That is a tool-using loop with a genuinely uncertain path.

**Why it is not just a ChatGPT window:**

| | Generic chatbot | Precedent tutor |
|---|---|---|
| Context | Whatever you paste | This concept, this cluster, **its versions in other years**, your notes, your mastery state |
| Prerequisites | Guesses | Walks the **actual** prerequisite chain from the graph |
| Examples | Invented | How **your university** has really asked it |
| Claims | Unverifiable | Citable to paper, year, question number, or your own notes |
| Scope | Unbounded | Declines off-syllabus drift |

**Tools.** `get_concept`, `get_lesson`, `get_cluster_instances`, `get_prerequisite_chain`, `retrieve_user_notes`, `get_solved_similar`.

**Three design decisions worth defending:**

1. **Context is injected at session start, not discovered.** Concept, cluster instances, prerequisite chain and mastery state are loaded from the graph up front. On a free tier, an agent that explores costs you the demo. Tools exist for the follow-ups, not the opening.
2. **The tutor respects the clock.** Night Before sessions carry a time budget. When it nears zero the tutor says "you have 40 minutes and 3 topics left, here is the minimum for this one" and closes the thread. A tutor that lets a cramming student rabbit-hole at 3am is actively harmful, even though it feels helpful.
3. **Every escalation is logged.** Concepts that repeatedly force Tier 2 are the genuinely hard ones. That feeds `concept_stats.escalation_rate`, which corrects `study_cost`, which sharpens ROI for every future student. A flywheel that costs nothing extra.

**Provider.** Groq primary, Gemini fallback. Token latency is what makes a tutor feel alive; a correct answer that takes eight seconds to start is a worse tutor than a fast one.

**Streaming.** SSE. One-way server to client, so a WebSocket would be over-engineering.

### 3.3 Evaluator

**Job.** Score a student's written answer against a mark scheme that **nobody ever wrote down**.

**Why an agent.** The mark scheme has to be *inferred* from the cluster's instances: how marks were distributed across parts, which points appear in every year's version, what depth an 8-mark answer implies versus a 16-mark one. Then it must diff the student's answer point by point and argue partial credit. Multi-step, retrieval-backed, judgment-heavy.

**Tools.** `get_cluster_instances`, `get_marks_distribution`, `retrieve_user_notes`, `get_concepts`.

**Output.** Per-point credit, total score, and **each missed point mapped to a concept id** — which is what feeds the Gap Map and the Learn Loop's prerequisite hop. A bare score would be useless to the rest of the system.

---

## 4. Two deliberate refusals

### 4.1 The ROI model uses no LLM at all

This is the product's core claim. It must be **calibrated, evaluated, and defensible** against a held-out year.

An LLM asked "will this appear?" produces a number that cannot be calibrated, cannot be improved by more data, and cannot be defended in an interview. A statistical model over decayed frequency, overdue ratio, unit quota pressure and marks weight can be — and is measured against a naive syllabus-order baseline in [EVALUATION.md](EVALUATION.md).

**Using an LLM here would have been the single worst decision available in this project.**

### 4.2 The Learn Loop controller is a state machine

Teach, test, branch on failure, hop a prerequisite edge is a finite state machine over a graph. Making it an agent would sacrifice:

- **determinism** — same state, same next step, so it is testable
- **auditability** — the student can see why they were sent to a prerequisite
- **resumability** — every transition persists to `learn_sessions`; a closed tab at 2am resumes exactly

in exchange for nothing an agent provides.

---

## 5. Cost model

Free-tier quota is a real constraint, and the architecture is shaped by it rather than apologising for it.

| Tier | What it serves | When it is generated | Cost per student |
|---|---|---|---|
| 0 | Canonical answer, cited | Once per corpus | **Zero** |
| 1 | Micro-lesson, exam-angled | Once per corpus | **Zero** |
| 2 | Tutor chat | Live, on request | Real tokens |

Because the graph is shared across everyone studying `(university, regulation, subject)`, Tiers 0 and 1 are generated **once and served to every student**. LLM cost is therefore **per-corpus, not per-user** — the property that makes a free-tier deployment survive more than a handful of users.

Embeddings run on **local ONNX MiniLM**, so the highest-volume model call in the system costs nothing, has no rate limit, and works with the network unplugged.

| Provider | Used for | Why |
|---|---|---|
| local ONNX MiniLM-L6-v2 | All embeddings | Zero cost, no limit, offline-capable |
| Gemini free tier | Vision extraction, bulk structured calls | 1,500 requests/day including vision |
| Groq | Tutor Chat | Token latency |

**Fallback chain, in both directions.** Gemini exhausted means vision extraction defers rather than failing the paper. Groq down means the tutor falls back to Gemini with a visible latency warning. Neither failure loses work.

---

## 6. Guardrails

| Guardrail | Applies to | Enforcement |
|---|---|---|
| OR-pair merge prohibition | Adjudicator | **Code**, before the agent is called and again on write |
| Confidence gate | Adjudicator | Code, on the returned score |
| Scope refusal (off-syllabus) | Tutor | System prompt plus a post-check against subject concepts |
| Time budget | Tutor | Code, injected each turn and enforced on turn count |
| Gap flagging over fabrication | Teaching Engine, Answer Studio | Coverage check before generation; `gap_flags` persisted |
| Citation requirement | All generation | Sources persisted alongside body; UI renders no uncited claim |

**Prompts are not a safety mechanism.** Every hard constraint is enforced in code. The prompt is where the model is told what good output looks like, not where correctness is guaranteed.

---

## 7. Evaluation of the agents themselves

| Agent | Metric | Method |
|---|---|---|
| Adjudicator | Precision / recall on merge decisions | ~150 hand-labelled question pairs |
| Adjudicator | Gate calibration | Do 0.60-0.85 decisions actually contain the errors? |
| Teaching Engine | Gap-flag correctness | Feed a concept the notes deliberately omit; assert it flags rather than invents |
| Evaluator | Agreement with hand-marked answers | Score a set of answers manually, compare |
| Tutor | Scope adherence | Off-syllabus probes must be declined |
| Tutor | Context efficiency | Tool calls per session should be low; a high count means context injection is failing |

Full protocol in [EVALUATION.md](EVALUATION.md).

---

## 8. What to say in an interview

> "I applied one test to every component: an agent is justified only when the task is multi-step, needs tools, and has an uncertain tail requiring self-assessment. That gave me three agents out of fourteen components. The recurrence model is explicitly **not** an LLM, because it is the product's core claim and it has to be calibrated against a held-out year. The Learn Loop is explicitly **not** an agent, because it has to be resumable when a student closes the tab at 2am."

"Everything is an agent" reads as inexperience. Being able to name what you *removed*, and why, reads as judgment.
