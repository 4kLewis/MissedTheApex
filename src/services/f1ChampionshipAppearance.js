/**
 * MissedTheApex championship board presentation (no Discord / network dependencies).
 * Never invent driver numbers or host countries. The caller supplies authoritative metadata.
 */

const TEAM_NAMES = {
  mercedes: ['mercedes', 'team_mercedes', 'f1_mercedes'],
  ferrari: ['ferrari', 'team_ferrari', 'f1_ferrari'],
  mclaren: ['mclaren', 'team_mclaren', 'f1_mclaren'],
  redbull: ['redbull', 'red_bull', 'redbullracing', 'red_bull_racing', 'team_redbull'],
  williams: ['williams', 'team_williams', 'f1_williams'],
  alpine: ['alpine', 'team_alpine', 'f1_alpine'],
  astonmartin: ['astonmartin', 'aston_martin', 'team_astonmartin'],
  racingbulls: ['racingbulls', 'racing_bulls', 'vcarb', 'team_racingbulls'],
  haas: ['haas', 'haasf1', 'team_haas'],
  audi: ['audi', 'team_audi', 'f1_audi'],
  cadillac: ['cadillac', 'team_cadillac', 'f1_cadillac'],
};

const FALLBACK = {
  mercedes: '🟢', ferrari: '🔴', mclaren: '🟠', redbull: '🔵',
  williams: '🔷', alpine: '🩵', astonmartin: '🟩', racingbulls: '🔹',
  haas: '⚪', audi: '🟥', cadillac: '⚫',
};

export function teamKey(team) {
  const name = String(team || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (name.includes('racing bulls') || name.includes('visa cash app rb') || name === 'rb') return 'racingbulls';
  if (name.includes('red bull')) return 'redbull';
  if (name.includes('aston martin')) return 'astonmartin';
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

export function teamEmoji(team, guild) {
  const key = teamKey(team);
  if (!key) return '🏎️';
  const names = TEAM_NAMES[key];
  const cache = guild?.emojis?.cache;
  if (cache?.values) {
    const emojis = [...cache.values()];
    for (const wanted of names) {
      const found = emojis.find(e => e?.name?.toLowerCase() === wanted && /^\d{15,23}$/.test(String(e?.id || '')));
      if (found) return `<${found.animated ? 'a' : ''}:${found.name}:${found.id}>`;
    }
  }
  return FALLBACK[key];
}

export function teamEmojiStamp(guild) {
  const cache = guild?.emojis?.cache;
  if (!cache?.values) return '';
  // Embed refreshes if an admin uploads/renames team emojis.
  return [...cache.values()].filter(e => e?.id && e?.name)
    .map(e => `${e.id}:${e.name}:${e.animated ? 1 : 0}`).sort().join(',');
}

const COUNTRY_CODES = new Map(Object.entries({
  australia:'au', china:'cn', japan:'jp', bahrain:'bh', 'saudi arabia':'sa',
  'united states':'us', 'united states of america':'us', usa:'us',
  italy:'it', canada:'ca', monaco:'mc', spain:'es', austria:'at',
  'united kingdom':'gb', 'great britain':'gb', uk:'gb',
  belgium:'be', hungary:'hu', netherlands:'nl', azerbaijan:'az',
  singapore:'sg', mexico:'mx', brazil:'br', qatar:'qa',
  'united arab emirates':'ae', uae:'ae', 'abu dhabi':'ae',
}));

export function raceFlagUrl(country) {
  const key = String(country || '').toLowerCase().trim();
  const code = COUNTRY_CODES.get(key);
  return code ? `https://flagcdn.com/w80/${code}.png` : null;
}

function safeLabel(value) {
  return String(value || '').replace(/[\r\n`*_~>|@\\]/g, ' ').trim().slice(0, 70);
}
function carNumber(row) {
  // Between races use Jolpica's permanentNumber; during races use OpenF1 driver_number.
  const n = Number(row.carNumber ?? (typeof row.id === 'number' ? row.id : NaN));
  return Number.isInteger(n) && n >= 1 && n <= 999 ? `\`#${n}\`` : '`#—`';
}
export function championshipBoardRows(rows, type, { guild = null, live = false } = {}) {
  return rows.map(row => {
    const icon = teamEmoji(type === 'drivers' ? row.team : row.name, guild);
    const position = `\`${String(row.position).padStart(2, '0')}\``;
    const label = safeLabel(row.name);
    const points = `**${row.points}** pts`;
    const diff = Number(row.points) - Number(row.start);
    const change = live && Number.isFinite(diff) ? ` (${diff >= 0 ? '+' : ''}${diff} race)` : '';
    return type === 'drivers'
      ? `${position} ${icon} ${carNumber(row)} **${label}** — ${points}${change}`
      : `${position} ${icon} **${label}** — ${points}${change}`;
  }).join('\n').slice(0, 3800);
}
