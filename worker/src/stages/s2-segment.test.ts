import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { segmentationResultSchema } from '@precedent/shared';
import type { SegmentationResult, SegmentedQuestion } from '@precedent/shared';
import { areOrAlternatives, canMerge } from '@precedent/shared';
import { parseLayoutFixture } from '../testing/fixture-layout.js';
import { buildLayout } from '../pdf/reading-order.js';
import { extractFromPages } from './s1-extract.js';
import { parsePartHeader, runSegmentation, segment, segmentRules, stripTrailingMarks } from './s2-segment.js';
import { parseFilenameHints, parseHeaderMetadata } from './header-metadata.js';
import { MockProvider } from '../llm/mock.js';

const FIXTURES = join(process.cwd(), 'tests', 'fixtures');

function loadLayout(name: string) {
  return buildLayout(parseLayoutFixture(readFileSync(join(FIXTURES, name), 'utf8')));
}

/**
 * The fixture is modelled on the real R2023 template, with the geometric
 * hazards the corpus actually contains reproduced: a question number in a
 * smaller font on its own baseline, a question with no number glyph at
 * all, and a table that sits in a different place on page 2 than page 1.
 */
function segmentR2023(): SegmentationResult {
  return segmentRules({
    paperId: 'fixture-r2023',
    layout: loadLayout('r2023-endsem.layout.txt'),
    // Deliberately contradicts the header on every field it can.
    hints: parseFilenameHints('OS-CEG-22S5-RT-QP.pdf'),
  });
}

function find(result: SegmentationResult, qNumber: string, partLabel: string | null) {
  return result.questions.filter((q) => q.qNumber === qNumber && q.partLabel === partLabel);
}

