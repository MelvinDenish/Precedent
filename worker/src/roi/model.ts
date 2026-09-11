/**
 * The recurrence and ROI model.
 *
 * THIS DELIBERATELY USES NO LLM, AND THAT IS THE MOST IMPORTANT DECISION IN
 * THE PROJECT.
 *
 * "These topics carry the marks" is the product's central claim, so it has to
 * be calibrated, evaluated against a held-out year, and defensible under
 * questioning. A model asked "will this appear?" returns a number that cannot
 * be calibrated, cannot improve with more data, and cannot be defended. A
 * statistical model over decayed frequency, renewal hazard, unit quota
 * pressure and marks weight can be all three, and is measured against a naive
 * syllabus-order baseline in docs/EVALUATION.md.
 *
 * See docs/AGENTS.md section 4.1 and docs/PEDAGOGY.md section 2.
 */

import type { Regime } from '@precedent/shared';

// --- Layer 1: cluster appearance probability ------------------------

export interface ClusterEvidence {
  clusterId: string;
  /** Years this cluster was examined in, ascending. May repeat within a year. */
  appearanceYears: number[];
  /** Marks the cluster is typically worth. */
  marks: number;
  /** Which syllabus unit its concepts live in, for quota pressure. */
  unitNo: number | null;
  /**
   * Weight applied to evidence predating a syllabus revision, from
   * subject_lineage.discount. 1 for current-regulation evidence.
   */
  lineageDiscount?: number;
}

export interface RoiWeights {
  decayedFrequency: number;
  overdue: number;
  unitQuota: number;
  marks: number;
  /** Per-year decay. 0.75 means evidence is worth 75% of its value a year on. */
  lambda: number;
}

/**
 * Defaults, chosen to be defensible rather than fitted: recency dominates,
 * the renewal hazard is a real but secondary correction, and quota pressure
 * is a structural prior rather than evidence.
 */
export const DEFAULT_WEIGHTS: RoiWeights = {
  decayedFrequency: 0.45,
  overdue: 0.25,
  unitQuota: 0.15,
  marks: 0.15,
  lambda: 0.75,
};

/**
 * Sum of lambda^(years ago) across appearances.
 *
 * Evidence from before a syllabus revision is discounted rather than dropped.
 * This corpus genuinely needs that: the older Networks papers sit under
 * CS6111 / Regulation 2018 while the current subject is CS23502 / R2023, and
 * discarding them would leave too few sittings to evaluate against at all.
 */
export function decayedFrequency(
  appearanceYears: readonly number[],
  currentYear: number,
  lambda: number,
  lineageDiscount = 1,
): number {
  let total = 0;
  for (const year of appearanceYears) {
    const yearsAgo = Math.max(0, currentYear - year);
    total += lambda ** yearsAgo;
  }
  return total * lineageDiscount;
}

/**
 * Renewal hazard: how overdue a cluster is relative to its own rhythm.
 *
 * COUNTER-INTUITIVE AND LOAD-BEARING. A topic absent for three sittings is
 * MORE likely to appear, not less, because examiners rotate through units.
 * Raw frequency counting gets this exactly backwards, which is one reason
 * hand-computed "important questions" lists go stale: they rank what appeared
 * most recently, which is disproportionately what is about to be skipped.
 *
 * Returns 1.0 when a cluster is exactly due, above 1 when overdue, below 1
 * when recently seen. Clamped at 3, because otherwise a single ancient
 * appearance produces an unbounded ratio out of one data point.
 */
export function overdueRatio(
  appearanceYears: readonly number[],
  currentYear: number,
): number | null {
  if (appearanceYears.length === 0) return null;

  const sorted = [...appearanceYears].sort((a, b) => a - b);
  const lastSeen = sorted[sorted.length - 1]!;
  const gapSinceLast = Math.max(0, currentYear - lastSeen);

  // One appearance gives no rhythm to compare against, so fall back to the
  // gap itself against a one-year expectation rather than inventing a mean.
  if (sorted.length === 1) return Math.min(gapSinceLast, 3);

  let gapTotal = 0;
  for (let i = 1; i < sorted.length; i += 1) gapTotal += sorted[i]! - sorted[i - 1]!;
  const meanGap = gapTotal / (sorted.length - 1);

  if (meanGap <= 0) return 1;
  return Math.min(gapSinceLast / meanGap, 3);
}

export function meanGapYears(appearanceYears: readonly number[]): number | null {
  if (appearanceYears.length < 2) return null;
  const sorted = [...appearanceYears].sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < sorted.length; i += 1) total += sorted[i]! - sorted[i - 1]!;
  return total / (sorted.length - 1);
}

/**
 * How hard the paper's structure forces questions out of a given unit.
 *
 * The paper must fill a fixed number of slots from each unit, so a unit with
 * few distinct clusters competing for those slots gives each one a higher
 * chance. This is structural pressure rather than evidence, which is why it
 * carries the smallest weight of the four.
 */
export function unitQuotaPressure(
  unitNo: number | null,
  slotsPerUnit: ReadonlyMap<number, number>,
  clustersPerUnit: ReadonlyMap<number, number>,
): number {
  if (unitNo === null) return 0;
  const slots = slotsPerUnit.get(unitNo) ?? 0;
  const competitors = clustersPerUnit.get(unitNo) ?? 0;
  if (competitors === 0) return 0;
  return Math.min(slots / competitors, 1);
}

