import { describe, expect, it } from 'vitest';
import { assessTextQuality } from './segmentation.js';

/**
 * Calibrated against the real 31-paper seed corpus. The strings below are
 * verbatim excerpts, which is the point: 19 of 31 papers have no text layer
 * and one has a text layer that is worse than none.
 */
describe('the text quality gate', () => {
  it('rejects an empty text layer', () => {
    const result = assessTextQuality('');
    expect(result.usable).toBe(false);
    expect(result.reason).toMatch(/empty/);
  });

  it('rejects the few stray characters a scanned PDF yields', () => {
    // Typical of the 19 image-only papers: pdftotext returns 1-10 chars.
    expect(assessTextQuality('\f\n \n').usable).toBe(false);
  });

  it('rejects text too short to segment even when clean', () => {
    expect(assessTextQuality('What is a semaphore?').usable).toBe(false);
  });

  it('accepts a clean extraction', () => {
    // Modelled on OS-Endsem-RT, which extracts cleanly.
    const clean = `
      Time: 3 Hours    Answer ALL Questions    Max. Marks: 100
      PART- A (10 x 2 = 20 Marks)
      Q.No    Questions    Marks
      1. What are system calls? 2
      2. What is context switch? 2
      3. Why is multi threading needed? Justify. 2
      4. Differentiate sequential and direct access. 2
      5. Is FCFS scheduling suitable for a time sharing environment? 2
      6. Differentiate hit and miss. 2
      7. What is compaction? 2
      8. Define thrashing. 2
      9. Differentiate waiting time and response time. 2
      10. What is the purpose of a translation lookaside buffer? 2
      PART- B (5 x 13 = 65 Marks)
      11 (a) Explain the services provided by an operating system to the user. 13
      OR
      11 (b) Discuss how interprocess communication can be achieved. 13
    `.repeat(2);

    const result = assessTextQuality(clean);
    expect(result.usable).toBe(true);
    expect(result.score).toBeGreaterThan(0.7);
  });

  /**
   * THE CASE THAT MOTIVATES THE GATE.
   *
   * Verbatim from TOC-R2023-EndSem-25S5.pdf, which carries ~5,800 characters
   * of text layer. An emptiness check passes it, and it then poisons every
   * embedding and cluster computed from it. Note "uest1ons", "ambiquous
   * qrammar", "activitv", and the header noise.
   */
  it('rejects a dirty OCR text layer that an emptiness check would accept', () => {
    const dirty = `
      _/:.:;?~~}~!~:~:>.-      Roll. No.    IIIIIIIIIII
      J \/:- \\ (~( _I{ ,.. "C...I~ !-':  r> \  ,  \
      --~~--~~tS\-~B.E. / B. Tech/ B. Arch (Full Time)  END SEMESTER
      PART - A 10 x 2 = 20 Marks
      Answer a uest1ons
      '1,/ Create a FA which accepts the only input 101 over the input set
      a/ Define ambiquous qrammar and CFG.
      ,5/' Conclude the two different ways to define PDA acceptabilitv.
      7 l--tllustrate the basic difference between 2-wav FA and TM.
      cos Prove the undecidability of Recursively Enumerable Languages.
    `.repeat(3);

    const result = assessTextQuality(dirty);
    expect(result.usable).toBe(false);
    expect(result.reason).toMatch(/punctuation noise|common English/);
  });

  it('does not punish layout padding in a correctly extracted table', () => {
    // Layout-preserving extraction pads table columns with long runs of
    // spaces. Measuring the alphabetic ratio against total length rather
    // than against non-whitespace length would fail this paper, and it is
    // the format most of the readable corpus papers arrive in.
    const padded = `
      ANNA UNIVERSITY (UNIVERSITY DEPARTMENTS)
      B.E. / B.Tech (Full Time) END SEMESTER EXAMINATIONS, NOV/DEC 2025
      Time: 3 Hours                                      Max. Marks: 100
      Answer ALL Questions from Part A and one from each pair in Part B.

      Q.No.                          Questions                     Marks  CO  BL
      1.     What are system calls and why does a process need them?   2   1   2
      2.     What is a context switch and when does it occur?          2   1   2
      3.     Why is multi threading needed in an operating system?     2   2   3
      4.     Differentiate sequential access from direct access.       2   3   2
      5.     Is FCFS scheduling suitable for a time sharing system?    2   2   4

      PART- B (5 x 13 = 65 Marks)
      (Restrict to a maximum of 2 subdivisions)

      11 (a)  Explain in detail the services that are provided by an
              operating system to the user and to the programs which
              run on it, and describe how each of these services is
              reached from user space.                               13   1   2
      OR
      11 (b)  Discuss the ways in which interprocess communication
              can be achieved between two processes that do not
              share an address space, with an example of each.       13   2   2
    `;

    expect(assessTextQuality(padded).usable).toBe(true);
  });
});
