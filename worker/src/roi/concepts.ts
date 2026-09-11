/**
 * Layer 2: concept expected marks, study cost, and ROI.
 *
 * Questions are EVIDENCE (which concepts carry marks, and how they are
 * angled) and ASSESSMENT (real past questions prove you learned it).
 * Concepts are the unit of study, and this is where that inversion is
 * actually computed.
 *
 * The property that makes it work: in a LOW repetition subject pNext
 * flattens and per-question prediction is near worthless, but
 * expected_marks(concept) stays meaningful because it sums across MANY
 * DIFFERENT questions testing the same concept. A topic can be high-value
 * even when no single question ever repeats.
 *
 * See docs/PEDAGOGY.md sections 1 and 2.
 */

import type { Regime } from '@precedent/shared';
import { type ClusterScore, evidenceWeightFor } from './model.js';

/** How strongly a cluster tests a concept. A question can test several. */
export interface ClusterConceptLink {
  clusterId: string;
  conceptId: string;
  /** 0..1 multi-label weight. */
  weight: number;
}

export interface ConceptInput {
  conceptId: string;
  /** Syllabus units this concept belongs to. */
  unitNos: number[];
  /** Depth in the prerequisite DAG. Drives the initial study-cost estimate. */
  prerequisiteDepth: number;
  /**
   * Share of students who needed Tier 2 help on this concept, from
   * concept_stats.escalation_rate. Null until there is usage.
   */
  escalationRate?: number | null;
}

/** The syllabus prior, used where corpus evidence is thin. */
export interface SyllabusPrior {
  /** Lecture hours per unit, from the parsed syllabus. */
  hoursByUnit: ReadonlyMap<number, number>;
  /** Marks the paper allocates to each unit, from papers.template. */
  marksByUnit: ReadonlyMap<number, number>;
}

export interface ConceptScore {
  conceptId: string;
  expectedMarks: number;
  studyCostMin: number;
  roi: number;
  evidenceClusterCount: number;
}

/**
 * Minutes to learn a concept from cold.
 *
 * Starts as a function of prerequisite depth, then is CORRECTED by the
 * observed escalation rate -- the share of students who needed Tier 2 help
 * on it. Concepts students actually find hard get costed correctly over
 * time, without anyone hand-tuning a table. That flywheel costs nothing
 * extra, because every escalation is already logged for other reasons.
 */
export function studyCostMinutes(concept: ConceptInput): number {
  const BASE_MIN = 12;
  const PER_DEPTH_MIN = 6;

  const base = BASE_MIN + concept.prerequisiteDepth * PER_DEPTH_MIN;

  const escalation = concept.escalationRate;
  if (escalation === null || escalation === undefined) return Math.round(base);

  // A concept that pushes every student to Tier 2 costs roughly double what
  // its depth alone suggests; one nobody escalates on costs slightly less.
  const multiplier = 0.85 + escalation * 1.15;
  return Math.max(5, Math.round(base * multiplier));
}

/**
 * The syllabus-prior contribution for a concept, in marks.
 *
 * Used where the corpus cannot speak. A concept in the syllabus that has
 * never been examined has no clusters at all, so without this it scores zero
 * and becomes invisible -- which is exactly the "in syllabus, never appeared"
 * quadrant of the coverage matrix. A Mastery student needs it, and a cramming
 * student needs to know what they are gambling on by skipping it.
 */
export function syllabusPriorMarks(concept: ConceptInput, prior: SyllabusPrior): number {
  if (concept.unitNos.length === 0) return 0;

  const hoursTotal = [...prior.hoursByUnit.values()].reduce((a, b) => a + b, 0);

  let total = 0;
  for (const unitNo of concept.unitNos) {
    const unitMarks = prior.marksByUnit.get(unitNo) ?? 0;
    const unitHours = prior.hoursByUnit.get(unitNo) ?? 0;

    // Split the unit's marks by the share of teaching time it represents, as
    // a proxy for how much of the unit this concept accounts for.
    const hourShare = hoursTotal > 0 ? unitHours / hoursTotal : 0;
    total += unitMarks * hourShare;
  }

  // A concept spanning several units does not earn their marks twice over.
  return total / concept.unitNos.length;
}

/**
 * expected_marks(c) = sum over clusters k testing c of
 *                        p_next(k) * marks(k) * weight(k, c)
 *
 * blended with the syllabus prior according to the subject's regime.
 */
export function scoreConcepts(
  concepts: readonly ConceptInput[],
  clusterScores: readonly ClusterScore[],
  links: readonly ClusterConceptLink[],
  options: { regime: Regime; prior: SyllabusPrior },
): ConceptScore[] {
  const byCluster = new Map(clusterScores.map((c) => [c.clusterId, c]));

  const linksByConcept = new Map<string, ClusterConceptLink[]>();
  for (const link of links) {
    const existing = linksByConcept.get(link.conceptId);
    if (existing) existing.push(link);
    else linksByConcept.set(link.conceptId, [link]);
  }

  const weights = evidenceWeightFor(options.regime);

  return concepts.map((concept) => {
    const conceptLinks = linksByConcept.get(concept.conceptId) ?? [];

    let corpusMarks = 0;
    for (const link of conceptLinks) {
      const cluster = byCluster.get(link.clusterId);
      if (!cluster) continue;
      corpusMarks += cluster.expectedMarks * link.weight;
    }

    const priorMarks = syllabusPriorMarks(concept, options.prior);
    const expectedMarks = weights.corpus * corpusMarks + weights.syllabusPrior * priorMarks;

    const studyCostMin = studyCostMinutes(concept);

    return {
      conceptId: concept.conceptId,
      expectedMarks,
      studyCostMin,
      roi: studyCostMin > 0 ? expectedMarks / studyCostMin : 0,
      evidenceClusterCount: conceptLinks.length,
    };
  });
}

/**
 * Ranks concepts for Night Before mode: highest marks per minute first.
 *
 * Ties break on expected marks rather than arbitrarily, so a student choosing
 * between two equally efficient topics studies the heavier one. The final
 * tiebreak on id keeps the ordering deterministic, which matters because the
 * UI has to explain why topic 3 outranks topic 4 and the answer cannot change
 * between two runs over identical data.
 */
export function rankByRoi(scores: readonly ConceptScore[]): ConceptScore[] {
  return [...scores].sort((a, b) => {
    if (b.roi !== a.roi) return b.roi - a.roi;
    if (b.expectedMarks !== a.expectedMarks) return b.expectedMarks - a.expectedMarks;
    return a.conceptId.localeCompare(b.conceptId);
  });
}