export interface ClusterScore {
  clusterId: string;
  decayedFreq: number;
  overdueRatio: number | null;
  meanGapYears: number | null;
  lastSeenYear: number | null;
  appearances: number;
  /** Normalised across the subject, so it reads as a probability. */
  pNext: number;
  expectedMarks: number;
}

/**
 * Scores every cluster in a subject and normalises pNext across them.
 *
 * Normalisation is per subject because the score is only ever used to rank
 * and to weight within one corpus. Comparing a raw score across subjects with
 * different paper counts would be meaningless.
 */
export function scoreClusters(
  clusters: readonly ClusterEvidence[],
  options: {
    currentYear: number;
    slotsPerUnit: ReadonlyMap<number, number>;
    weights?: RoiWeights;
  },
): ClusterScore[] {
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const { currentYear, slotsPerUnit } = options;

  const clustersPerUnit = new Map<number, number>();
  for (const cluster of clusters) {
    if (cluster.unitNo === null) continue;
    clustersPerUnit.set(cluster.unitNo, (clustersPerUnit.get(cluster.unitNo) ?? 0) + 1);
  }

  const maxMarks = Math.max(1, ...clusters.map((c) => c.marks));

  const raw = clusters.map((cluster) => {
    const freq = decayedFrequency(
      cluster.appearanceYears,
      currentYear,
      weights.lambda,
      cluster.lineageDiscount ?? 1,
    );
    const overdue = overdueRatio(cluster.appearanceYears, currentYear);
    const quota = unitQuotaPressure(cluster.unitNo, slotsPerUnit, clustersPerUnit);

    const score =
      weights.decayedFrequency * freq +
      weights.overdue * (overdue ?? 0) +
      weights.unitQuota * quota +
      weights.marks * (cluster.marks / maxMarks);

    const sorted = [...cluster.appearanceYears].sort((a, b) => a - b);

    return {
      clusterId: cluster.clusterId,
      decayedFreq: freq,
      overdueRatio: overdue,
      meanGapYears: meanGapYears(cluster.appearanceYears),
      lastSeenYear: sorted.length > 0 ? sorted[sorted.length - 1]! : null,
      appearances: cluster.appearanceYears.length,
      score,
      marks: cluster.marks,
    };
  });

  const scoreTotal = raw.reduce((sum, r) => sum + r.score, 0);

  return raw.map((r) => {
    const pNext = scoreTotal > 0 ? r.score / scoreTotal : 0;
    return {
      clusterId: r.clusterId,
      decayedFreq: r.decayedFreq,
      overdueRatio: r.overdueRatio,
      meanGapYears: r.meanGapYears,
      lastSeenYear: r.lastSeenYear,
      appearances: r.appearances,
      pNext,
      expectedMarks: pNext * r.marks,
    };
  });
}

// --- The repetition regime ------------------------------------------

export interface RegimeAssessment {
  regime: Regime;
  repetitionRate: number;
  paperCount: number;
  /** What the UI says out loud. The system states what it does not know. */
  statement: string;
}

/**
 * Measures how much a subject actually repeats, and says so.
 *
 * This is what stops the product silently becoming useless on a subject that
 * does not repeat. In a LOW regime the weighting shifts off per-cluster pNext
 * and onto concept-level frequency and syllabus priors, and the UI stops
 * making per-question claims. A recurrence-only product would keep producing
 * confident rankings from almost no signal, and the student would have no way
 * to tell the difference.
 */
export function assessRegime(
  clusters: readonly ClusterEvidence[],
  paperCount: number,
): RegimeAssessment {
  const multiYear = clusters.filter((c) => new Set(c.appearanceYears).size >= 2).length;
  const repetitionRate = clusters.length > 0 ? multiYear / clusters.length : 0;

  // Too few papers to make any repetition claim, whatever the ratio says.
  // Two papers sharing one question is a 50% rate computed from nothing.
  if (paperCount < 3) {
    return {
      regime: 'low',
      repetitionRate,
      paperCount,
      statement:
        `Only ${paperCount} paper(s) for this subject so far. Guidance here is ` +
        'topic-level, from the syllabus, until more papers are contributed.',
    };
  }

  if (repetitionRate >= 0.25) {
    return {
      regime: 'high',
      repetitionRate,
      paperCount,
      statement: `${multiYear} questions have repeated across ${paperCount} papers.`,
    };
  }

  if (repetitionRate >= 0.1) {
    return {
      regime: 'medium',
      repetitionRate,
      paperCount,
      statement: 'Some questions repeat; topic-level guidance is stronger here.',
    };
  }

  return {
    regime: 'low',
    repetitionRate,
    paperCount,
    statement: 'Questions rarely repeat in this subject. Guidance here is topic-level.',
  };
}

/**
 * How much per-cluster evidence to trust, by regime.
 *
 * In a LOW regime pNext flattens toward uniform and carries little signal, so
 * expected marks lean on the syllabus prior -- unit hours, marks distribution
 * -- instead. Concept expected marks stay meaningful either way, because they
 * sum across MANY different questions testing one concept. That is precisely
 * why the concept reframe makes the product work on subjects a pure
 * recurrence system would fail on.
 */
export function evidenceWeightFor(regime: Regime): { corpus: number; syllabusPrior: number } {
  switch (regime) {
    case 'high':
      return { corpus: 0.85, syllabusPrior: 0.15 };
    case 'medium':
      return { corpus: 0.6, syllabusPrior: 0.4 };
    case 'low':
      return { corpus: 0.35, syllabusPrior: 0.65 };
  }
}