describe('S2 rule segmentation of the R2023 template', () => {
  const result = segmentR2023();

  it('produces the frozen IR, so the digital path validates like the vision path', () => {
    const parsed = segmentationResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    expect(result.method).toBe('rules');
  });

  describe('the OR rule', () => {
    /**
     * THE load-bearing assertion of this file. docs/ARCHITECTURE.md 2.3:
     * merging alternatives inflates every recurrence count, and the
     * inverse -- an OR pair emitted as one question -- loses one of the
     * two outright. Both fail silently.
     */
    it('emits 11(a) and 11(b) as SEPARATE questions', () => {
      const eleven = result.questions.filter((q) => q.qNumber === '11');
      const labels = eleven.map((q) => q.partLabel);
      expect(labels).toContain('a');
      // 11(b) is subdivided into (i) and (ii), so its leaves carry the
      // nested label rather than a bare "b".
      expect(labels.some((l) => l?.startsWith('b'))).toBe(true);
      expect(eleven.length).toBeGreaterThanOrEqual(2);

      const a = find(result, '11', 'a')[0];
      expect(a?.text).toMatch(/Define a process/);
      // (a) and (b) must not have been fused into one text blob.
      expect(a?.text).not.toMatch(/Explain the services/);
    });

    it('gives both alternatives the SAME per-paper orGroupId, equal to 11', () => {
      const eleven = result.questions.filter((q) => q.qNumber === '11');
      expect(eleven.length).toBeGreaterThan(1);
      for (const q of eleven) expect(q.orGroupId).toBe(11);
    });

    it('makes the shared merge guard refuse to merge them', () => {
      const a = find(result, '11', 'a')[0];
      const b = result.questions.find((q) => q.qNumber === '11' && q.partLabel?.startsWith('b'));
      expect(a && b).toBeTruthy();
      const left = { paperId: 'fixture-r2023', orGroupId: a?.orGroupId ?? null };
      const right = { paperId: 'fixture-r2023', orGroupId: b?.orGroupId ?? null };
      expect(areOrAlternatives(left, right)).toBe(true);
      expect(canMerge(left, right)).toBe(false);
    });

    /**
     * The over-strict failure, which is the dangerous one: the same
     * or_group in a DIFFERENT paper is exactly the cross-year merge the
     * product exists to find.
     */
    it('still allows the same or_group to merge across papers', () => {
      const a = find(result, '11', 'a')[0];
      expect(
        canMerge(
          { paperId: 'fixture-r2023', orGroupId: a?.orGroupId ?? null },
          { paperId: 'some-2024-paper', orGroupId: 11 },
        ),
      ).toBe(true);
    });

    it('leaves PART-A and PART-C questions with a null orGroupId', () => {
      const compulsory = result.questions.filter((q) => q.part === 'A' || q.part === 'C');
      expect(compulsory.length).toBeGreaterThan(0);
      for (const q of compulsory) expect(q.orGroupId).toBeNull();
    });
  });

  describe('marks', () => {
    /**
     * Mark bands drive answer depth and ROI weighting, so recovering only
     * the 13 total would be a silent quality loss on every subdivided
     * question in the corpus.
     */
    it('recovers sub-part marks individually as 5 and 8, not one 13', () => {
      const subParts = result.questions
        .filter((q) => q.qNumber === '11' && q.partLabel?.startsWith('b'))
        .map((q) => q.marks)
        .sort((x, y) => (x ?? 0) - (y ?? 0));
      expect(subParts).toEqual([5, 8]);
    });

    it('keeps the undivided alternative at its full 13', () => {
      expect(find(result, '11', 'a')[0]?.marks).toBe(13);
    });

    it('reads PART-A marks from the Marks column, not from the question text', () => {
      const partA = result.questions.filter((q) => q.part === 'A');
      expect(partA.length).toBeGreaterThanOrEqual(5);
      for (const q of partA) {
        expect(q.marks).toBe(2);
        expect(q.text).not.toMatch(/\bCO\d\b|\bL\d\b/);
      }
    });
  });

  describe('CO and BL', () => {
    it('captures the printed course outcome and Bloom level', () => {
      const first = find(result, '1', null)[0];
      expect(first?.coCode).toBe(1);
      expect(first?.blLevel).toBe(2);
      expect(find(result, '16', null)[0]?.coCode).toBe(3);
      expect(find(result, '16', null)[0]?.blLevel).toBe(4);
    });

    /**
     * The table is NOT in the same place on page 2 as on page 1. A
     * document-wide band set learned from page 1 reads page 2's marks cell
     * as a course outcome -- and still validates, which is what makes it
     * dangerous.
     */
    it('reads the columns correctly on a page where the table has shifted', () => {
      const onPageTwo = find(result, '8', null)[0];
      expect(onPageTwo?.marks).toBe(2);
      expect(onPageTwo?.coCode).toBe(3);
      expect(onPageTwo?.blLevel).toBe(2);
    });
  });

  describe('parts', () => {
    it('assigns every question to the part it was printed under', () => {
      expect(find(result, '1', null)[0]?.part).toBe('A');
      expect(find(result, '10', null)[0]?.part).toBe('A');
      expect(find(result, '11', 'a')[0]?.part).toBe('B');
      expect(find(result, '16', null)[0]?.part).toBe('C');
    });

    it('recovers the template the Night Before optimizer consumes', () => {
      expect(result.template).not.toBeNull();
      expect(result.template?.totalMarks).toBe(100);
      expect(result.template?.parts.map((p) => `${p.part}${p.slotCount}x${p.marksPerSlot}`)).toEqual([
        'A10x2',
        'B5x13',
        'C1x15',
      ]);
      // Choice is read off the printed OR, never off the part letter.
      expect(result.template?.parts.find((p) => p.part === 'B')?.hasChoice).toBe(true);
      expect(result.template?.parts.find((p) => p.part === 'A')?.hasChoice).toBe(false);
      expect(result.template?.parts.find((p) => p.part === 'C')?.hasChoice).toBe(false);
    });
  });

  describe('rows whose number glyph did not survive extraction', () => {
    /**
     * Two of the eleven usable corpus papers are missing question-number
     * glyphs. Absorbed into their predecessor the questions vanish from
     * the corpus with no error raised anywhere.
     */
    it('recovers question 9 from its orphaned Marks/CO/BL cells', () => {
      const nine = find(result, '9', null)[0];
      expect(nine).toBeDefined();
      expect(nine?.text).toMatch(/sequential file access/);
      expect(nine?.marks).toBe(2);
      expect(nine?.coCode).toBe(5);
      // Flagged, not silently trusted: the review queue is what fixes it.
      expect(nine?.confidence).toBeLessThan(1);
      expect(result.warnings.some((w) => /no number glyph/.test(w))).toBe(true);
    });

    it('does not merge question 9 into question 8', () => {
      expect(find(result, '8', null)[0]?.text).not.toMatch(/sequential file access/);
    });
  });
});

