import type { LearnMode } from '@precedent/shared';
import { describe, expect, it } from 'vitest';
import { type LoopSnapshot, activeConceptId, advance, policyFor } from './loop.js';

function snapshot(overrides: Partial<LoopSnapshot> = {}): LoopSnapshot {
  return {
    mode: 'night_before',
    state: 'SELECT',
    plan: {
      conceptIds: ['c1', 'c2', 'c3'],
      unitCoverage: { '1': 30, '2': 30 },
      reserveMin: 60,
      expectedMarksTotal: 42,
    },
    cursor: { index: 0, prerequisiteStack: [], currentConceptId: null, currentClusterId: null },
    spentMin: 0,
    budgetMin: 360,
    ...overrides,
  };
}

/** Default policy: hops are affordable and cost 20 minutes. */
function policy(mode: LearnMode = 'night_before', canAbsorb = true) {
  return policyFor(mode, { canAbsorbHop: () => canAbsorb, estimateCostMin: () => 20 });
}

describe('the Learn Loop', () => {
  it('teaches before testing', () => {
    const decision = advance(snapshot(), { type: 'START' }, policy());
    expect(decision.next.state).toBe('TEACH');
    expect(decision.effects[0]).toEqual({ kind: 'serve_lesson', conceptId: 'c1', depth: 'cram' });
  });

  it('tests with a real question once the lesson is served', () => {
    const decision = advance(
      snapshot({ state: 'TEACH' }),
      { type: 'LESSON_SERVED', conceptId: 'c1', minutesSpent: 5 },
      policy(),
    );
    expect(decision.next.state).toBe('TEST');
    expect(decision.next.spentMin).toBe(5);
    expect(decision.effects).toContainEqual({ kind: 'serve_test', conceptId: 'c1' });
  });

  it('advances the cursor and records mastery on a pass', () => {
    const decision = advance(
      snapshot({ state: 'TEST' }),
      { type: 'TEST_PASSED', conceptId: 'c1', minutesSpent: 8 },
      policy(),
    );
    expect(decision.next.cursor.index).toBe(1);
    expect(decision.effects).toContainEqual({
      kind: 'record_mastery',
      conceptId: 'c1',
      passed: true,
    });
    expect(decision.effects).toContainEqual({
      kind: 'serve_lesson',
      conceptId: 'c2',
      depth: 'cram',
    });
  });

  it('finishes after the last concept', () => {
    const decision = advance(
      snapshot({
        state: 'TEST',
        cursor: { index: 2, prerequisiteStack: [], currentConceptId: 'c3', currentClusterId: null },
      }),
      { type: 'TEST_PASSED', conceptId: 'c3', minutesSpent: 8 },
      policy(),
    );
    expect(decision.next.state).toBe('DONE');
    expect(decision.effects).toContainEqual({ kind: 'finish' });
  });
});

