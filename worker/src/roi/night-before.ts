/**
 * The Night Before optimizer.
 *
 * THE DETAIL A NAIVE IMPLEMENTATION GETS WRONG: you cannot simply take the
 * globally top-N concepts by ROI.
 *
 * The paper forces an answer from every unit -- typically one of two from
 * each of five. If the top-ROI concepts all sit in Unit 1, the student walks
 * in unable to answer Units 2 to 5 and fails, however well they know Unit 1.
 * So this is a knapsack CONSTRAINED BY THE PAPER'S STRUCTURAL TEMPLATE.
 *
 *   Phase 1  for each unit, take concepts by ROI until that unit reaches
 *            minimum viable answer coverage
 *   Phase 2  spend what remains globally, by marginal expected marks per minute
 *   Reserve  hold back ~15% for prerequisite hops triggered by test failures
 *
 * The reserve exists because the loop DISCOVERS GAPS WHILE RUNNING. A plan
 * with no slack either overruns its budget or abandons the student
 * mid-repair, and the second is worse than never starting.
 *
 * This is plain deterministic code on purpose. It must be instant,
 * re-runnable after every failure, and EXPLAINABLE -- the student needs to
 * see why topic 3 outranks topic 4. An LLM here would be slower, worse and
 * unauditable.
 *
 * See docs/PEDAGOGY.md section 5.1.
 */

import type { ConceptScore } from './concepts.js';

/** Fraction of the budget withheld for prerequisite hops discovered mid-run. */
export const RESERVE_FRACTION = 0.15;

export interface PlannableConcept extends ConceptScore {
  /** Units this concept answers for. A concept can serve more than one. */
  unitNos: number[];
}

export interface NightBeforePlan {
  /** Concepts in the order they will be taught. */
  conceptIds: string[];
  /** Minutes of coverage reached per unit. */
  unitCoverage: Record<string, number>;
  /** Minutes withheld for prerequisite hops. */
  reserveMin: number;
  /** Minutes the plan actually schedules, excluding the reserve. */
  plannedMin: number;
  expectedMarksTotal: number;
  /** Units the budget could not reach. Shown to the student, never hidden. */
  uncoveredUnits: number[];
  /** Why each concept was chosen, in order. The UI renders this. */
  rationale: { conceptId: string; phase: 'coverage' | 'depth'; unitNo: number | null }[];
}

export interface NightBeforeOptions {
  budgetMin: number;
  /** Units the paper will draw from, from papers.template. */
  unitNos: number[];
  /**
   * Minutes that count as minimum viable coverage for one unit. Below this a
   * student cannot attempt any question from it at all.
   */
  minViableMinPerUnit?: number;
  reserveFraction?: number;
}

/**
 * Builds a time-budgeted cram plan.
 *
 * Phase 1 buys breadth, because breadth is what the paper's structure
 * demands. Phase 2 buys depth with whatever is left.
 */
export function planNightBefore(
  concepts: readonly PlannableConcept[],
  options: NightBeforeOptions,
): NightBeforePlan {
  const reserveFraction = options.reserveFraction ?? RESERVE_FRACTION;
  const minViable = options.minViableMinPerUnit ?? 25;

  const reserveMin = Math.round(options.budgetMin * reserveFraction);
  const spendable = options.budgetMin - reserveMin;

  const byRoi = [...concepts].sort((a, b) => {
    if (b.roi !== a.roi) return b.roi - a.roi;
    if (b.expectedMarks !== a.expectedMarks) return b.expectedMarks - a.expectedMarks;
    return a.conceptId.localeCompare(b.conceptId);
  });

  const chosen = new Set<string>();
  const order: string[] = [];
  const rationale: NightBeforePlan['rationale'] = [];
  const coverage: Record<string, number> = {};
  for (const unitNo of options.unitNos) coverage[String(unitNo)] = 0;

  let spent = 0;

  const take = (
    concept: PlannableConcept,
    phase: 'coverage' | 'depth',
    unitNo: number | null,
  ): void => {
    chosen.add(concept.conceptId);
    order.push(concept.conceptId);
    rationale.push({ conceptId: concept.conceptId, phase, unitNo });
    spent += concept.studyCostMin;
    for (const unit of concept.unitNos) {
      const key = String(unit);
      if (key in coverage) coverage[key] = (coverage[key] ?? 0) + concept.studyCostMin;
    }
  };

  // Phase 1: breadth. Every unit reaches minimum viable coverage BEFORE any
  // unit is deepened. This is the constraint that stops the plan pouring the
  // whole budget into whichever unit happens to rank highest.
  for (const unitNo of options.unitNos) {
    const key = String(unitNo);
    for (const concept of byRoi) {
      if ((coverage[key] ?? 0) >= minViable) break;
      if (chosen.has(concept.conceptId)) continue;
      if (!concept.unitNos.includes(unitNo)) continue;
      if (spent + concept.studyCostMin > spendable) continue;
      take(concept, 'coverage', unitNo);
    }
  }

  // Phase 2: depth. Whatever is left goes to the highest marginal expected
  // marks per minute, wherever it sits.
  for (const concept of byRoi) {
    if (chosen.has(concept.conceptId)) continue;
    if (spent + concept.studyCostMin > spendable) continue;
    take(concept, 'depth', null);
  }

  const uncoveredUnits = options.unitNos.filter((u) => (coverage[String(u)] ?? 0) < minViable);

  const byId = new Map(concepts.map((c) => [c.conceptId, c]));
  const expectedMarksTotal = order.reduce((sum, id) => sum + (byId.get(id)?.expectedMarks ?? 0), 0);

  return {
    conceptIds: order,
    unitCoverage: coverage,
    reserveMin,
    plannedMin: spent,
    expectedMarksTotal,
    uncoveredUnits,
    rationale,
  };
}

/**
 * Whether the reserve can absorb a prerequisite hop discovered mid-session.
 *
 * The Learn Loop calls this before pushing a prerequisite onto the stack. If
 * the reserve cannot cover the hop, the loop moves on rather than starting a
 * repair it has no time to finish: an abandoned repair costs the student the
 * original topic as well as the prerequisite.
 */
export function canAbsorbHop(
  plan: NightBeforePlan,
  spentMin: number,
  hopCostMin: number,
): boolean {
  const reserveUsed = Math.max(0, spentMin - plan.plannedMin);
  return reserveUsed + hopCostMin <= plan.reserveMin;
}
