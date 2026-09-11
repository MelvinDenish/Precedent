import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSubjectSyllabus } from './parse.js';

/**
 * The fixture is a faithful reduction of the real B.E. CSE R2023 curriculum
 * document: same column layout, same U+FFFD replacement characters where the
 * PDF's en-dashes failed to extract, same interleaved page furniture. The
 * real document is not committed -- it lives in the gitignored corpus.
 *
 * Verified against the real document at time of writing: all three subjects
 * parse to 5 units each, with 6 / 5 / 5 course outcomes respectively.
 */
const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../tests/fixtures/syllabus-sample.txt'),
  'utf8',
);

describe('syllabus parsing', () => {
  const os = parseSubjectSyllabus(FIXTURE, 'CS23501');

  it('finds the subject and its name', () => {
    expect(os).not.toBeNull();
    expect(os?.subjectName).toBe('OPERATING SYSTEMS');
  });

  it('recovers all five units in order', () => {
    expect(os?.units.map((u) => u.unitNo)).toEqual([1, 2, 3, 4, 5]);
    expect(os?.units.map((u) => u.title)).toEqual([
      'INTRODUCTION',
      'PROCESSES AND THREADS',
      'PROCESS MANAGEMENT AND SYNCHRONIZATION',
      'MEMORY MANAGEMENT',
      'STORAGE MANAGEMENT',
    ]);
  });

  /**
   * Lecture hours are the syllabus prior on marks weight, and the ROI model
   * leans on them in a LOW repetition regime where per-question p_next
   * carries almost no signal. Losing them silently would degrade exactly the
   * subjects the concept reframe exists to rescue.
   */
  it('recovers lecture and practical hours separately', () => {
    expect(os?.units.map((u) => u.lectureHours)).toEqual([8, 9, 10, 10, 8]);
    expect(os?.units.map((u) => u.practicalHours)).toEqual([12, 12, 12, 12, 12]);
  });

  it('splits the topic list on the em-dash separator', () => {
    expect(os?.units[0]?.topics).toContain('Introduction to Operating Systems');
    expect(os?.units[0]?.topics).toContain('Resource Management');
    expect(os?.units[3]?.topics).toContain('Paging');
  });

  it('excludes lab exercises from examinable theory topics', () => {
    const unit1 = os?.units[0]?.rawText ?? '';
    expect(unit1).not.toMatch(/Basic UNIX commands/);
    expect(unit1).not.toMatch(/Shell programming/);
  });

  it('drops page furniture that interrupts a unit mid-topic', () => {
    const unit3 = os?.units[2]?.rawText ?? '';
    expect(unit3).not.toMatch(/Prepared by|Name & Signature|Applicable to only/);
    // ...while keeping the topics that continue after the page break.
    expect(unit3).toMatch(/Monitors/);
  });

  /**
   * These are the labels behind the CO column printed on every R2023 paper,
   * which is what turns syllabus alignment from a classification problem
   * into a lookup.
   */
  it('recovers the numbered course outcomes, joining wrapped lines', () => {
    expect(os?.courseOutcomes.map((c) => c.number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(os?.courseOutcomes[0]?.text).toMatch(/strengths and limitations of Operating Systems/);
    expect(os?.courseOutcomes[5]?.text).toMatch(/XV6/);
  });

  it('does not mistake the CO-PO mapping grid for course outcomes', () => {
    // The grid's rows start 'CO1 3 1 3', which a loose parser reads as an outcome.
    expect(os?.courseOutcomes).toHaveLength(6);
  });

  it('recovers references, joining wrapped lines', () => {
    expect(os?.references[0]).toMatch(/Silberschatz.*Operating System Concepts.*2018/);
  });

  it('stops at the next subject rather than absorbing it', () => {
    expect(os?.units.some((u) => /NETWORKING/.test(u.title))).toBe(false);
  });

  it('parses a second subject from the same document independently', () => {
    const cn = parseSubjectSyllabus(FIXTURE, 'CS23502');
    expect(cn?.subjectName).toBe('NETWORKS AND DATA COMMUNICATION');
    expect(cn?.units[0]?.lectureHours).toBe(7);
    expect(cn?.units[0]?.practicalHours).toBe(16);
  });

  it('returns null for a subject with no detailed section', () => {
    expect(parseSubjectSyllabus(FIXTURE, 'CS99999')).toBeNull();
  });
});