describe('header metadata', () => {
  const result = segmentR2023();

  it('reads year, regulation and subject code from the HEADER', () => {
    expect(result.metadata.examYear).toBe(2025);
    expect(result.metadata.regulationCode).toBe('R2023');
    expect(result.metadata.subjectCode).toBe('CS23501');
    expect(result.metadata.examSession).toBe('nov-dec');
    expect(result.metadata.semester).toBe(5);
    expect(result.metadata.totalMarks).toBe(100);
  });

  /**
   * CN-CEG-22S5-QP.pdf sits in an R2023 subject folder and its header
   * reads "12th September 2022, CS6111, Regulation 2018". The filename is
   * a hint, and a frequently wrong one.
   */
  it('prefers the header over a contradicting filename, and says so', () => {
    // The fixture's filename hint claims 2022; the header says 2025.
    expect(result.metadata.examYear).toBe(2025);
    expect(result.warnings.some((w) => /filename suggests 2022.*header says 2025/.test(w))).toBe(
      true,
    );
  });

  it('keeps a centrally-set paper centrally set even when the filename names a college', () => {
    // "-CEG-" in the filename, no college in the header. NULL college is
    // the default statistics slice, so adopting the hint would move the
    // paper out of it.
    expect(result.metadata.college).toBeNull();
    expect(result.warnings.some((w) => /kept as centrally-set/.test(w))).toBe(true);
  });

  it('takes the paper set from the filename, which is the only place it appears', () => {
    expect(result.metadata.paperSet).toBe('RT');
  });

  it('does not mistake a month for a subject code', () => {
    // "NOV/DEC2025" matches the subject-code shape exactly.
    const parsed = parseHeaderMetadata(
      'B.E. END SEMESTER EXAMINATIONS, NOV/DEC 2025\nCS23501 Operating Systems\n(Regulation 2023)',
      undefined,
      null,
    );
    expect(parsed.metadata.subjectCode).toBe('CS23501');
  });

  it('reads an R2018 paper as R2018, not as the folder it is filed under', () => {
    const parsed = parseHeaderMetadata(
      'B.E /B.Tech (Full Time), 12th September 2022\nCS6111: Computer Networks\n(Regulation 2018)',
      parseFilenameHints('CN-CEG-22S5-QP.pdf'),
      null,
    );
    expect(parsed.metadata.regulationCode).toBe('R2018');
    expect(parsed.metadata.subjectCode).toBe('CS6111');
    expect(parsed.metadata.subjectName).toBe('Computer Networks');
    expect(parsed.metadata.examYear).toBe(2022);
  });
});

describe('part headers', () => {
  it('parses the clean R2023 forms', () => {
    expect(parsePartHeader('PART - A (10 x 2 = 20 Marks)')).toMatchObject({
      part: 'A',
      slotCount: 10,
      marksPerSlot: 2,
      total: 20,
    });
    expect(parsePartHeader('PART-B (5 x 13 = 65 Marks)')).toMatchObject({
      part: 'B',
      slotCount: 5,
      marksPerSlot: 13,
      total: 65,
    });
  });

  /**
   * Observed verbatim in CN-Endsem-23S5: the "=" did not survive
   * extraction, leaving "2 x 816". Read literally that is a 1632-mark
   * part. Only 8|16 satisfies 2 * 8 == 16.
   */
  it('recovers a part total whose "=" was lost', () => {
    expect(parsePartHeader('PART- C(2x816marks)')).toMatchObject({
      part: 'C',
      slotCount: 2,
      marksPerSlot: 8,
      total: 16,
      recovered: true,
    });
  });

  it('ignores a sentence that merely mentions a part', () => {
    expect(
      parsePartHeader(
        'Candidates should note that part marks are awarded only where the working is shown in full',
      ),
    ).toBeNull();
  });
});

describe('marks written into the question text', () => {
  // How the R2018 papers annotate marks, there being no Marks column.
  it('recovers and removes a trailing annotation', () => {
    expect(stripTrailingMarks('Show the TCP state transition diagram. (5)')).toEqual({
      text: 'Show the TCP state transition diagram.',
      marks: 5,
    });
    expect(stripTrailingMarks('Explain the DNS protocol. [8 marks]')).toEqual({
      text: 'Explain the DNS protocol.',
      marks: 8,
    });
  });

  it('leaves an ordinary parenthesis alone', () => {
    expect(stripTrailingMarks('Compare IPv4 and IPv6 (with examples)').marks).toBeNull();
  });
});

