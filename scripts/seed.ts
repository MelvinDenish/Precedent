/**
 * Corpus seeder.
 *
 * Loads the university, regulation, subjects and syllabus units from the
 * R2023 curriculum document, then reports the papers it found.
 *
 * Idempotent throughout: every insert is ON CONFLICT DO UPDATE, so re-running
 * after adding papers costs nothing for the ones already present. That
 * matters because 20 of the 31 papers need vision extraction against a
 * rate-limited free tier, and a seeder that reprocessed everything on each
 * run would exhaust the daily quota before finishing.
 *
 * The corpus is never committed. CORPUS_DIR points at it on disk.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { parseSubjectSyllabus } from '../worker/src/syllabus/parse.js';

const CORPUS_DIR = process.env.CORPUS_DIR ?? './data';

/** The curriculum document covering the whole degree. */
const SYLLABUS_FILE = 'B.E. CSE.pdf';

const UNIVERSITY = { name: 'Anna University', slug: 'anna-university' };
const REGULATION = 'R2023';

/**
 * Codes only. Names, units, hours and course outcomes all come from the
 * parsed syllabus, so this list never has to be hand-synced with it.
 */
const SUBJECT_CODES = ['CS23501', 'CS23502', 'CS23503'];

/** Not present in the per-subject section; it comes from the plan table. */
const SEMESTER = 5;

/**
 * pdftotext -layout, because the column structure is load-bearing: the
 * syllabus separates a unit title from its hours with nothing but a run of
 * spaces, and the parser reads exactly that boundary.
 */
