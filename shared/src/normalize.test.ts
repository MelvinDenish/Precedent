import { describe, expect, it } from 'vitest';
import { contentHash, normalizeForHash } from './normalize.js';

/**
 * The idempotency guarantee. See docs/EVALUATION.md section 5:
 * "Upload the same paper from two different archives -> still deduplicates,
 *  because the hash is on normalized text, not raw bytes."
 */
describe('content hashing for idempotency', () => {
  const paper = `
    ANNA UNIVERSITY (UNIVERSITY DEPARTMENTS)
    B.E. / B.Tech END SEMESTER EXAMINATIONS, NOV/DEC 2025
    CS23503 - Theory of Computation
    PART - A (10 x 2 = 20 Marks)
    1. Create a FA which accepts the only input 101.
  `;

  it('produces a stable hash for identical text', () => {
    expect(contentHash(paper)).toBe(contentHash(paper));
  });

  it('ignores whitespace differences between PDF producers', () => {
    const reflowed = paper.replace(/\s+/g, '  ').replace(/\n/g, '\r\n');
    expect(contentHash(reflowed)).toBe(contentHash(paper));
  });

  it('ignores case', () => {
    expect(contentHash(paper.toUpperCase())).toBe(contentHash(paper));
  });

  it('ignores a registration number stamped by one archive but not another', () => {
    const stamped = paper.replace(
      'ANNA UNIVERSITY',
      'Reg. No.: 2023CS1042\n    ANNA UNIVERSITY',
    );
    expect(contentHash(stamped)).toBe(contentHash(paper));
  });

  it('ignores roll-number and page-number furniture', () => {
    const withFurniture = `Roll. No. 71762233042\n${paper}\nPage 1 of 3\n`;
    expect(contentHash(withFurniture)).toBe(contentHash(paper));
  });

  it('ignores smart-quote substitution', () => {
    const smart = `${paper}\n2. What is a \u201cregular\u201d language\u2019s closure?`;
    const plain = `${paper}\n2. What is a "regular" language's closure?`;
    expect(contentHash(smart)).toBe(contentHash(plain));
  });

  it('still distinguishes genuinely different papers', () => {
    const other = paper.replace('Theory of Computation', 'Operating Systems');
    expect(contentHash(other)).not.toBe(contentHash(paper));
  });

  it('distinguishes a changed question', () => {
    const other = paper.replace('input 101', 'input 110');
    expect(contentHash(other)).not.toBe(contentHash(paper));
  });

  it('emits a 64-character hex digest', () => {
    expect(contentHash(paper)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('normalizeForHash', () => {
  it('collapses whitespace runs to a single space', () => {
    expect(normalizeForHash('a     b\n\n\tc')).toBe('a b c');
  });

  it('trims', () => {
    expect(normalizeForHash('   padded   ')).toBe('padded');
  });
});