describe('multi-column reading order', () => {
  const layout = loadLayout('two-column.layout.txt');
  const page = layout.pages[0];

  it('detects the reading columns', () => {
    expect(page?.columnCount).toBe(2);
  });

  /**
   * The coordinate-sort pass is the thing under test here
   * (docs/EVALUATION.md 4.1). Sorted naively by y the two columns
   * interleave, and every sentence in the paper is corrupted.
   */
  it('reads down the left column before starting the right', () => {
    const text = layout.text;
    const leftStart = text.indexOf('The left column begins here');
    const leftEnd = text.indexOf('and ends on a third.');
    const rightStart = text.indexOf('The right column begins here');
    expect(leftStart).toBeGreaterThanOrEqual(0);
    expect(rightStart).toBeGreaterThan(leftEnd);

    // The naive failure mode, asserted directly: the two columns must not
    // alternate line by line.
    expect(text).toMatch(
      /The left column begins here\nand continues on a second line\nand ends on a third\./,
    );
  });

  it('keeps a heading that spans both columns above them', () => {
    const heading = layout.text.indexOf('A CENTRED HEADING');
    expect(heading).toBeGreaterThanOrEqual(0);
    expect(heading).toBeLessThan(layout.text.indexOf('The left column begins here'));
  });

  /**
   * The counter-case, and the reason the discriminators exist. The R2023
   * exam table is ALSO multi-column -- Q.No. | Questions | Marks | CO | BL
   * are separated by full-height whitespace channels. Splitting on them
   * emits every number, then every question, then every marks value as
   * three separate reading streams.
   */
  it('does NOT split the exam table into reading columns', () => {
    const paper = loadLayout('r2023-endsem.layout.txt');
    for (const p of paper.pages) expect(p.columnCount).toBe(1);
  });
});

describe('S1 routing', () => {
  it('routes a page with no text layer to vision', () => {
    const result = extractFromPages('scan', [{ pageNo: 1, width: 546, height: 792, items: [] }], null);
    expect(result.textSource).toBe('vision');
    expect(result.needsVision).toBe(true);
    expect(result.layout).toBeNull();
  });

  it('routes a usable text layer to the digital path', () => {
    const pages = parseLayoutFixture(
      readFileSync(join(FIXTURES, 'r2023-endsem.layout.txt'), 'utf8'),
    );
    const result = extractFromPages('fixture-r2023', pages, null);
    expect(result.textSource).toBe('digital');
    expect(result.needsVision).toBe(false);
  });

  /**
   * A non-empty text layer is NOT evidence of a usable one -- see
   * assessTextQuality's calibration note. It routes to vision, but it is
   * recorded as a different text_source because the two mean different
   * things to anyone reading the corpus later.
   */
  it('routes a dirty OCR layer to vision as dirty_ocr_recovered', () => {
    const junk = Array.from({ length: 120 }, (_, i) => ({
      str: i % 3 === 0 ? '_/:.:;?~~}~!~:~:>.-' : `w${i}rd~`,
      x: 60 + (i % 6) * 70,
      y: 700 - Math.floor(i / 6) * 12,
      width: 60,
      height: 10,
      fontName: 'f',
    }));
    const result = extractFromPages('dirty', [{ pageNo: 1, width: 546, height: 792, items: junk }], null);
    expect(result.textSource).toBe('dirty_ocr_recovered');
    expect(result.needsVision).toBe(true);
    // The bad text is kept, because it still orients a vision model.
    expect(result.layout).not.toBeNull();
  });
});

