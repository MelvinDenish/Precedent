import { describe, expect, it } from 'vitest';
import { filenameHints } from './seed.js';

/**
 * Every filename below is real, taken from the seed corpus.
 *
 * These hints exist only as a fallback for when header parsing yields
 * nothing. The corpus is the reason for that caution: filenames here lie
 * both by omission and by content.
 */
describe('filename hints', () => {
  it('reads a year encoded as the sitting code', () => {
    // "22S5" is semester 5 of the 2022 sitting.
    expect(filenameHints('CN-CEG-22S5-QP.pdf').examYear).toBe(2022);
    expect(filenameHints('CN-Endsem-24S5.pdf').examYear).toBe(2024);
  });

  it('returns no year when the filename carries none', () => {
    // Roughly a third of the corpus. The header is the only source for these.
    expect(filenameHints('OS-Endsem-BT.pdf').examYear).toBeNull();
    expect(filenameHints('TOC-Endsem-OT.pdf').examYear).toBeNull();
  });

  it('distinguishes the exam types that must not share a marks band', () => {
    // A quiz MCQ and a 13-mark end-semester question in one band would
    // corrupt every recurrence statistic computed from them.
    expect(filenameHints('CN-Quiz-MIT.pdf').examType).toBe('quiz');
    expect(filenameHints('OS-R2023-EndSem-25S5.pdf').examType).toBe('endsem');
    expect(filenameHints('OS-R2023-Assess-25S5.pdf').examType).toBe('assessment');
    expect(filenameHints('OS-R2023-Supplementary-25.pdf').examType).toBe('supplementary');
    expect(filenameHints('TOC-Endsem-GT(ReTest).pdf').examType).toBe('retest');
  });

  it('prefers the more specific type when a filename carries two', () => {
    // "Endsem" and "ReTest" both appear; a retest is the narrower claim.
    expect(filenameHints('TOC-Endsem-GT(ReTest).pdf').examType).toBe('retest');
    expect(filenameHints('CN-Endsem-20S5(ReTest).pdf').examType).toBe('retest');
  });

  it('picks up a college-set paper', () => {
    expect(filenameHints('CN-CEG-21S5-QP.pdf').college).toBe('CEG');
    expect(filenameHints('OS-MIT-BT-QP.pdf').college).toBe('MIT');
  });

  it('leaves college null for a centrally-set paper', () => {
    // NULL means centrally set, which is the default statistics slice.
    expect(filenameHints('OS-R2023-EndSem-25S5.pdf').college).toBeNull();
    expect(filenameHints('CN-Endsem-23S5.pdf').college).toBeNull();
  });

  it('reads the paper set letter', () => {
    expect(filenameHints('OS-CEG-BT-QP.pdf').paperSet).toBe('BT');
    expect(filenameHints('TOC-Endsem-RT.pdf').paperSet).toBe('RT');
    expect(filenameHints('TOC-Endsem-OT.pdf').paperSet).toBe('OT');
  });

  it('does not mistake a paper set letter for a year', () => {
    const hints = filenameHints('OS-MIT-BT-QP.pdf');
    expect(hints.paperSet).toBe('BT');
    expect(hints.examYear).toBeNull();
  });
});
