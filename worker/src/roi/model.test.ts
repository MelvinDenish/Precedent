import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEIGHTS,
  assessRegime,
  decayedFrequency,
  evidenceWeightFor,
  meanGapYears,
  overdueRatio,
  scoreClusters,
  unitQuotaPressure,
} from './model.js';

const NOW = 2025;

describe('decayed frequency', () => {
  it('weights a recent appearance above an old one', () => {
    expect(decayedFrequency([2024], NOW, 0.75)).toBeGreaterThan(
      decayedFrequency([2020], NOW, 0.75),
    );
  });

  it('accumulates across appearances', () => {
    expect(decayedFrequency([2023, 2024], NOW, 0.75)).toBeGreaterThan(
      decayedFrequency([2023], NOW, 0.75),
    );
  });

  it('gives a current-year appearance full weight', () => {
    expect(decayedFrequency([NOW], NOW, 0.75)).toBeCloseTo(1);
  });

  /**
   * The older Networks papers in this corpus sit under CS6111 / Regulation
   * 2018 while the current subject is CS23502 / R2023. Dropping them would
   * leave too few sittings to evaluate against at all, so they are
   * discounted rather than discarded.
   */
  it('discounts pre-revision evidence without discarding it', () => {
    const full = decayedFrequency([2022], NOW, 0.75, 1);
    const discounted = decayedFrequency([2022], NOW, 0.75, 0.5);
    expect(discounted).toBeCloseTo(full * 0.5);
    expect(discounted).toBeGreaterThan(0);
  });

  it('is zero with no evidence', () => {
    expect(decayedFrequency([], NOW, 0.75)).toBe(0);
  });
});

describe('the overdue term', () => {
  /**
   * COUNTER-INTUITIVE AND LOAD-BEARING. Examiners rotate through units, so a
   * topic absent for several sittings is MORE likely to appear, not less.
   * Raw frequency counting gets this exactly backwards, which is why
   * hand-computed "important questions" lists go stale: they rank what
   * appeared most recently, which is disproportionately what is about to be
   * skipped.
   */
  it('ranks an overdue cluster ABOVE a recently-seen one of equal history', () => {
    // Both appeared 3 times at 2-year intervals; one is 6 years overdue.
    expect(overdueRatio([2015, 2017, 2019], NOW)!).toBeGreaterThan(
      overdueRatio([2021, 2023, 2025], NOW)!,
    );
  });

  it('reads 1.0 when a cluster is exactly due', () => {
    // Mean gap 2 years, last seen 2 years ago.
    expect(overdueRatio([2019, 2021, 2023], NOW)).toBeCloseTo(1);
  });

  it('reads below 1 when a cluster was just examined', () => {
    expect(overdueRatio([2021, 2023, 2025], NOW)!).toBeLessThan(1);
  });

  it('clamps, so one ancient appearance cannot dominate', () => {
    // Unclamped, a single 1999 sighting yields a ratio of 26 from one point.
    expect(overdueRatio([1999], NOW)).toBeLessThanOrEqual(3);
  });

  it('returns null with no appearances rather than a misleading zero', () => {
    expect(overdueRatio([], NOW)).toBeNull();
  });

  it('survives two appearances in one year without dividing by zero', () => {
    expect(overdueRatio([2023, 2023], NOW)).toBe(1);
  });
});

describe('mean gap', () => {
  it('averages the intervals', () => {
    expect(meanGapYears([2019, 2021, 2023])).toBe(2);
  });

  it('is null below two appearances, where there is no interval', () => {
    expect(meanGapYears([2023])).toBeNull();
    expect(meanGapYears([])).toBeNull();
  });
});

describe('unit quota pressure', () => {
  it('rises when few clusters compete for a unit slot', () => {
    const slots = new Map([[1, 2]]);
    expect(unitQuotaPressure(1, slots, new Map([[1, 3]]))).toBeGreaterThan(
      unitQuotaPressure(1, slots, new Map([[1, 20]])),
    );
  });

  it('is capped at 1, so it stays on a probability scale', () => {
    expect(unitQuotaPressure(1, new Map([[1, 5]]), new Map([[1, 1]]))).toBe(1);
  });

  it('is zero for a concept with no unit', () => {
    expect(unitQuotaPressure(null, new Map([[1, 2]]), new Map([[1, 2]]))).toBe(0);
  });
});

