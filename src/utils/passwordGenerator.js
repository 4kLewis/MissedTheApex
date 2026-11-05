// Password generator that uses cryptographic randomness and guarantees
// at least one character from every enabled character group.
import { randomInt } from 'node:crypto';

export function generatePassword({ length = 16, uppercase = true, numbers = true, symbols = true } = {}) {
  if (!Number.isInteger(length) || length < 8 || length > 50) {
    throw new RangeError('Password length must be an integer from 8 to 50');
  }

  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const punctuation = '!@#$%^&*()_+-=[]{}|;:,.<>?';
  const pools = [lower];
  if (uppercase) pools.push(upper);
  if (numbers) pools.push(digits);
  if (symbols) pools.push(punctuation);
  const alphabet = pools.join('');

  const chars = pools.map(pool => pool[randomInt(pool.length)]);
  while (chars.length < length) chars.push(alphabet[randomInt(alphabet.length)]);
  // Fisher–Yates removes predictable positions for required character types.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