describe('failing a test', () => {
  /**
   * The core repair behaviour: a failure routes to the prerequisite the
   * evaluator blamed, not back to the explanation that already failed once.
   */
  it('hops to the prerequisite the evaluator identified', () => {
    const decision = advance(
      snapshot({ state: 'TEST' }),
      {
        type: 'TEST_FAILED',
        conceptId: 'c1',
        minutesSpent: 6,
        missedPrerequisiteIds: ['functional-dependencies'],
      },
      policy(),
    );

    expect(decision.next.cursor.prerequisiteStack).toEqual(['functional-dependencies']);
    expect(decision.effects).toContainEqual({
      kind: 'serve_lesson',
      conceptId: 'functional-dependencies',
      depth: 'cram',
    });
    // The cursor has NOT advanced: c1 is still unlearned.
    expect(decision.next.cursor.index).toBe(0);
  });

  it('returns to the concept that needed the prerequisite once it is cleared', () => {
    const decision = advance(
      snapshot({
        state: 'TEST',
        cursor: { index: 0, prerequisiteStack: ['prereq'], currentConceptId: 'prereq', currentClusterId: null },
      }),
      { type: 'TEST_PASSED', conceptId: 'prereq', minutesSpent: 10 },
      policy(),
    );

    expect(decision.next.cursor.prerequisiteStack).toEqual([]);
    expect(decision.effects).toContainEqual({
      kind: 'serve_lesson',
      conceptId: 'c1',
      depth: 'cram',
    });
    expect(decision.next.cursor.index).toBe(0);
  });

  /**
   * Night Before takes ONE hop then moves on. With six hours left there is
   * no time to fail productively, and a deep repair costs the student every
   * topic still queued behind it.
   */
  it('takes only one hop in Night Before mode', () => {
    const decision = advance(
      snapshot({
        state: 'TEST',
        cursor: { index: 0, prerequisiteStack: ['prereq'], currentConceptId: 'prereq', currentClusterId: null },
      }),
      {
        type: 'TEST_FAILED',
        conceptId: 'prereq',
        minutesSpent: 6,
        missedPrerequisiteIds: ['deeper'],
      },
      policy('night_before'),
    );

    expect(decision.next.cursor.prerequisiteStack).toEqual([]);
    expect(decision.next.cursor.index).toBe(1);
    expect(decision.reason).toMatch(/not going deeper/i);
  });

  it('recurses further in Mastery mode, where there is time', () => {
    const decision = advance(
      snapshot({
        mode: 'mastery',
        state: 'TEST',
        budgetMin: null,
        cursor: { index: 0, prerequisiteStack: ['prereq'], currentConceptId: 'prereq', currentClusterId: null },
      }),
      {
        type: 'TEST_FAILED',
        conceptId: 'prereq',
        minutesSpent: 6,
        missedPrerequisiteIds: ['deeper'],
      },
      policy('mastery'),
    );

    expect(decision.next.cursor.prerequisiteStack).toEqual(['prereq', 'deeper']);
    expect(decision.effects).toContainEqual({
      kind: 'serve_lesson',
      conceptId: 'deeper',
      depth: 'full',
    });
  });

  /**
   * An abandoned repair costs the student the original topic as well as the
   * prerequisite, so a hop the reserve cannot finish is never started.
   */
  it('refuses a hop the reserve cannot finish, and says why', () => {
    const decision = advance(
      snapshot({ state: 'TEST' }),
      { type: 'TEST_FAILED', conceptId: 'c1', minutesSpent: 6, missedPrerequisiteIds: ['prereq'] },
      policy('night_before', false),
    );

    expect(decision.next.cursor.prerequisiteStack).toEqual([]);
    expect(decision.next.cursor.index).toBe(1);
    expect(decision.reason).toMatch(/reserve/i);
  });

  it('does not loop back to a prerequisite already covered this session', () => {
    const decision = advance(
      snapshot({
        mode: 'mastery',
        state: 'TEST',
        budgetMin: null,
        cursor: { index: 0, prerequisiteStack: ['a'], currentConceptId: 'a', currentClusterId: null },
      }),
      { type: 'TEST_FAILED', conceptId: 'a', minutesSpent: 6, missedPrerequisiteIds: ['a'] },
      policy('mastery'),
    );

    expect(decision.next.cursor.prerequisiteStack).not.toContain('a');
    expect(decision.reason).toMatch(/already covered/i);
  });

  it('moves on when no prerequisite explains the gap', () => {
    const decision = advance(
      snapshot({ state: 'TEST' }),
      { type: 'TEST_FAILED', conceptId: 'c1', minutesSpent: 6, missedPrerequisiteIds: [] },
      policy(),
    );
    expect(decision.next.cursor.index).toBe(1);
    expect(decision.reason).toMatch(/no prerequisite/i);
  });
});

describe('the escalation ladder', () => {
  /**
   * Tier 2 is the only tier that spends per-student tokens, so every jump to
   * it is logged. That feeds concept_stats.escalation_rate, which corrects
   * study cost, which sharpens ROI for every future student.
   */
  it('logs the escalation and opens the tutor', () => {
    const decision = advance(
      snapshot({
        state: 'TEACH',
        cursor: { index: 0, prerequisiteStack: [], currentConceptId: 'c1', currentClusterId: null },
      }),
      { type: 'ESCALATE' },
      policy(),
    );

    expect(decision.next.state).toBe('STUCK');
    expect(decision.effects).toContainEqual({
      kind: 'log_escalation',
      conceptId: 'c1',
      fromTier: 1,
      toTier: 2,
    });
    expect(decision.effects).toContainEqual({ kind: 'open_tutor', conceptId: 'c1' });
  });

  it('escalates the prerequisite being studied, not the concept behind it', () => {
    const decision = advance(
      snapshot({
        state: 'TEACH',
        cursor: { index: 0, prerequisiteStack: ['prereq'], currentConceptId: 'prereq', currentClusterId: null },
      }),
      { type: 'ESCALATE' },
      policy(),
    );
    expect(decision.effects).toContainEqual({
      kind: 'log_escalation',
      conceptId: 'prereq',
      fromTier: 1,
      toTier: 2,
    });
  });

  it('tests rather than re-teaching when the tutor is done', () => {
    const decision = advance(
      snapshot({
        state: 'STUCK',
        cursor: { index: 0, prerequisiteStack: [], currentConceptId: 'c1', currentClusterId: null },
      }),
      { type: 'TUTOR_RESOLVED' },
      policy(),
    );
    expect(decision.next.state).toBe('TEST');
    expect(decision.effects).toContainEqual({ kind: 'serve_test', conceptId: 'c1' });
  });
});

