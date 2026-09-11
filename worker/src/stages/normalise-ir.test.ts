import { describe, expect, it } from 'vitest';
import type { SegmentedQuestion } from '@precedent/shared';
import {
  normaliseCollege,
  normaliseRegulation,
  normaliseSubjectCode,
  obtainableMarks,
  splitQuestionNumber,
} from './normalise-ir.js';

/**
 * Every case below is a quirk actually observed in Gemini vision output when
 * probing OS-R2023-EndSem-25S5.pdf, a paper with no text layer at all.
 * They are regressions, not hypotheticals.
 */
describe('normalising raw vision output', () => {
  describe('question numbering', () => {
    it('splits the compound number the model returns', () => {
      // Observed: qNumber "11(a)", partLabel "(a)" -- duplicated, and matching
      // neither schema column.
      expect(splitQuestionNumber('11(a)', '(a)')).toEqual({ qNumber: '11', partLabel: 'a' });
    });

    it('flattens a nested sub-part', () => {
      expect(splitQuestionNumber('12(a)(i)', '(a)(i)')).toEqual({
        qNumber: '12',
        partLabel: 'a-i',
      });
    });

    it('leaves a compulsory question without a part label', () => {
      expect(splitQuestionNumber('1', null)).toEqual({ qNumber: '1', partLabel: null });
    });

    it('handles a clean split the digital path already produces', () => {
      expect(splitQuestionNumber('13', 'b')).toEqual({ qNumber: '13', partLabel: 'b' });
    });
  });

  describe('college', () => {
    /**
     * NULL means centrally set, which is the default statistics slice. The
     * model names the university here; left alone, every centrally-set paper
     * would be filtered OUT of its own default slice.
     */
    it('maps the university department name to null', () => {
      expect(normaliseCollege('ANNA UNIVERSITY (UNIVERSITY DEPARTMENTS)')).toBeNull();
    });

    it('keeps a genuinely college-set paper', () => {
      expect(normaliseCollege('College of Engineering Guindy (CEG)')).toBe('CEG');
      expect(normaliseCollege('MIT Campus')).toBe('MIT');
    });

    it('treats an unrecognised institution as centrally set rather than guessing', () => {
      expect(normaliseCollege('Some Other College')).toBeNull();
      expect(normaliseCollege(null)).toBeNull();
    });
  });

  describe('codes', () => {
    it('prefixes the regulation year', () => {
      expect(normaliseRegulation('2023')).toBe('R2023');
      expect(normaliseRegulation('Regulation 2018')).toBe('R2018');
    });

    it('closes the space the model inserts into the subject code', () => {
      expect(normaliseSubjectCode('CS 23501')).toBe('CS23501');
      expect(normaliseSubjectCode('CS23502')).toBe('CS23502');
    });

    it('rejects a code that is not one', () => {
      expect(normaliseSubjectCode('Operating Systems')).toBeNull();
    });
  });

  describe('obtainable marks', () => {
    const q = (
      part: 'A' | 'B' | 'C',
      qNumber: string,
      marks: number,
      orGroupId: number | null,
    ): SegmentedQuestion => ({
      part, qNumber, partLabel: null, text: 't', marks, orGroupId,
      coCode: 1, blLevel: 1, pageNo: 1, confidence: 1,
    });

    /**
     * The probe returned PART-B totalling 130 marks across 15 questions,
     * because both sides of every OR pair are emitted -- correctly, since
     * both are evidence of what gets examined. But a student answers one
     * side, so the part is worth 65.
     *
     * Using the printed total would weight every OR-paired unit at roughly
     * double its true value, and the Night Before optimizer would over-invest
     * in whichever unit happens to offer the most choice.
     */
    it('counts an OR pair once, not twice', () => {
      const partB = [q('B', '11', 13, 11), q('B', '11', 13, 11)];
      expect(obtainableMarks(partB)).toBe(13);
    });

    it('halves a whole OR-paired part correctly', () => {
      const partB = [11, 12, 13, 14, 15].flatMap((n) => [q('B', String(n), 13, n), q('B', String(n), 13, n)]);
      expect(obtainableMarks(partB)).toBe(65);
    });

    it('counts sub-parts within one alternative in full', () => {
      // 12(a)(i)=5 + 12(a)(ii)=8 OR 12(b)(i)=5 + 12(b)(ii)=8  ->  13 obtainable
      const group = [q('B', '12', 5, 12), q('B', '12', 8, 12), q('B', '12', 5, 12), q('B', '12', 8, 12)];
      expect(obtainableMarks(group)).toBe(13);
    });

    it('counts compulsory questions in full', () => {
      const partA = Array.from({ length: 10 }, (_, i) => q('A', String(i + 1), 2, null));
      expect(obtainableMarks(partA)).toBe(20);
    });

    it('totals a whole R2023 paper to 100', () => {
      const partA = Array.from({ length: 10 }, (_, i) => q('A', String(i + 1), 2, null));
      const partB = [11, 12, 13, 14, 15].flatMap((n) => [q('B', String(n), 13, n), q('B', String(n), 13, n)]);
      const partC = [q('C', '16', 15, null)];
      expect(obtainableMarks([...partA, ...partB, ...partC])).toBe(100);
    });
  });
});
