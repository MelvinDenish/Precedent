/**
 * The extraction prompt, shared by every provider.
 *
 * The model is asked for `segmentationResultSchema` DIRECTLY, not for some
 * intermediate transcription that a second pass then structures. That is
 * the whole reason the IR was frozen before either extraction path was
 * built: 19 of the 31 corpus papers are image-only scans, so vision is the
 * PRIMARY path, and a vision path emitting a different shape from the rule
 * path would force a translation layer that drifts.
 *
 * WHAT IS AND IS NOT THE PROMPT'S JOB. The prompt asks for orGroupId and
 * explains what it means, because the model can see the centred "OR" and
 * the rules cannot always. It is NOT the enforcement point: canMerge() in
 * shared/src/or-rule.ts is, and it runs in code before and after every
 * merge. Prompts are not a safety mechanism -- a model that ignores this
 * paragraph must be caught by the guard, not trusted because it was asked.
 */

import type { FilenameHints } from '../types.js';

export const EXTRACTION_SYSTEM_PROMPT = `You extract exam questions from Indian university question papers and return ONLY JSON.

You will be given a question paper. Return one JSON object with exactly these keys:

{
  "metadata": {
    "subjectCode": string|null,      // e.g. "CS23501". No spaces. As PRINTED.
    "subjectName": string|null,
    "regulationCode": string|null,   // e.g. "R2023". Prefix with R.
    "examYear": number|null,         // the SITTING year, not the regulation year
    "examSession": string|null,      // "nov-dec" or "apr-may"
    "examType": "endsem"|"assessment"|"quiz"|"supplementary"|"retest"|null,
    "college": string|null,          // "CEG" or "MIT" ONLY. null if the paper is
                                     // set centrally by the university departments.
                                     // Never put the university's own name here.
    "paperSet": string|null,         // a set letter such as BT/OT/RT/GT, if printed
    "semester": number|null,
    "totalMarks": number|null
  },
  "template": {
    "totalMarks": number,
    "parts": [{ "part":"A"|"B"|"C", "slotCount":number, "marksPerSlot":number,
                "hasChoice":boolean, "note":string|null }]
  } | null,
  "questions": [{
    "part": "A"|"B"|"C"|null,
    "qNumber": string,               // "11" ONLY. Never "11(a)".
    "partLabel": string|null,        // "a", "b", "a-i", "a-ii". Never "(a)".
    "text": string,                  // the question, WITHOUT its number, marks, CO or BL
    "marks": number|null,
    "orGroupId": number|null,
    "coCode": number|null,           // from the CO column: "CO3" -> 3
    "blLevel": number|null,          // from the BL column: "L2" -> 2, range 1-6
    "pageNo": number|null,
    "confidence": number             // 0..1, YOUR certainty about THIS question
  }],
  "method": "vision",
  "overallConfidence": number,
  "warnings": string[]
}

RULES, in order of how much damage breaking them does:

1. OR GROUPS. Where a literal centred "OR" separates two alternatives --
   typically "11 (a)" then OR then "11 (b)" -- emit BOTH as SEPARATE
   questions and give BOTH orGroupId equal to the question number (11).
   NEVER merge two alternatives into one question. Use null for orGroupId
   anywhere no choice is offered, which includes ALL of PART-A and PART-C.
   Two sub-parts that are BOTH answered, such as "(a) (4 marks)" and
   "(b) (4 marks)" summing to the question total, are NOT an OR pair: they
   get orGroupId null.

2. SUB-PART MARKS. When a question divides into (i) and (ii) with their own
   marks, emit one question per sub-part carrying ITS OWN marks -- 5 and 8,
   not a single 13. Emit the leaves only; never the parent as well, or its
   marks are counted twice.

3. METADATA COMES FROM THE HEADER, NEVER FROM A FILENAME. Older papers in
   this archive are a different subject code and regulation from the folder
   they sit in. Read what is printed on the page.

4. CO AND BL ARE PRINTED. They are columns on the right of the question
   table. Capture them. Use null when a question genuinely has none; never
   invent a plausible value.

5. Put anything you are unsure about in "warnings" and lower the relevant
   confidence. An honest low score routes the paper to human review, which
   is cheap. A confident wrong answer corrupts the corpus permanently.

Return the JSON object and nothing else. No markdown fence, no commentary.`;

/**
 * Hints are passed as what they are -- an archive filename, frequently
 * wrong -- rather than as facts, so the model does not resolve a conflict
 * in their favour. The one exception is paperSet, which no paper in this
 * corpus prints in its header at all.
 */
export function buildUserPrompt(hints?: FilenameHints, dirtyText?: string): string {
  const parts: string[] = ['Extract this question paper.'];

  if (hints) {
    const known = [
      hints.examYear === null ? null : `year ${hints.examYear}`,
      hints.college === null ? null : `college ${hints.college}`,
      hints.paperSet === null ? null : `paper set ${hints.paperSet}`,
      hints.examType === null ? null : `exam type ${hints.examType}`,
    ].filter((h): h is string => h !== null);
    if (known.length > 0) {
      parts.push(
        `The ARCHIVE FILENAME suggests: ${known.join(', ')}. ` +
          'These are guesses from a filename and are often wrong about the year, ' +
          'the subject and the regulation. Where the page disagrees, the page wins. ' +
          'Only the paper set is worth taking from the filename, since papers do not print it.',
      );
    }
  }

  if (dirtyText) {
    parts.push(
      'This paper has a text layer, but it failed a quality check and reads as ' +
        'damaged OCR. It is included only as a hint about what the page says. ' +
        'Trust the image over this text wherever they differ:\n\n' +
        dirtyText.slice(0, 8000),
    );
  }

  return parts.join('\n\n');
}

/**
 * Models wrap JSON in a markdown fence even when told not to, and the fence
 * is the single most common reason a structured call fails validation.
 */
export function extractJsonObject(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = (fenced?.[1] ?? raw).trim();
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('no JSON object in response');
  return JSON.parse(body.slice(first, last + 1));
}
