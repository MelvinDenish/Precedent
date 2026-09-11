/**
 * Provider selection.
 *
 * LLM_PROVIDER_MODE=mock swaps the deterministic provider in for the whole
 * pipeline: no keys, no network, reproducible output. The test suite runs
 * there, and so does anyone bringing the stack up without credentials.
 *
 * The vision provider and the text provider are chosen SEPARATELY because
 * they are different jobs with different constraints. Vision extraction is
 * Gemini's -- it is the only provider here that reads a PDF, and it is the
 * primary path for 20 of the 31 corpus papers. The low-confidence text
 * fallback prefers Groq for latency and falls back to Gemini, since either
 * can do it.
 */

import type { LlmProvider } from '../types.js';
import { GeminiProvider } from './gemini.js';
import { GroqProvider } from './groq.js';
import { MockProvider } from './mock.js';

export { GeminiProvider } from './gemini.js';
export { GroqProvider } from './groq.js';
export { MockProvider, MOCK_PAPER } from './mock.js';
export type { MockProviderOptions } from './mock.js';
export { EXTRACTION_SYSTEM_PROMPT, buildUserPrompt, extractJsonObject } from './prompt.js';

export interface ProviderEnv {
  LLM_PROVIDER_MODE?: string | undefined;
  GEMINI_API_KEY?: string | undefined;
  GEMINI_MODEL?: string | undefined;
  GEMINI_VISION_MODEL?: string | undefined;
  GROQ_API_KEY?: string | undefined;
  GROQ_MODEL?: string | undefined;
}

/**
 * gemini-2.0-flash is RETIRED. Pointing at it fails every vision call with
 * a 404 that reads like a permissions problem, so the default is pinned
 * here as well as in .env.example.
 */
const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';

export function isMockMode(env: ProviderEnv = process.env): boolean {
  return (env.LLM_PROVIDER_MODE ?? '').toLowerCase() === 'mock';
}

/**
 * The provider for S1/S2 vision extraction. Returns null when no vision
 * provider is configured, which is a legitimate state: the digital path
 * still works, and scanned papers wait in the queue rather than failing.
 */
export function visionProvider(env: ProviderEnv = process.env): LlmProvider | null {
  if (isMockMode(env)) return new MockProvider();
  if (!env.GEMINI_API_KEY) return null;
  return new GeminiProvider({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
    visionModel: env.GEMINI_VISION_MODEL ?? env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
  });
}

/** The provider for the low-confidence rule fallback. */
export function textProvider(env: ProviderEnv = process.env): LlmProvider | null {
  if (isMockMode(env)) return new MockProvider();
  if (env.GROQ_API_KEY) {
    return new GroqProvider({ apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL });
  }
  return visionProvider(env);
}