describe('the LLM layer', () => {
  const lowConfidenceInput = {
    paperId: 'garbage',
    layout: buildLayout([
      {
        pageNo: 1,
        width: 546,
        height: 792,
        items: [{ str: '1 x', x: 70, y: 700, width: 12, height: 10, fontName: 'f' }],
      },
    ]),
  };

  it('emits the identical IR shape from the mock vision path and the rule path', async () => {
    const provider = new MockProvider();
    const vision = await provider.segmentFromDocument({
      paperId: 'scan',
      pdfBytes: new Uint8Array([1, 2, 3]),
    });
    expect(vision.kind).toBe('ok');
    if (vision.kind !== 'ok') return;

    // Both paths must satisfy the same frozen schema...
    expect(segmentationResultSchema.safeParse(vision.value).success).toBe(true);
    const rules = segmentR2023();
    expect(segmentationResultSchema.safeParse(rules).success).toBe(true);
    // ...and expose the same keys, at the top level and per question.
    expect(Object.keys(vision.value).sort()).toEqual(Object.keys(rules).sort());
    const visionQuestion = vision.value.questions[0] as SegmentedQuestion;
    const ruleQuestion = rules.questions[0] as SegmentedQuestion;
    expect(Object.keys(visionQuestion).sort()).toEqual(Object.keys(ruleQuestion).sort());
  });

  it('preserves the OR pair and the 5 + 8 split through the vision path', async () => {
    const provider = new MockProvider();
    const outcome = await provider.segmentFromDocument({
      paperId: 'scan',
      pdfBytes: new Uint8Array([1]),
    });
    if (outcome.kind !== 'ok') throw new Error('expected ok');
    const eleven = outcome.value.questions.filter((q) => q.qNumber === '11');
    expect(eleven.length).toBe(3);
    for (const q of eleven) expect(q.orGroupId).toBe(11);
    expect(
      eleven
        .filter((q) => q.partLabel?.startsWith('b'))
        .map((q) => q.marks)
        .sort((a, b) => (a ?? 0) - (b ?? 0)),
    ).toEqual([5, 8]);
  });

  it('is deterministic: the same request twice gives byte-identical output', async () => {
    const provider = new MockProvider();
    const a = await provider.segmentFromDocument({ paperId: 'p', pdfBytes: new Uint8Array([1]) });
    const b = await provider.segmentFromDocument({ paperId: 'p', pdfBytes: new Uint8Array([1]) });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('calls the fallback only when the rules are not confident', async () => {
    const provider = new MockProvider();
    await segment({ paperId: 'fixture-r2023', layout: loadLayout('r2023-endsem.layout.txt') }, {
      provider,
    });
    expect(provider.callCount).toBe(0);

    await segment(lowConfidenceInput, { provider });
    expect(provider.callCount).toBe(1);
  });

  /**
   * EVALUATION.md section 5: exhausting the provider quota must defer and
   * retry, not fail the paper permanently. Deferral is a VALUE here, not a
   * thrown error, so the caller can read the backoff off it.
   */
  it('keeps the rule result when the provider defers, rather than failing the paper', async () => {
    const provider = new MockProvider({ deferAfter: 0 });
    const result = await segment(lowConfidenceInput, { provider });
    expect(result.method).toBe('rules');
    expect(result.warnings.some((w) => /LLM fallback deferred/.test(w))).toBe(true);
  });

  it('defers a scanned paper instead of failing it when vision is exhausted', async () => {
    const extraction = extractFromPages(
      'scan',
      [{ pageNo: 1, width: 546, height: 792, items: [] }],
      new Uint8Array([1, 2, 3]),
    );
    const outcome = await runSegmentation(extraction, {
      visionProvider: new MockProvider({ deferAfter: 0, retryAfterMs: 45_000 }),
    });
    expect(outcome.kind).toBe('deferred');
    if (outcome.kind !== 'deferred') return;
    expect(outcome.retryAfterMs).toBe(45_000);
  });

  it('defers rather than failing when no vision provider is configured at all', async () => {
    const extraction = extractFromPages(
      'scan',
      [{ pageNo: 1, width: 546, height: 792, items: [] }],
      new Uint8Array([1]),
    );
    expect((await runSegmentation(extraction, {})).kind).toBe('deferred');
  });

  it('routes a scanned paper through vision and normalises the result', async () => {
    const extraction = extractFromPages(
      'scan',
      [{ pageNo: 1, width: 546, height: 792, items: [] }],
      new Uint8Array([1]),
    );
    const outcome = await runSegmentation(extraction, { visionProvider: new MockProvider() });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value.method).toBe('vision');
    // normaliseVisionResult ran: PART-A/C orGroupIds are cleared and the
    // subject code is compacted.
    expect(outcome.value.metadata.subjectCode).toBe('CS23501');
    for (const q of outcome.value.questions) {
      if (q.part === 'A' || q.part === 'C') expect(q.orGroupId).toBeNull();
    }
  });

  it('refuses to construct a mock whose fixture is not a valid SegmentationResult', () => {
    expect(
      () =>
        new MockProvider({
          // blLevel 9 is outside Bloom's 1-6 and the schema rejects it.
          fixtures: {
            bad: {
              ...({} as SegmentationResult),
              questions: [{ blLevel: 9 } as unknown as SegmentedQuestion],
            } as SegmentationResult,
          },
        }),
    ).toThrow(/not a valid SegmentationResult/);
  });
});
