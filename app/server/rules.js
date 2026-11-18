// Pure league rules with no database access, so they are easy to test.
'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  maxManagers: 6,
  rosterSize: 10,
  perBattle: 4,
  regularWeeks: 5,
  playoffWeeks: 2,
  copiesPerSpecies: 3,
  // Which part of the catalog is legal: all, one rarity tier, or chosen habitats.
  poolRule: { type: 'all' },
  // Whether battles use the drafted copy's stat rolls or the player's own caught individual.
  statsUsed: 'drafted',
  // Players may only field creatures they have access to (caught or traded for).
  requireAccess: true,
  stadium: 'riverside_arena',
  weather: 'clear', // or 'random'
});

const HABITATS = ['forest', 'river', 'volcanic', 'coast', 'alpine', 'wetland'];
const WEATHERS = ['clear', 'rain', 'sun', 'snow', 'storm'];
const TACTICS = ['aggressive', 'guardian', 'disruptor', 'skirmisher'];

function normalizeSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS, ...input };
  const int = (v, lo, hi, name) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new RuleError(`${name} must be a whole number from ${lo} to ${hi}`);
    return n;
  };
  s.maxManagers = int(s.maxManagers, 2, 6, 'Max managers');
  s.rosterSize = int(s.rosterSize, 4, 15, 'Roster size');
  s.perBattle = 4; // battles are always 4v4
  s.regularWeeks = int(s.regularWeeks, 1, 20, 'Season length');
  s.playoffWeeks = 2;
  s.copiesPerSpecies = 3;
  const rule = s.poolRule || { type: 'all' };
  if (rule.type === 'tier') {
    if (!['common', 'rare'].includes(rule.tier)) throw new RuleError('Pool tier must be common or rare');
    s.poolRule = { type: 'tier', tier: rule.tier };
  } else if (rule.type === 'habitats') {
    const hs = (rule.habitats || []).filter((h) => HABITATS.includes(h));
    if (!hs.length) throw new RuleError('Pick at least one habitat for the pool');
    s.poolRule = { type: 'habitats', habitats: [...new Set(hs)] };
  } else {
    s.poolRule = { type: 'all' };
  }
  if (!['drafted', 'caught'].includes(s.statsUsed)) throw new RuleError('Stats used must be drafted or caught');
  s.requireAccess = Boolean(s.requireAccess);
  if (!['clear', 'random'].includes(s.weather)) throw new RuleError('Weather must be clear or random');
  return s;
}

class RuleError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function speciesInPool(catalog, poolRule) {
  return catalog.species.filter((sp) => {
    if (poolRule.type === 'tier') return sp.rarity === poolRule.tier;
    if (poolRule.type === 'habitats') return poolRule.habitats.includes(sp.habitat);
    return true;
  });
}

// The most managers a pool can hold: every roster must be fillable.
function maxManagersForPool(speciesCount, settings) {
  return Math.floor((speciesCount * settings.copiesPerSpecies) / settings.rosterSize);
}

// Snake draft: round 1 goes 1..n, round 2 goes n..1, and so on.
function snakeSlot(pickIndex, managers) {
  const round = Math.floor(pickIndex / managers);
  const pos = pickIndex % managers;
  return round % 2 === 0 ? pos : managers - 1 - pos;
}

// Deterministic shuffle (mulberry32) so a league's draft order follows from its seed.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, seed) {
  const rand = seededRandom(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Round robin by the circle method. Returns weeks of [home, away] pairs; away may be null (a bye).
function roundRobin(ids, weeks) {
  const list = [...ids];
  if (list.length % 2 === 1) list.push(null);
  const n = list.length;
  const rounds = [];
  const rot = [...list];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = rot[i];
      const b = rot[n - 1 - i];
      // Alternate home and away so nobody is always home.
      const pair = r % 2 === 0 ? [a, b] : [b, a];
      if (pair[0] === null) pairs.push([pair[1], null]);
      else pairs.push(pair);
    }
    rounds.push(pairs);
    rot.splice(1, 0, rot.pop());
  }
  const out = [];
  for (let w = 0; w < weeks; w++) out.push(rounds[w % rounds.length]);
  return out;
}

// Standings: 3 points a win; ties broken by total HP left across the season, then by name.
function standings(members, matchups) {
  const table = new Map(members.map((m) => [m.userId, { userId: m.userId, teamName: m.teamName, played: 0, wins: 0, losses: 0, points: 0, hpTotal: 0 }]));
  for (const mu of matchups) {
    if (mu.kind !== 'regular' || mu.winnerId == null || mu.awayId == null) continue;
    const home = table.get(mu.homeId);
    const away = table.get(mu.awayId);
    if (!home || !away) continue;
    home.played++;
    away.played++;
    home.hpTotal += mu.homeHp || 0;
    away.hpTotal += mu.awayHp || 0;
    const [w, l] = mu.winnerId === mu.homeId ? [home, away] : [away, home];
    w.wins++;
    w.points += 3;
    l.losses++;
  }
  return [...table.values()].sort((a, b) => b.points - a.points || b.hpTotal - a.hpTotal || a.teamName.localeCompare(b.teamName));
}

// Spot rules, mirrored from the simulator so the app can check a lineup before saving.
function canStandOn(species, spotType) {
  if (spotType === 'perch') return species.form === 'flier';
  if (spotType === 'cover') return species.size !== 'large' && species.size !== 'huge';
  return true;
}

function statTotal(stats) {
  return stats.hp + stats.attack + stats.defense + stats.focus + stats.speed;
}

module.exports = {
  DEFAULT_SETTINGS, HABITATS, WEATHERS, TACTICS, RuleError,
  normalizeSettings, speciesInPool, maxManagersForPool, snakeSlot, shuffle, seededRandom,
  roundRobin, standings, canStandOn, statTotal,
};
