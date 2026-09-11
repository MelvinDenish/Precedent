/**
 * The Learn Loop: a finite state machine over the concept graph.
 *
 *   SELECT -> TEACH -> TEST -> (PASS | FAIL) -> ...
 *
 * IT IS DELIBERATELY NOT AN AGENT. Teach, test, branch on failure, hop a
 * prerequisite edge is a state machine, and making it an agent would trade
 * away three properties for nothing an agent provides:
 *
 *   deterministic  the same state yields the same next step, so behaviour is
 *                  testable rather than merely observed
 *   auditable      the student can see WHY they were sent to a prerequisite
 *   resumable      every transition persists, so a student who closes the
 *                  tab at 2am resumes exactly where they stopped
 *
 * The transition logic here is a PURE FUNCTION and persistence is the
 * caller's job. That is what lets the machine be tested without a database
 * and replayed deterministically from any stored snapshot.
 *
 * See docs/PEDAGOGY.md section 4.3 and docs/AGENTS.md section 4.2.
 */

import type { LearnCursor, LearnMode, LearnPlan, LearnState } from '@precedent/shared';

export interface LoopSnapshot {
  mode: LearnMode;
  state: LearnState;
  plan: LearnPlan;
  cursor: LearnCursor;
  spentMin: number;
  budgetMin: number | null;
}

export type LoopEvent =
  | { type: 'START' }
  | { type: 'LESSON_SERVED'; conceptId: string; minutesSpent: number }
  | { type: 'TEST_PASSED'; conceptId: string; minutesSpent: number }
  | {
      type: 'TEST_FAILED';
      conceptId: string;
      minutesSpent: number;
      /** Concepts the evaluator mapped the missed points to, weakest first. */
      missedPrerequisiteIds: string[];
    }
  | { type: 'ESCALATE' }
  | { type: 'TUTOR_RESOLVED' }
  | { type: 'ABANDON_CONCEPT' };

export type LoopEffect =
  | { kind: 'serve_lesson'; conceptId: string; depth: 'cram' | 'full' }
  | { kind: 'serve_test'; conceptId: string }
  | { kind: 'record_mastery'; conceptId: string; passed: boolean }
  | { kind: 'log_escalation'; conceptId: string; fromTier: 0 | 1; toTier: 2 }
  | { kind: 'open_tutor'; conceptId: string }
  | { kind: 'finish' };

export interface LoopDecision {
  next: LoopSnapshot;
  /** What the caller should do, in the order given. */
  effects: LoopEffect[];
  /** Plain-language reason, shown to the student. Auditability, not decoration. */
  reason: string;
}

export interface LoopPolicy {
  /**
   * Night Before takes ONE prerequisite hop then moves on; Mastery recurses
   * toward the root cause. With six hours left there is no time to fail
   * productively, and a deep repair costs the student every topic still
   * queued behind it.
   */
  maxPrerequisiteDepth: number;
  lessonDepth: 'cram' | 'full';
  /** Whether the reserve can absorb a hop of this size right now. */
  canAbsorbHop: (hopCostMin: number) => boolean;
  /** Estimated minutes to teach a concept, for the affordability check. */
  estimateCostMin: (conceptId: string) => number;
}

export function policyFor(
  mode: LearnMode,
  hooks: Pick<LoopPolicy, 'canAbsorbHop' | 'estimateCostMin'>,
): LoopPolicy {
  return mode === 'night_before'
    ? { maxPrerequisiteDepth: 1, lessonDepth: 'cram', ...hooks }
    : { maxPrerequisiteDepth: 4, lessonDepth: 'full', ...hooks };
}

/** The concept being worked on: top of the prerequisite stack, else the cursor. */
export function activeConceptId(snapshot: LoopSnapshot): string | null {
  const stack = snapshot.cursor.prerequisiteStack;
  if (stack.length > 0) return stack[stack.length - 1]!;
  return snapshot.plan.conceptIds[snapshot.cursor.index] ?? null;
}

function budgetExhausted(snapshot: LoopSnapshot): boolean {
  return snapshot.budgetMin !== null && snapshot.spentMin >= snapshot.budgetMin;
}

/**
 * Advances the machine. Pure: the same snapshot and the same event yield the
 * same decision, every time.
 */
