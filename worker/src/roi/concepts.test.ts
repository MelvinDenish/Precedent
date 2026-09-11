import { describe, expect, it } from 'vitest';
import {
  type ClusterConceptLink,
  type ConceptInput,
  type SyllabusPrior,
  rankByRoi,
  scoreConcepts,
  studyCostMinutes,
  syllabusPriorMarks,
} from './concepts.js';
import { scoreClusters } from './model.js';

const NOW = 2025;

/** The real CS23501 shape: 5 units, 45 lecture hours, 100 marks. */
const PRIOR: SyllabusPrior = {
  hoursByUnit: new Map([
    [1, 8],
    [2, 9],
    [3, 10],
    [4, 10],
    [5, 8],
  ]),
  marksByUnit: new Map([
    [1, 20],
    [2, 20],
    [3, 20],
    [4, 20],
    [5, 20],
  ]),
};

const SLOTS = new Map([
  [1, 2],
  [2, 2],
  [3, 2],
  [4, 2],
  [5, 2],
]);

describe('study cost', () => {
  it('rises with prerequisite depth', () => {
    expect(
      studyCostMinutes({ conceptId: 'deep', unitNos: [1], prerequisiteDepth: 4 }),
    ).toBeGreaterThan(studyCostMinutes({ conceptId: 'shallow', unitNos: [1], prerequisiteDepth: 0 }));
  });

  /**
   * The flywheel. Concepts that repeatedly push students to Tier 2 are the
   * genuinely hard ones; that observation corrects study cost, which sharpens
   * ROI for every future student. Nobody hand-tunes a difficulty table.
   */
  it('rises for a concept students actually escalate on', () => {
    const base: ConceptInput = { conceptId: 'c', unitNos: [1], prerequisiteDepth: 2 };
    expect(studyCostMinutes({ ...base, escalationRate: 0.9 })).toBeGreaterThan(
      studyCostMinutes({ ...base, escalationRate: 0.05 }),
    );
  });

  it('falls back to depth alone before there is any usage data', () => {
    const base: ConceptInput = { conceptId: 'c', unitNos: [1], prerequisiteDepth: 2 };
    expect(studyCostMinutes({ ...base, escalationRate: null })).toBe(studyCostMinutes(base));
  });

  it('never returns a cost that would divide ROI by zero', () => {
    expect(
      studyCostMinutes({ conceptId: 'c', unitNos: [], prerequisiteDepth: 0, escalationRate: 0 }),
    ).toBeGreaterThan(0);
  });
});

describe('the syllabus prior', () => {
  /**
   * A concept in the syllabus that has never been examined has no clusters
   * at all. Without the prior it scores zero and becomes invisible -- and
   * that is exactly the "in syllabus, never appeared" quadrant of the
   * coverage matrix, which Mastery students need and cramming students need
   * to know they are gambling on.
   */
  it('gives an unexamined concept a non-zero weight', () => {
    expect(
      syllabusPriorMarks({ conceptId: 'never-asked', unitNos: [3], prerequisiteDepth: 1 }, PRIOR),
    ).toBeGreaterThan(0);
  });

  it('weights a unit with more teaching hours more heavily', () => {
    // Unit 3 has 10 lecture hours, unit 1 has 8.
    expect(
      syllabusPriorMarks({ conceptId: 'a', unitNos: [3], prerequisiteDepth: 0 }, PRIOR),
    ).toBeGreaterThan(syllabusPriorMarks({ conceptId: 'b', unitNos: [1], prerequisiteDepth: 0 }, PRIOR));
  });

  it('does not let a concept spanning units earn their marks twice', () => {
    const single = syllabusPriorMarks({ conceptId: 'a', unitNos: [3], prerequisiteDepth: 0 }, PRIOR);
    const spanning = syllabusPriorMarks(
      { conceptId: 'b', unitNos: [3, 4], prerequisiteDepth: 0 },
      PRIOR,
    );
    expect(spanning).toBeLessThanOrEqual(single * 1.5);
  });

  it('is zero for a concept aligned to no unit', () => {
    expect(
      syllabusPriorMarks({ conceptId: 'orphan', unitNos: [], prerequisiteDepth: 0 }, PRIOR),
    ).toBe(0);
  });
});

