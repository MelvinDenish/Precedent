import { describe, expect, it } from 'vitest';
import { areOrAlternatives, canMerge, findBlockingOrPair } from './or-rule.js';

/**
 * Both failure directions are asserted here because both are SILENT.
 * See docs/ARCHITECTURE.md section 2.3 and docs/EVALUATION.md section 4.2.
 */
describe('the OR rule', () => {
  describe('the under-strict failure: alternatives must NOT merge', () => {
    it('refuses two questions sharing a paper and an or_group', () => {
      // 2024 paper, Q11(a) OR Q11(b). A student answers one, never both.
      const a = { paperId: 'p2024', orGroupId: 11 };
      const b = { paperId: 'p2024', orGroupId: 11 };

      expect(areOrAlternatives(a, b)).toBe(true);
      expect(canMerge(a, b)).toBe(false);
    });

    it('refuses even when the wording is near-identical', () => {
      // The dangerous case: embeddings say "merge", the rule says no.
      const a = { paperId: 'p2024', orGroupId: 13 };
      const b = { paperId: 'p2024', orGroupId: 13 };
      expect(canMerge(a, b)).toBe(false);
    });

    it('blocks a cluster merge when any member pair are alternatives', () => {
      const left = [
        { paperId: 'p2021', orGroupId: 11 },
        { paperId: 'p2024', orGroupId: 12 },
      ];
      const right = [
        { paperId: 'p2022', orGroupId: 14 },
        { paperId: 'p2024', orGroupId: 12 }, // collides with left[1]
      ];

      const blocking = findBlockingOrPair(left, right);
      expect(blocking).not.toBeNull();
      expect(blocking?.left.paperId).toBe('p2024');
      expect(blocking?.right.orGroupId).toBe(12);
    });
  });

  describe('the over-strict failure: cross-year OR-slot pairs MUST merge', () => {
    /**
     * This is the case the naive rule ("never merge questions sharing an
     * or_group") breaks, and it breaks it with no error raised anywhere.
     * 2023 Q11(a) and 2024 Q13(b) are the same question sitting in different
     * OR-slots in different years -- exactly the cross-year recurrence the
     * product exists to find. Suppressing it DEFLATES every count.
     */
    it('permits 2023 Q11(a) and 2024 Q13(b) to merge', () => {
      const q2023 = { paperId: 'p2023', orGroupId: 11 };
      const q2024 = { paperId: 'p2024', orGroupId: 13 };

      expect(areOrAlternatives(q2023, q2024)).toBe(false);
      expect(canMerge(q2023, q2024)).toBe(true);
    });

    it('permits merging when the or_group id COINCIDES across papers', () => {
      // The specific trap: same or_group_id, different paper. or_group_id is
      // scoped per-paper, so an id-only check would wrongly block this.
      const q2023 = { paperId: 'p2023', orGroupId: 11 };
      const q2024 = { paperId: 'p2024', orGroupId: 11 };

      expect(areOrAlternatives(q2023, q2024)).toBe(false);
      expect(canMerge(q2023, q2024)).toBe(true);
    });

    it('allows a cluster merge when no pair shares both paper and or_group', () => {
      const left = [
        { paperId: 'p2021', orGroupId: 11 },
        { paperId: 'p2023', orGroupId: 11 },
      ];
      const right = [
        { paperId: 'p2024', orGroupId: 11 },
        { paperId: 'p2025', orGroupId: 13 },
      ];

      expect(findBlockingOrPair(left, right)).toBeNull();
    });
  });

  describe('questions with no choice offered', () => {
    it('treats a null or_group as never an alternative', () => {
      // All of PART-A and PART-C are compulsory: no choice, so no alternatives.
      const a = { paperId: 'p2024', orGroupId: null };
      const b = { paperId: 'p2024', orGroupId: null };

      expect(areOrAlternatives(a, b)).toBe(false);
      expect(canMerge(a, b)).toBe(true);
    });

    it('does not pair a null or_group against a real one', () => {
      const a = { paperId: 'p2024', orGroupId: null };
      const b = { paperId: 'p2024', orGroupId: 11 };
      expect(canMerge(a, b)).toBe(true);
    });
  });

  describe('symmetry', () => {
    it('gives the same answer whichever way round the pair is passed', () => {
      const pairs = [
        [{ paperId: 'p1', orGroupId: 11 }, { paperId: 'p1', orGroupId: 11 }],
        [{ paperId: 'p1', orGroupId: 11 }, { paperId: 'p2', orGroupId: 11 }],
        [{ paperId: 'p1', orGroupId: null }, { paperId: 'p1', orGroupId: 11 }],
      ] as const;

      for (const [a, b] of pairs) {
        expect(areOrAlternatives(a, b)).toBe(areOrAlternatives(b, a));
      }
    });
  });
});