export function advance(
  snapshot: LoopSnapshot,
  event: LoopEvent,
  policy: LoopPolicy,
): LoopDecision {
  const spend = (minutes: number): LoopSnapshot => ({
    ...snapshot,
    spentMin: snapshot.spentMin + minutes,
  });

  switch (event.type) {
    case 'START': {
      const conceptId = activeConceptId(snapshot);
      if (conceptId === null) {
        return {
          next: { ...snapshot, state: 'DONE' },
          effects: [{ kind: 'finish' }],
          reason: 'There is nothing left in the plan.',
        };
      }
      return {
        next: {
          ...snapshot,
          state: 'TEACH',
          cursor: { ...snapshot.cursor, currentConceptId: conceptId },
        },
        effects: [{ kind: 'serve_lesson', conceptId, depth: policy.lessonDepth }],
        reason: 'Starting with the highest-return concept in the plan.',
      };
    }

    case 'LESSON_SERVED': {
      return {
        next: { ...spend(event.minutesSpent), state: 'TEST' },
        effects: [{ kind: 'serve_test', conceptId: event.conceptId }],
        reason: 'Now a real past question on this concept, to confirm it landed.',
      };
    }

    case 'TEST_PASSED': {
      const afterTest = spend(event.minutesSpent);
      const stack = afterTest.cursor.prerequisiteStack;

      // Clearing a prerequisite returns to whatever needed it rather than
      // advancing: the concept that triggered the hop is still unlearned.
      if (stack.length > 0) {
        const remaining = stack.slice(0, -1);
        const returningTo =
          remaining[remaining.length - 1] ?? afterTest.plan.conceptIds[afterTest.cursor.index];
        return {
          next: {
            ...afterTest,
            state: 'TEACH',
            cursor: {
              ...afterTest.cursor,
              prerequisiteStack: remaining,
              currentConceptId: returningTo ?? null,
            },
          },
          effects: [
            { kind: 'record_mastery', conceptId: event.conceptId, passed: true },
            ...(returningTo
              ? [
                  {
                    kind: 'serve_lesson' as const,
                    conceptId: returningTo,
                    depth: policy.lessonDepth,
                  },
                ]
              : [{ kind: 'finish' as const }]),
          ],
          reason: 'Prerequisite cleared. Back to the concept that needed it.',
        };
      }

      const nextIndex = afterTest.cursor.index + 1;
      const nextConceptId = afterTest.plan.conceptIds[nextIndex];

      if (nextConceptId === undefined) {
        return {
          next: {
            ...afterTest,
            state: 'DONE',
            cursor: { ...afterTest.cursor, index: nextIndex, currentConceptId: null },
          },
          effects: [
            { kind: 'record_mastery', conceptId: event.conceptId, passed: true },
            { kind: 'finish' },
          ],
          reason: 'That was the last concept in the plan.',
        };
      }

      if (budgetExhausted(afterTest)) {
        return {
          next: { ...afterTest, state: 'DONE' },
          effects: [
            { kind: 'record_mastery', conceptId: event.conceptId, passed: true },
            { kind: 'finish' },
          ],
          reason: 'Time is up. Stopping rather than starting something unfinishable.',
        };
      }

      return {
        next: {
          ...afterTest,
          state: 'TEACH',
          cursor: { ...afterTest.cursor, index: nextIndex, currentConceptId: nextConceptId },
        },
        effects: [
          { kind: 'record_mastery', conceptId: event.conceptId, passed: true },
          { kind: 'serve_lesson', conceptId: nextConceptId, depth: policy.lessonDepth },
        ],
        reason: 'Passed. Moving to the next concept by return on time.',
      };
    }

    case 'TEST_FAILED': {
      const afterTest = spend(event.minutesSpent);
      const stack = afterTest.cursor.prerequisiteStack;
      const target = event.missedPrerequisiteIds[0];

      const alreadyDeep = stack.length >= policy.maxPrerequisiteDepth;
      const cycles = target !== undefined && stack.includes(target);
      const affordable =
        target !== undefined && policy.canAbsorbHop(policy.estimateCostMin(target));

      // A hop is taken only when there is somewhere to go, the policy allows
      // the depth, the reserve can FINISH it, and it does not loop. An
      // abandoned repair costs the student the original topic as well as the
      // prerequisite, which is worse than never starting it.
      if (target !== undefined && !alreadyDeep && affordable && !cycles) {
        return {
          next: {
            ...afterTest,
            state: 'TEACH',
            cursor: {
              ...afterTest.cursor,
              prerequisiteStack: [...stack, target],
              currentConceptId: target,
            },
          },
          effects: [
            { kind: 'record_mastery', conceptId: event.conceptId, passed: false },
            { kind: 'serve_lesson', conceptId: target, depth: policy.lessonDepth },
          ],
          reason: 'That answer missed a prerequisite. Teaching it first, then coming back.',
        };
      }

      const why = cycles
        ? 'That prerequisite was already covered in this session.'
        : alreadyDeep
          ? 'Not going deeper; there is not time to finish the chain.'
          : target === undefined
            ? 'No prerequisite explains the gap.'
            : 'Not enough reserve time to finish that repair.';

      const nextIndex = afterTest.cursor.index + 1;
      const nextConceptId = afterTest.plan.conceptIds[nextIndex];

      if (nextConceptId === undefined || budgetExhausted(afterTest)) {
        return {
          next: {
            ...afterTest,
            state: 'DONE',
            cursor: { ...afterTest.cursor, index: nextIndex, prerequisiteStack: [] },
          },
          effects: [
            { kind: 'record_mastery', conceptId: event.conceptId, passed: false },
            { kind: 'finish' },
          ],
          reason: `${why} Nothing further fits in the time left.`,
        };
      }

      return {
        next: {
          ...afterTest,
          state: 'TEACH',
          cursor: {
            ...afterTest.cursor,
            index: nextIndex,
            prerequisiteStack: [],
            currentConceptId: nextConceptId,
          },
        },
        effects: [
          { kind: 'record_mastery', conceptId: event.conceptId, passed: false },
          { kind: 'serve_lesson', conceptId: nextConceptId, depth: policy.lessonDepth },
        ],
        reason: `${why} Moving to the next concept.`,
      };
    }

    case 'ESCALATE': {
      const conceptId = activeConceptId(snapshot);
      if (conceptId === null) {
        return {
          next: { ...snapshot, state: 'DONE' },
          effects: [{ kind: 'finish' }],
          reason: 'Nothing is being studied, so there is nothing to escalate.',
        };
      }
      // Tier 1 (the cached lesson) failed to land, so this is the jump to
      // Tier 2 -- the only tier that spends per-student tokens. Logging it
      // feeds concept_stats.escalation_rate, which corrects study cost,
      // which sharpens ROI for every future student.
      return {
        next: { ...snapshot, state: 'STUCK' },
        effects: [
          { kind: 'log_escalation', conceptId, fromTier: 1, toTier: 2 },
          { kind: 'open_tutor', conceptId },
        ],
        reason: 'The lesson did not land, so the tutor takes over from here.',
      };
    }

    case 'TUTOR_RESOLVED': {
      const conceptId = activeConceptId(snapshot);
      if (conceptId === null) {
        return {
          next: { ...snapshot, state: 'DONE' },
          effects: [{ kind: 'finish' }],
          reason: 'Nothing left to return to.',
        };
      }
      return {
        next: { ...snapshot, state: 'TEST' },
        effects: [{ kind: 'serve_test', conceptId }],
        reason: 'Back from the tutor. Confirming it landed with a real question.',
      };
    }

    case 'ABANDON_CONCEPT': {
      const nextIndex = snapshot.cursor.index + 1;
      const nextConceptId = snapshot.plan.conceptIds[nextIndex];
      if (nextConceptId === undefined) {
        return {
          next: {
            ...snapshot,
            state: 'DONE',
            cursor: { ...snapshot.cursor, index: nextIndex, prerequisiteStack: [] },
          },
          effects: [{ kind: 'finish' }],
          reason: 'Skipped, and that was the last concept.',
        };
      }
      return {
        next: {
          ...snapshot,
          state: 'TEACH',
          cursor: {
            ...snapshot.cursor,
            index: nextIndex,
            prerequisiteStack: [],
            currentConceptId: nextConceptId,
          },
        },
        effects: [{ kind: 'serve_lesson', conceptId: nextConceptId, depth: policy.lessonDepth }],
        reason: 'Skipped at your request. Moving on.',
      };
    }
  }
}
