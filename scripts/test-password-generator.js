import assert from 'node:assert/strict';
import { generatePassword } from '../src/utils/passwordGenerator.js';

for (const configuration of [
  { uppercase: true, numbers: true, symbols: true },
  { uppercase: true, numbers: false, symbols: true },
  { uppercase: false, numbers: true, symbols: false },
  { uppercase: false, numbers: false, symbols: false },
]) {
  for (let i = 0; i < 100; i++) {
    const password = generatePassword({ length: 12, ...configuration });
    assert.equal(password.length, 12);
    assert.match(password, /[a-z]/);
    if (configuration.uppercase) assert.match(password, /[A-Z]/);
    if (configuration.numbers) assert.match(password, /[0-9]/);
    if (configuration.symbols) assert.match(password, /[^a-zA-Z0-9]/);
    if (!configuration.uppercase) assert.doesNotMatch(password, /[A-Z]/);
    if (!configuration.numbers) assert.doesNotMatch(password, /[0-9]/);
    if (!configuration.symbols) assert.doesNotMatch(password, /[^a-zA-Z0-9]/);
  }
}
assert.throws(() => generatePassword({ length: 7 }), RangeError);
console.log('PASS: cryptographic password generation and required character categories.');
