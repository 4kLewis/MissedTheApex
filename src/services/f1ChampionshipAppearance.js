/**
 * MissedTheApex championship board presentation.
 * Uses standard Unicode coloured-square emojis only: no custom server emojis,
 * emoji IDs, emoji fetches or guild permissions required for presentation.
 * Kept API-compatible with the previous Championship Visuals integration.
 */

// Standard Unicode squares approximate each team's colours. Discord cannot
// precisely reproduce the team's hexadecimal timing colour with a Unicode emoji.
const TEAM_SQUARES = Object.freeze({
  mercedes: '🟩',
  ferrari: '🟥',
  mclaren: '🟧',
  redbull: '🟦',
  williams: '🟦',
  alpine: '🟦',
  astonmartin: '🟩',
  racingbulls: '🟦',
  haas: '⬜',
  audi: '🟥',
  cadillac: '⬛',
});

export function teamKey(team) {
  const name = String(team ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  if (/\b(racing bulls|visa cash app rb|rb f1 team|vcarb)\b/.test(name) || name === 'rb') return 'racingbulls';
  if (name.includes('red bull') || name.includes('redbull')) return 'redbull';
  if (name.includes('aston martin') || name.includes('astonmartin')) return 'astonmartin';
  if (name.includes('mercedes')) return 'mercedes';
  if (name.includes('ferrari')) return 'ferrari';
  if (name.includes('mclaren')) return 'mclaren';
  if (name.includes('williams')) return 'williams';
  if (name.includes('alpine')) return 'alpine';
  if (name.includes('haas')) return 'haas';
  if (name.includes('audi')) return 'audi';
  if (name.includes('cadillac')) return 'cadillac';
  return null;
}

// Keep the old function signature to avoid changing the working service code.
// Guild is deliberately ignored: custom Discord emojis are no longer used.
export function teamEmoji(team, _guild = null) {
  return TEAM_SQUARES[teamKey(team)] || '🏎️';
}

// The existing service includes this in its message-refresh signature.
// A fixed new value forces the next successful standings poll to re-render
// the existing boards even when championship points have not changed.
export function teamEmojiStamp(_guild = null) {
  return 'standard-team-squares-v1';
}

const COUNTRY_CODES = new Map(Object.entries({
  australia: 'au', china: 'cn', japan: 'jp', bahrain: 'bh',
  'saudi arabia': 'sa', 'united states': 'us',
  'united states of america': 'us', usa: 'us',
  italy: 'it', canada: 'ca', monaco: 'mc', spain: 'es',
  austria: 'at', 'united kingdom': 'gb',
  'great britain': 'gb', uk: 'gb', belgium: 'be',
  hungary: 'hu', netherlands: 'nl', azerbaijan: 'az',
  singapore: 'sg', mexico: 'mx', brazil: 'br', qatar: 'qa',
  'united arab emirates': 'ae', uae: 'ae', 'abu dhabi': 'ae',
}));

export function raceFlagUrl(country) {
  const key = String(country ?? '').toLowerCase().trim();
  const code = COUNTRY_CODES.get(key);
  return code ? `https://flagcdn.com/w80/${code}.png` : null;
}

function safeLabel(value) {
  return String(value ?? '')
    .replace(/[\r\n`*_~>|@\\]/g, ' ')
    .trim()
    .slice(0, 70);
}

function carNumber(row) {
  const n = Number(row.carNumber ?? (typeof row.id === 'number' ? row.id : NaN));
  return Number.isInteger(n) && n >= 1 && n <= 999
    ? `\`#${n}\`` : '`#—`';
}

export function championshipBoardRows(rows, type, { guild = null, live = false } = {}) {
  return rows.map(row => {
    const square = teamEmoji(type === 'drivers' ? row.team : row.name, guild);
    const position = `\`${String(row.position).padStart(2, '0')}\``;
    const label = safeLabel(row.name);
    const points = `**${row.points}** pts`;
    const diff = Number(row.points) - Number(row.start);
    const change = live && Number.isFinite(diff)
      ? ` (${diff >= 0 ? '+' : ''}${diff} race)` : '';
    return type === 'drivers'
      ? `${position} ${square} ${carNumber(row)} **${label}** — ${points}${change}`
      : `${position} ${square} **${label}** — ${points}${change}`;
  }).join('\n').slice(0, 3800);
}
