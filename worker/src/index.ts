/**
 * Worker entrypoint. Same codebase as the API, different process, scaled
 * independently.
 *
 * Every ingestion stage S1..S9 is a separate BullMQ job rather than one long
 * function: a failure retries only the failed stage, different stages need
 * different rate limiters (vision vs text vs none), progress is reportable
 * per stage, and a stage can be re-run in isolation when its implementation
 * improves -- re-segmenting without re-extracting, for instance.
 */
import { QUEUES } from '@precedent/shared';

console.log('worker starting; queues:', Object.values(QUEUES).join(', '));
