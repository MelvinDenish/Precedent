import { describe, expect, it } from 'vitest';
import { type PlannableConcept, canAbsorbHop, planNightBefore } from './night-before.js';

/** Five units, as the R2023 paper template has. */
const UNITS = [1, 2, 3, 4, 5];

function concept(
  id: string,
  unitNo: number,
  roi: number,
  costMin: number,
  marks = roi * costMin,
): PlannableConcept {
  return {
    conceptId: id,
    unitNos: [unitNo],
    roi,
    studyCostMin: costMin,
    expectedMarks: marks,
    evidenceClusterCount: 1,
  };
}

describe('the Night Before optimizer', () => {
  /**
   * THE FAILURE A NAIVE IMPLEMENTATION PRODUCES.
   *
   * Unit 1 here monopolises the top of the ROI ranking. Taking the globally
   * top-N would spend the whole budget there and leave the student unable to
   * attempt Units 2 to 5 -- which the paper forces them to answer. They would
   * fail despite knowing Unit 1 perfectly.
   */
  it('reaches every unit before deepening any, even when one unit dominates', () => {
    const concepts = [
      ...Array.from({ length: 8 }, (_, i) => concept(`u1-${i}`, 1, 2.0 - i * 0.01, 20)),
      // The other units are worth less per minute, but the paper demands them.
      ...UNITS.slice(1).flatMap((u) =>
        Array.from({ length: 3 }, (_, i) => concept(`u${u}-${i}`, u, 0.4 - i * 0.01, 20)),
      ),
    ];

    const plan = planNightBefore(concepts, { budgetMin: 480, unitNos: UNITS });

    for (const unitNo of UNITS) {
      expect(plan.unitCoverage[String(unitNo)]).toBeGreaterThanOrEqual(25);
    }
    expect(plan.uncoveredUnits).toEqual([]);
  });

  it('buys breadth before depth, and says which it was doing', () => {
    const concepts = UNITS.flatMap((u) =>
      Array.from({ length: 4 }, (_, i) => concept(`u${u}-${i}`, u, 1 - i * 0.1, 20)),
    );
    const plan = planNightBefore(concepts, { budgetMin: 600, unitNos: UNITS });

    const coveragePicks = plan.rationale.filter((r) => r.phase === 'coverage');
    const depthPicks = plan.rationale.filter((r) => r.phase === 'depth');

    expect(coveragePicks.length).toBeGreaterThan(0);
    expect(depthPicks.length).toBeGreaterThan(0);
    // Every coverage pick names the unit it was bought for. The UI shows this.
    expect(coveragePicks.every((r) => r.unitNo !== null)).toBe(true);

    const lastCoverage = plan.rationale.map((r) => r.phase).lastIndexOf('coverage');
    const firstDepth = plan.rationale.findIndex((r) => r.phase === 'depth');
    expect(lastCoverage).toBeLessThan(firstDepth);
  });

  /**
   * The reserve exists because the loop discovers gaps WHILE RUNNING. A plan
   * with no slack either overruns or abandons the student mid-repair.
   */
  it('withholds 15% of the budget and never schedules into it', () => {
    const concepts = UNITS.flatMap((u) =>
      Array.from({ length: 10 }, (_, i) => concept(`u${u}-${i}`, u, 1 - i * 0.05, 20)),
    );
    const plan = planNightBefore(concepts, { budgetMin: 600, unitNos: UNITS });

    expect(plan.reserveMin).toBe(90);
    expect(plan.plannedMin).toBeLessThanOrEqual(600 - 90);
  });

  it('absorbs a prerequisite hop without overrunning the total', () => {
    const concepts = UNITS.flatMap((u) =>
      Array.from({ length: 6 }, (_, i) => concept(`u${u}-${i}`, u, 1 - i * 0.05, 20)),
    );
    const plan = planNightBefore(concepts, { budgetMin: 600, unitNos: UNITS });

    expect(canAbsorbHop(plan, plan.plannedMin, 30)).toBe(true);
    expect(plan.plannedMin + 30).toBeLessThanOrEqual(600);
  });

  it('refuses a hop the reserve cannot finish', () => {
    const concepts = UNITS.map((u) => concept(`u${u}-0`, u, 1, 25));
    const plan = planNightBefore(concepts, { budgetMin: 200, unitNos: UNITS });

    // Reserve is 30 minutes; an 80-minute repair does not fit. Starting it
    // would cost the student the original topic as well as the prerequisite.
    expect(canAbsorbHop(plan, plan.plannedMin, 80)).toBe(false);
  });

  it('accounts for reserve already consumed by an earlier hop', () => {
    const concepts = UNITS.map((u) => concept(`u${u}-0`, u, 1, 20));
    const plan = planNightBefore(concepts, { budgetMin: 400, unitNos: UNITS });
    const reserve = plan.reserveMin;

    expect(canAbsorbHop(plan, plan.plannedMin + reserve / 2, reserve / 2)).toBe(true);
    expect(canAbsorbHop(plan, plan.plannedMin + reserve / 2, reserve)).toBe(false);
  });

  /**
   * The system says what it does not know. A short budget cannot cover a
   * five-unit paper when each unit needs an hour, and the student must be
   * told which units they are walking in blind on.
   */
  it('reports units the budget could not reach instead of hiding them', () => {
    const concepts = UNITS.map((u) => concept(`u${u}-0`, u, 1, 60));
    const plan = planNightBefore(concepts, { budgetMin: 150, unitNos: UNITS });

    expect(plan.uncoveredUnits.length).toBeGreaterThan(0);
    expect(plan.conceptIds.length).toBeLessThan(UNITS.length);
  });

  it('never schedules a concept it cannot afford', () => {
    const plan = planNightBefore([concept('huge', 1, 10, 500)], {
      budgetMin: 100,
      unitNos: [1],
    });

    expect(plan.conceptIds).toEqual([]);
    expect(plan.plannedMin).toBe(0);
  });

  it('never schedules the same concept twice', () => {
    // A concept serving two units must not be bought once per unit.
    const shared: PlannableConcept = {
      conceptId: 'spans-1-and-2',
      unitNos: [1, 2],
      roi: 5,
      studyCostMin: 30,
      expectedMarks: 150,
      evidenceClusterCount: 2,
    };
    const plan = planNightBefore([shared, concept('u3-0', 3, 1, 30)], {
      budgetMin: 300,
      unitNos: [1, 2, 3],
    });

    expect(plan.conceptIds.filter((id) => id === 'spans-1-and-2')).toHaveLength(1);
  });

  it('is deterministic, because the plan is re-run after every failure', () => {
    const concepts = UNITS.flatMap((u) =>
      Array.from({ length: 5 }, (_, i) => concept(`u${u}-${i}`, u, 1 - i * 0.05, 20)),
    );
    const opts = { budgetMin: 480, unitNos: UNITS };
    expect(planNightBefore(concepts, opts)).toEqual(planNightBefore(concepts, opts));
  });

  it('sums the expected marks of exactly what it scheduled', () => {
    const concepts = UNITS.map((u) => concept(`u${u}-0`, u, 1, 25, 10));
    const plan = planNightBefore(concepts, { budgetMin: 400, unitNos: UNITS });

    expect(plan.expectedMarksTotal).toBeCloseTo(plan.conceptIds.length * 10);
  });

  it('handles an empty concept list without throwing', () => {
    const plan = planNightBefore([], { budgetMin: 300, unitNos: UNITS });
    expect(plan.conceptIds).toEqual([]);
    expect(plan.uncoveredUnits).toEqual(UNITS);
  });
});
