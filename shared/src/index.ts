/**
 * @precedent/shared -- the contract every workspace builds against.
 *
 * FROZEN after Phase 0. A wave agent needing a new shared type declares it
 * locally; it gets promoted here during the inter-wave merge.
 */

export * from './domain.js';
export * from './contract.js';
export * from './jobs.js';
export * from './segmentation.js';
export * from './or-rule.js';
export * from './normalize.js';
export * from './schemas.js';
