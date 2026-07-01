import { randomBytes } from 'node:crypto';

// Lowercase + digits, minus lookalikes (0/o, 1/l). 12 chars over 32 symbols
// ≈ 60 bits — unguessable, and collisions are practically impossible
// (the DB unique constraint is the backstop, not the strategy).
const ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz';
const SLUG_LENGTH = 12;

export function generateSlug(): string {
  const bytes = randomBytes(SLUG_LENGTH);
  let slug = '';
  for (let i = 0; i < SLUG_LENGTH; i++) {
    slug += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return slug;
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}