describe('scoring a subject', () => {
  const slots = new Map([
    [1, 2],
    [2, 2],
  ]);

  it('normalises pNext into a distribution', () => {
    const scores = scoreClusters(
      [
        { clusterId: 'a', appearanceYears: [2021, 2023], marks: 13, unitNo: 1 },
        { clusterId: 'b', appearanceYears: [2024], marks: 2, unitNo: 2 },
        { clusterId: 'c', appearanceYears: [2019], marks: 13, unitNo: 1 },
      ],
      { currentYear: NOW, slotsPerUnit: slots },
    );

    expect(scores.reduce((sum, s) => sum + s.pNext, 0)).toBeCloseTo(1);
    expect(scores.every((s) => s.pNext >= 0 && s.pNext <= 1)).toBe(true);
  });

  it('weights expected marks by both probability and marks', () => {
    const scores = scoreClusters(
      [
        { clusterId: 'heavy', appearanceYears: [2023], marks: 13, unitNo: 1 },
        { clusterId: 'light', appearanceYears: [2023], marks: 2, unitNo: 1 },
      ],
      { currentYear: NOW, slotsPerUnit: slots },
    );

    expect(scores.find((s) => s.clusterId === 'heavy')!.expectedMarks).toBeGreaterThan(
      scores.find((s) => s.clusterId === 'light')!.expectedMarks,
    );
  });

  it('reports the evidence behind each score, for the citation trail', () => {
    const [score] = scoreClusters(
      [{ clusterId: 'a', appearanceYears: [2019, 2021, 2023], marks: 13, unitNo: 1 }],
      { currentYear: NOW, slotsPerUnit: slots },
    );
    expect(score!.appearances).toBe(3);
    expect(score!.lastSeenYear).toBe(2023);
    expect(score!.meanGapYears).toBe(2);
  });

  it('does not divide by zero on an empty subject', () => {
    expect(scoreClusters([], { currentYear: NOW, slotsPerUnit: slots })).toEqual([]);
  });

  it('is deterministic: identical input gives identical output', () => {
    const input = [{ clusterId: 'a', appearanceYears: [2021, 2023], marks: 13, unitNo: 1 }];
    const opts = { currentYear: NOW, slotsPerUnit: slots, weights: DEFAULT_WEIGHTS };
    expect(scoreClusters(input, opts)).toEqual(scoreClusters(input, opts));
  });
});

describe('the repetition regime', () => {
  const cluster = (id: string, years: number[]) => ({
    clusterId: id,
    appearanceYears: years,
    marks: 13,
    unitNo: 1,
  });

  it('calls a heavily-repeating subject high, and says so with real numbers', () => {
    const assessment = assessRegime(
      [
        cluster('a', [2021, 2023]),
        cluster('b', [2022, 2024]),
        cluster('c', [2021, 2025]),
        cluster('d', [2023]),
      ],
      8,
    );
    expect(assessment.regime).toBe('high');
    expect(assessment.statement).toMatch(/3 questions have repeated across 8 papers/);
  });

  /**
   * A low-repetition subject must not break the product. It must stop making
   * per-question claims, start making per-topic ones, and SAY SO. That is
   * the system stating what it does not know.
   */
  it('calls a non-repeating subject low, and says guidance is topic-level', () => {
    const clusters = Array.from({ length: 20 }, (_, i) => cluster(`c${i}`, [2020 + (i % 5)]));
    const assessment = assessRegime(clusters, 6);
    expect(assessment.regime).toBe('low');
    expect(assessment.statement).toMatch(/rarely repeat/i);
    expect(assessment.statement).toMatch(/topic-level/i);
  });

  /**
   * Two papers sharing one question is a 50% repetition rate computed from
   * nothing. Paper count gates the claim regardless of the ratio.
   */
  it('refuses to call a subject high on too few papers', () => {
    const assessment = assessRegime([cluster('a', [2023, 2024])], 2);
    expect(assessment.regime).toBe('low');
    expect(assessment.statement).toMatch(/Only 2 paper/);
  });

  it('handles a subject with no clusters yet', () => {
    const assessment = assessRegime([], 0);
    expect(assessment.regime).toBe('low');
    expect(assessment.repetitionRate).toBe(0);
  });

  it('does not count one cluster examined twice in a single year as repetition', () => {
    expect(assessRegime([cluster('a', [2023, 2023])], 5).repetitionRate).toBe(0);
  });
});

describe('evidence weighting by regime', () => {
  it('leans on the corpus when questions repeat', () => {
    expect(evidenceWeightFor('high').corpus).toBeGreaterThan(0.8);
  });

  /**
   * In a LOW regime pNext flattens toward uniform, so trusting it would be
   * trusting noise. The weighting shifts onto the syllabus prior instead.
   */
  it('leans on the syllabus prior when they do not', () => {
    const low = evidenceWeightFor('low');
    expect(low.syllabusPrior).toBeGreaterThan(low.corpus);
  });

  it('always sums to 1, so expected marks stay on one scale', () => {
    for (const regime of ['high', 'medium', 'low'] as const) {
      const weights = evidenceWeightFor(regime);
      expect(weights.corpus + weights.syllabusPrior).toBeCloseTo(1);
    }
  });
});
