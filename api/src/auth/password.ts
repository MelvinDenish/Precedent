/**
 * Password hashing.
 *
 * bcrypt, because it is deliberately slow and salted per password. The cost
 * factor is the security parameter: 12 is roughly a quarter-second per hash
 * on commodity hardware, which is negligible on a login and ruinous on an
 * offline dictionary attack.
 */
import bcrypt from 'bcryptjs';

const COST = 12;

export function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, COST);
}

export function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

/**
 * A bcrypt hash of a throwaway value, compared against when no user matched.
 *
 * Without it, login returns in ~1ms for an unknown address and ~250ms for a
 * known one, and that difference enumerates the user table. Comparing against
 * a real hash on the miss path makes both branches cost the same.
 */
const DUMMY_HASH = bcrypt.hashSync('precedent-timing-equalizer', COST);

export async function equalizeTiming(): Promise<void> {
  await bcrypt.compare('precedent-timing-equalizer', DUMMY_HASH);
}
