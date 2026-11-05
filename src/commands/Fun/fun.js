/** Opt-in /fun group. Existing prefix shortcuts stay untouched. */
import { createCompactCommandGroup } from '../../utils/compactCommandGroup.js';
import fight from './fight.js';
import flip from './flip.js';
import roll from './roll.js';

export default createCompactCommandGroup('fun', 'Games and fun commands', 'Fun', {
  fight, flip, roll,
});