describe('the time budget', () => {
  it('stops rather than starting something it cannot finish', () => {
    const decision = advance(
      snapshot({ state: 'TEST', spentMin: 358, budgetMin: 360 }),
      { type: 'TEST_PASSED', conceptId: 'c1', minutesSpent: 5 },
      policy(),
    );
    expect(decision.next.state).toBe('DONE');
    expect(decision.reason).toMatch(/time is up/i);
  });

  it('runs without a budget in Mastery mode', () => {
    const decision = advance(
      snapshot({ mode: 'mastery', state: 'TEST', budgetMin: null, spentMin: 5000 }),
      { type: 'TEST_PASSED', conceptId: 'c1', minutesSpent: 10 },
      policy('mastery'),
    );
    expect(decision.next.state).toBe('TEACH');
  });
});

describe('resumability', () => {
  /**
   * A student closes the tab at 2am and comes back. Because the transition
   * is a pure function of the persisted snapshot, replaying from that
   * snapshot continues at exactly the same cursor and prerequisite stack.
   */
  it('resumes from a persisted snapshot at the identical position', () => {
    const midSession = snapshot({
      state: 'TEACH',
      spentMin: 95,
      cursor: { index: 1, prerequisiteStack: ['prereq'], currentConceptId: 'prereq', currentClusterId: null },
    });

    // Round-trip through JSON, exactly as learn_sessions stores it.
    const restored = JSON.parse(JSON.stringify(midSession)) as LoopSnapshot;
    const event = { type: 'LESSON_SERVED' as const, conceptId: 'prereq', minutesSpent: 4 };

    expect(activeConceptId(restored)).toBe('prereq');
    expect(advance(restored, event, policy())).toEqual(advance(midSession, event, policy()));
  });

  it('is deterministic: the same snapshot and event always decide the same way', () => {
    const state = snapshot({ state: 'TEST' });
    const event = {
      type: 'TEST_FAILED' as const,
      conceptId: 'c1',
      minutesSpent: 6,
      missedPrerequisiteIds: ['p1', 'p2'],
    };
    expect(advance(state, event, policy())).toEqual(advance(state, event, policy()));
  });

  it('never mutates the snapshot it was given', () => {
    const before = snapshot({ state: 'TEST' });
    const frozen = JSON.parse(JSON.stringify(before)) as LoopSnapshot;
    advance(before, { type: 'TEST_PASSED', conceptId: 'c1', minutesSpent: 9 }, policy());
    expect(before).toEqual(frozen);
  });
});

describe('every transition explains itself', () => {
  /**
   * Auditability is a stated requirement, not a nicety: the student has to
   * be able to see why they were sent to a prerequisite.
   */
  it('returns a non-empty reason and at least one effect for every event', () => {
    const events = [
      { type: 'START' as const },
      { type: 'LESSON_SERVED' as const, conceptId: 'c1', minutesSpent: 5 },
      { type: 'TEST_PASSED' as const, conceptId: 'c1', minutesSpent: 5 },
      {
        type: 'TEST_FAILED' as const,
        conceptId: 'c1',
        minutesSpent: 5,
        missedPrerequisiteIds: ['p'],
      },
      { type: 'ESCALATE' as const },
      { type: 'TUTOR_RESOLVED' as const },
      { type: 'ABANDON_CONCEPT' as const },
    ];

    for (const event of events) {
      const decision = advance(
        snapshot({ cursor: { index: 0, prerequisiteStack: [], currentConceptId: 'c1', currentClusterId: null } }),
        event,
        policy(),
      );
      expect(decision.reason.length).toBeGreaterThan(10);
      expect(decision.effects.length).toBeGreaterThan(0);
    }
  });
});