describe('concept scoring', () => {
  it('accumulates marks across every cluster testing the concept', () => {
    const clusters = scoreClusters(
      [
        { clusterId: 'k1', appearanceYears: [2023], marks: 13, unitNo: 1 },
        { clusterId: 'k2', appearanceYears: [2024], marks: 13, unitNo: 1 },
      ],
      { currentYear: NOW, slotsPerUnit: SLOTS },
    );

    const scored = scoreConcepts(
      [
        { conceptId: 'tested-twice', unitNos: [1], prerequisiteDepth: 1 },
        { conceptId: 'tested-once', unitNos: [1], prerequisiteDepth: 1 },
      ],
      clusters,
      [
        { clusterId: 'k1', conceptId: 'tested-twice', weight: 1 },
        { clusterId: 'k2', conceptId: 'tested-twice', weight: 1 },
        { clusterId: 'k1', conceptId: 'tested-once', weight: 1 },
      ],
      { regime: 'high', prior: PRIOR },
    );

    const twice = scored.find((s) => s.conceptId === 'tested-twice')!;
    expect(twice.expectedMarks).toBeGreaterThan(
      scored.find((s) => s.conceptId === 'tested-once')!.expectedMarks,
    );
    expect(twice.evidenceClusterCount).toBe(2);
  });

  it('scales a partial multi-label weight down', () => {
    const clusters = scoreClusters(
      [{ clusterId: 'k1', appearanceYears: [2024], marks: 13, unitNo: 1 }],
      { currentYear: NOW, slotsPerUnit: SLOTS },
    );
    const scored = scoreConcepts(
      [
        { conceptId: 'primary', unitNos: [1], prerequisiteDepth: 1 },
        { conceptId: 'incidental', unitNos: [1], prerequisiteDepth: 1 },
      ],
      clusters,
      [
        { clusterId: 'k1', conceptId: 'primary', weight: 1 },
        { clusterId: 'k1', conceptId: 'incidental', weight: 0.2 },
      ],
      { regime: 'high', prior: PRIOR },
    );
    expect(scored.find((s) => s.conceptId === 'primary')!.expectedMarks).toBeGreaterThan(
      scored.find((s) => s.conceptId === 'incidental')!.expectedMarks,
    );
  });

  it('ranks by marks per minute, not by marks alone', () => {
    const clusters = scoreClusters(
      [
        { clusterId: 'k1', appearanceYears: [2024], marks: 13, unitNo: 1 },
        { clusterId: 'k2', appearanceYears: [2024], marks: 13, unitNo: 1 },
      ],
      { currentYear: NOW, slotsPerUnit: SLOTS },
    );
    // Equal marks; one is far cheaper to learn.
    const scored = scoreConcepts(
      [
        { conceptId: 'cheap', unitNos: [1], prerequisiteDepth: 0 },
        { conceptId: 'expensive', unitNos: [1], prerequisiteDepth: 6 },
      ],
      clusters,
      [
        { clusterId: 'k1', conceptId: 'cheap', weight: 1 },
        { clusterId: 'k2', conceptId: 'expensive', weight: 1 },
      ],
      { regime: 'high', prior: PRIOR },
    );
    expect(rankByRoi(scored)[0]!.conceptId).toBe('cheap');
  });

  it('ranks deterministically, because the UI must explain the order', () => {
    const scored = [
      { conceptId: 'b', expectedMarks: 5, studyCostMin: 10, roi: 0.5, evidenceClusterCount: 1 },
      { conceptId: 'a', expectedMarks: 5, studyCostMin: 10, roi: 0.5, evidenceClusterCount: 1 },
    ];
    expect(rankByRoi(scored).map((s) => s.conceptId)).toEqual(['a', 'b']);
    expect(rankByRoi(scored)).toEqual(rankByRoi([...scored].reverse()));
  });
});

/**
 * THE PROOF THE CONCEPT REFRAME WORKS.
 *
 * docs/EVALUATION.md section 2: "the low-repetition subject must still beat
 * syllabus order. This is the proof the concept reframe works."
 *
 * The scenario below is the one that breaks a pure-recurrence product: NO
 * question ever repeats, so per-question prediction has nothing to say. But
 * the examiner still concentrates marks on a few areas, asking about them
 * through many DIFFERENT questions, so expected marks accumulate per concept
 * even where they never accumulate per question.
 *
 * Naive syllabus order is the baseline because it is literally what students
 * do: start at Unit 1, page 1.
 */
describe('a low-repetition subject still beats naive syllabus order', () => {
  it('ranks the genuinely heavy concepts above unit order', () => {
    const clusters: {
      clusterId: string;
      appearanceYears: number[];
      marks: number;
      unitNo: number;
    }[] = [];
    const links: ClusterConceptLink[] = [];
    const concepts: ConceptInput[] = [];

    for (let unit = 1; unit <= 5; unit += 1) {
      // Units 4 and 5 are examined three times as often as units 1 to 3,
      // but through entirely different questions each sitting.
      const clusterCount = unit >= 4 ? 9 : 3;
      concepts.push({ conceptId: `u${unit}`, unitNos: [unit], prerequisiteDepth: 1 });

      for (let i = 0; i < clusterCount; i += 1) {
        const id = `u${unit}-k${i}`;
        clusters.push({
          clusterId: id,
          appearanceYears: [2019 + (i % 6)], // each appears exactly once
          marks: 13,
          unitNo: unit,
        });
        links.push({ clusterId: id, conceptId: `u${unit}`, weight: 1 });
      }
    }

    const scored = scoreClusters(clusters, { currentYear: NOW, slotsPerUnit: SLOTS });

    // Sanity: this really is a non-repeating corpus, so per-question
    // prediction genuinely has nothing to work with.
    expect(scored.every((s) => s.appearances === 1)).toBe(true);

    const conceptScores = scoreConcepts(concepts, scored, links, {
      regime: 'low',
      prior: PRIOR,
    });
    const ranked = rankByRoi(conceptScores).map((s) => s.conceptId);

    // Naive syllabus order studies u1 first. ROI puts the units the examiner
    // actually favours ahead of it, despite zero question recurrence.
    expect(ranked.indexOf('u4')).toBeLessThan(ranked.indexOf('u1'));
    expect(ranked.indexOf('u5')).toBeLessThan(ranked.indexOf('u1'));

    // And it covers more expected marks than the baseline at k=2.
    const byConcept = new Map(conceptScores.map((s) => [s.conceptId, s.expectedMarks]));
    const roiTop2 = ranked.slice(0, 2).reduce((sum, id) => sum + (byConcept.get(id) ?? 0), 0);
    const syllabusTop2 = ['u1', 'u2'].reduce((sum, id) => sum + (byConcept.get(id) ?? 0), 0);
    expect(roiTop2).toBeGreaterThan(syllabusTop2);
  });
});
