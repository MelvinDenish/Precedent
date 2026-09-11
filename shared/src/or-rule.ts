/**
 * THE OR RULE.
 *
 *   Two questions may not be merged into the same cluster IF AND ONLY IF
 *   they share a paper AND an or_group.
 *
 * This is the single most dangerous rule in the system, because both ways of
 * getting it wrong fail SILENTLY:
 *
 *   Too strong (checking or_group_id alone, ignoring paper_id):
 *       2023 Q11(a) and 2024 Q13(b) are the same question sitting in
 *       different OR-slots in different years. Those cross-year merges are
 *       precisely what the product exists to find. Suppressing them DEFLATES
 *       every recurrence count and raises no error anywhere.
 *
 *   Too weak (no check at all):
 *       Alternatives within one paper get merged. Recurrence counts INFLATE.
 *
 * Both directions are asserted in or-rule.test.ts. This function is the only
 * place the rule is implemented, and it is enforced in CODE -- never in a
 * prompt. Prompts are not a safety mechanism.
 *
 * See docs/ARCHITECTURE.md section 2.3.
 */

/** The minimum a question must expose for the rule to be decidable. */
export interface OrRuleOperand {
  paperId: string;
  orGroupId: number | null;
}

/**
 * True when the two questions are alternatives offered against each other in
 * the same paper -- a student answers one or the other, never both, so they
 * are different questions however similar their wording.
 */
export function areOrAlternatives(a: OrRuleOperand, b: OrRuleOperand): boolean {
  if (a.paperId !== b.paperId) return false; // different papers: never alternatives
  if (a.orGroupId === null || b.orGroupId === null) return false; // no choice offered
  return a.orGroupId === b.orGroupId;
}

/**
 * The merge guard. Call before writing any question_cluster row, and again
 * inside the merge transaction -- candidate retrieval excludes same-paper
 * questions, but a merge of two existing clusters can still pull an
 * OR-sibling in transitively.
 */
export function canMerge(a: OrRuleOperand, b: OrRuleOperand): boolean {
  return !areOrAlternatives(a, b);
}

/**
 * Guard for merging two whole clusters: no member of one may be an
 * OR-alternative of any member of the other.
 *
 * Returns the offending pair rather than a bare boolean, so the caller can
 * log which questions blocked the merge instead of failing opaquely.
 */
export function findBlockingOrPair<T extends OrRuleOperand>(
  left: readonly T[],
  right: readonly T[],
): { left: T; right: T } | null {
  // Index by paper first: the rule can only fire within a shared paper, and
  // clusters routinely hold dozens of members across many papers.
  const rightByPaper = new Map<string, T[]>();
  for (const q of right) {
    if (q.orGroupId === null) continue; // cannot be an alternative
    const bucket = rightByPaper.get(q.paperId);
    if (bucket) bucket.push(q);
    else rightByPaper.set(q.paperId, [q]);
  }

  for (const l of left) {
    if (l.orGroupId === null) continue;
    const candidates = rightByPaper.get(l.paperId);
    if (!candidates) continue;
    for (const r of candidates) {
      if (areOrAlternatives(l, r)) return { left: l, right: r };
    }
  }
  return null;
}