function pdfToText(path: string): string {
  return execFileSync('pdftotext', ['-layout', path, '-'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function seedSyllabus(client: pg.Client): Promise<Map<string, string>> {
  const syllabusPath = join(CORPUS_DIR, SYLLABUS_FILE);
  if (!existsSync(syllabusPath)) {
    throw new Error(
      `Curriculum document not found at ${syllabusPath}. Set CORPUS_DIR, or ` +
        'place the syllabus PDF there. Papers alone cannot answer what is in ' +
        'the syllabus but has never been examined.',
    );
  }

  const documentText = pdfToText(syllabusPath);

  const universityResult = await client.query<{ university_id: string }>(
    `INSERT INTO universities (name, slug) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING university_id`,
    [UNIVERSITY.name, UNIVERSITY.slug],
  );
  const universityId = universityResult.rows[0]!.university_id;

  const regulationResult = await client.query<{ regulation_id: string }>(
    `INSERT INTO regulations (university_id, code) VALUES ($1, $2)
       ON CONFLICT (university_id, code) DO UPDATE SET code = EXCLUDED.code
     RETURNING regulation_id`,
    [universityId, REGULATION],
  );
  const regulationId = regulationResult.rows[0]!.regulation_id;

  const subjectIds = new Map<string, string>();

  for (const code of SUBJECT_CODES) {
    const parsed = parseSubjectSyllabus(documentText, code);
    if (!parsed) {
      console.warn(`  ${code}: no syllabus section found, skipping`);
      continue;
    }

    const subjectResult = await client.query<{ subject_id: string }>(
      `INSERT INTO subjects (university_id, regulation_id, code, name, semester)
       VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (university_id, regulation_id, code)
         DO UPDATE SET name = EXCLUDED.name, semester = EXCLUDED.semester
       RETURNING subject_id`,
      [universityId, regulationId, code, parsed.subjectName, SEMESTER],
    );
    const subjectId = subjectResult.rows[0]!.subject_id;
    subjectIds.set(code, subjectId);

    for (const unit of parsed.units) {
      await client.query(
        `INSERT INTO syllabus_units (subject_id, unit_no, title, hours, raw_text)
         VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (subject_id, unit_no)
           DO UPDATE SET title = EXCLUDED.title,
                         hours = EXCLUDED.hours,
                         raw_text = EXCLUDED.raw_text`,
        [subjectId, unit.unitNo, unit.title, unit.lectureHours, unit.rawText],
      );
    }

    const totalHours = parsed.units.reduce((sum, u) => sum + (u.lectureHours ?? 0), 0);
    console.log(
      `  ${code} ${parsed.subjectName}: ${parsed.units.length} units, ` +
        `${totalHours}L total, ${parsed.courseOutcomes.length} course outcomes`,
    );
  }

  return subjectIds;
}

// --- Paper discovery ------------------------------------------------

export interface PaperHints {
  examType: string | null;
  college: string | null;
  paperSet: string | null;
  examYear: number | null;
}

export interface DiscoveredPaper {
  path: string;
  filename: string;
  /** Inferred from the directory; confirmed later against the paper header. */
  subjectCode: string;
  hints: PaperHints;
}

/**
 * Filename hints, deliberately kept SEPARATE from the metadata that reaches
 * the database.
 *
 * Filenames in this corpus lie, by omission and by content. "OS-Endsem-BT"
 * carries no year at all. "CN-CEG-22S5-QP" looks like a 2022 CEG paper, and
 * its header reads "12th September 2022, CS6111, Regulation 2018" -- a
 * different subject code under a different regulation. So these are a
 * fallback for when header parsing yields nothing, never an override.
 */
export function filenameHints(filename: string): PaperHints {
  const upper = filename.replace(/\.pdf$/i, '').toUpperCase();

  const examType = /SUPPLEMENTARY/.test(upper)
    ? 'supplementary'
    : /RETEST|RE-TEST/.test(upper)
      ? 'retest'
      : /QUIZ/.test(upper)
        ? 'quiz'
        : /ASSESS/.test(upper)
          ? 'assessment'
          : /ENDSEM|END-SEM/.test(upper)
            ? 'endsem'
            : null;

  const college = /\bCEG\b/.test(upper) ? 'CEG' : /\bMIT\b/.test(upper) ? 'MIT' : null;
  const setMatch = /-(BT|OT|RT|GT)\b/.exec(upper);

  // "22S5" reads as semester 5 of the 2022 sitting.
  const yearMatch = /\b(\d{2})S\d\b/.exec(upper);

  return {
    examType,
    college,
    paperSet: setMatch?.[1] ?? null,
    examYear: yearMatch ? 2000 + Number(yearMatch[1]) : null,
  };
}

/** Walks the corpus for past papers, which live under a PYQ directory. */
export function discoverPapers(corpusDir: string): DiscoveredPaper[] {
  const found: DiscoveredPaper[] = [];

  const walk = (dir: string, subjectCode: string | null): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        // Subject directories are named like "CS23501 - Operating Systems".
        const codeMatch = /\b([A-Z]{2,3}\d{4,5})\b/.exec(entry);
        walk(full, codeMatch?.[1] ?? subjectCode);
        continue;
      }

      if (!/\.pdf$/i.test(entry)) continue;
      // Only PYQ directories hold examination papers. Their siblings are
      // notes, textbooks, slides and assignments, which become user_sources
      // for the Teaching Engine's grounding, not corpus evidence.
      if (!/[\\/]PYQ[\\/]/i.test(full)) continue;
      if (!subjectCode) continue;

      found.push({ path: full, filename: entry, subjectCode, hints: filenameHints(entry) });
    }
  };

  walk(corpusDir, null);
  return found;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    console.log('Seeding syllabus from the curriculum document...');
    const subjectIds = await seedSyllabus(client);

    console.log(`\nDiscovering papers under ${CORPUS_DIR}...`);
    const papers = discoverPapers(CORPUS_DIR);

    const bySubject = new Map<string, number>();
    for (const paper of papers) {
      bySubject.set(paper.subjectCode, (bySubject.get(paper.subjectCode) ?? 0) + 1);
    }
    for (const [code, count] of [...bySubject].sort()) {
      const note = subjectIds.has(code) ? '' : '  (no syllabus section, will be skipped)';
      console.log(`  ${code}: ${count} papers${note}`);
    }

    console.log(`\n${papers.length} papers discovered, ${subjectIds.size} subjects seeded.`);
    console.log(
      [
        '',
        'Papers are not ingested here. They go through POST /upload so they take',
        'the same idempotency and queueing path a contributor does. A seeder with',
        'its own private ingestion route is a second code path, and it drifts.',
      ].join('\n'),
    );
  } finally {
    await client.end();
  }
}

// Only runs when invoked directly, so the discovery helpers stay testable.
const entrypoint = process.argv[1]?.replace(/\\/g, '/').split('/').pop() ?? '';
if (entrypoint === 'seed.ts' || entrypoint === 'seed.js') {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
