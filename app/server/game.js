// All league, collection and account operations. Routes in app.js are thin wrappers around this.
'use strict';

const crypto = require('node:crypto');
const { tx } = require('./db');
const R = require('./rules');
const { RuleError } = R;

// Open-world biomes (prototype stand-in) and the habitats whose creatures live there.
const BIOMES = {
  forest_river: { name: 'Temperate forest and river', habitats: ['forest', 'river'] },
  volcanic: { name: 'Volcanic highlands', habitats: ['volcanic'] },
  coast: { name: 'Rocky coast', habitats: ['coast'] },
  alpine: { name: 'Alpine range', habitats: ['alpine'] },
  wetland: { name: 'Wetland', habitats: ['wetland'] },
};

const SPOT_HABITATS = {
  perch: ['alpine'], cover: ['alpine', 'coast'], soft_ground: ['forest', 'wetland'],
  shallows: ['river', 'coast', 'wetland'], open_field: [], tall_grass: ['forest', 'wetland'], scorched: ['volcanic'],
};

const parse = (s) => (s == null ? null : JSON.parse(s));

class Game {
  constructor({ db, sim, catalog, random = Math.random }) {
    this.db = db;
    this.sim = sim;
    this.catalog = catalog;
    this.random = random;
  }

  q(sql) { return this.db.prepare(sql); }

  // ------------------------------------------------------------------ accounts

  signup(username, password) {
    username = String(username || '').trim();
    if (!/^[A-Za-z0-9_\-]{3,24}$/.test(username)) throw new RuleError('Usernames are 3 to 24 letters, numbers, - or _');
    if (String(password || '').length < 6) throw new RuleError('Passwords need at least 6 characters');
    if (this.q('SELECT 1 FROM users WHERE username = ?').get(username)) throw new RuleError('That username is taken');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
    const { lastInsertRowid } = this.q('INSERT INTO users (username, pass_hash, salt) VALUES (?, ?, ?)').run(username, hash, salt);
    return this.newSession(Number(lastInsertRowid));
  }

  login(username, password) {
    const u = this.q('SELECT * FROM users WHERE username = ? AND is_bot = 0').get(String(username || '').trim());
    if (!u) throw new RuleError('Wrong username or password', 401);
    const hash = crypto.scryptSync(String(password || ''), u.salt, 32);
    if (!crypto.timingSafeEqual(hash, Buffer.from(u.pass_hash, 'hex'))) throw new RuleError('Wrong username or password', 401);
    return this.newSession(u.id);
  }

  newSession(userId) {
    const token = crypto.randomBytes(24).toString('hex');
    this.q('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
    return { token, user: this.user(userId) };
  }

  logout(token) { this.q('DELETE FROM sessions WHERE token = ?').run(token); }

  userForToken(token) {
    if (!token) return null;
    const row = this.q('SELECT user_id FROM sessions WHERE token = ?').get(token);
    return row ? this.user(row.user_id) : null;
  }

  user(id) {
    const u = this.q('SELECT id, username, is_bot FROM users WHERE id = ?').get(id);
    return u ? { id: u.id, username: u.username, isBot: !!u.is_bot } : null;
  }

  createBot(name) {
    let base = name.replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 18) || 'Bot';
    let username = base;
    for (let i = 2; this.q('SELECT 1 FROM users WHERE username = ?').get(username); i++) username = `${base}-${i}`;
    const { lastInsertRowid } = this.q('INSERT INTO users (username, is_bot) VALUES (?, 1)').run(username);
    return Number(lastInsertRowid);
  }

  // ------------------------------------------------------------------ collection and access

  collection(userId) {
    const rows = this.q('SELECT * FROM catches WHERE user_id = ? ORDER BY caught_at DESC, id DESC').all(userId);
    return rows.map((r) => ({
      id: r.id, species: r.species, individualSeed: r.individual_seed, stats: parse(r.stats_json),
      attitude: r.attitude, biome: r.biome, source: r.source, caughtAt: r.caught_at,
    }));
  }

  accessibleSpecies(userId) {
    const u = this.user(userId);
    if (u && u.isBot) return this.catalog.species.map((s) => s.id);  // bots are test opponents with full access
    return [...new Set(this.q('SELECT species FROM catches WHERE user_id = ?').all(userId).map((r) => r.species))];
  }

  bestCatch(userId, species) {
    const rows = this.q('SELECT * FROM catches WHERE user_id = ? AND species = ?').all(userId, species);
    let best = null;
    for (const r of rows) {
      const stats = parse(r.stats_json);
      if (!best || R.statTotal(stats) > R.statTotal(best.stats)) best = { seed: r.individual_seed, stats };
    }
    return best;
  }

  openEncounter(userId) {
    const e = this.q("SELECT * FROM encounters WHERE user_id = ? AND status = 'open' ORDER BY id DESC").get(userId);
    if (!e) return null;
    const ind = this.sim.roll(e.species, e.individual_seed);
    return { id: e.id, species: e.species, biome: e.biome, attemptsLeft: e.attempts_left, stats: ind.stats, attitude: ind.attitude };
  }

  explore(userId, biome) {
    const b = BIOMES[biome];
    if (!b) throw new RuleError('Unknown biome');
    const candidates = this.catalog.species.filter((s) => b.habitats.includes(s.habitat));
    const weights = candidates.map((s) => (s.rarity === 'rare' ? 1 : 3));
    let roll = this.random() * weights.reduce((a, c) => a + c, 0);
    let pick = candidates[0];
    for (let i = 0; i < candidates.length; i++) {
      roll -= weights[i];
      if (roll < 0) { pick = candidates[i]; break; }
    }
    const seed = Math.floor(this.random() * 2 ** 40);
    this.q("UPDATE encounters SET status = 'fled' WHERE user_id = ? AND status = 'open'").run(userId);
    this.q('INSERT INTO encounters (user_id, species, individual_seed, biome) VALUES (?, ?, ?, ?)').run(userId, pick.id, seed, biome);
    return this.openEncounter(userId);
  }

  attemptCatch(userId, encounterId) {
    const e = this.q("SELECT * FROM encounters WHERE id = ? AND user_id = ? AND status = 'open'").get(encounterId, userId);
    if (!e) throw new RuleError('That creature is gone. Explore again.', 404);
    const sp = this.catalog.speciesById[e.species];
    const tries = 3 - e.attempts_left;
    const chance = Math.min(0.95, (100 - sp.hidden.catchDifficulty) / 100 + 0.1 * tries);
    if (this.random() < chance) {
      const ind = this.sim.roll(e.species, e.individual_seed);
      return tx(this.db, () => {
        this.q("UPDATE encounters SET status = 'caught' WHERE id = ?").run(e.id);
        const { lastInsertRowid } = this.q(
          'INSERT INTO catches (user_id, species, individual_seed, stats_json, attitude, biome) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(userId, e.species, e.individual_seed, JSON.stringify(ind.stats), ind.attitude, e.biome);
        return { result: 'caught', catchId: Number(lastInsertRowid), species: e.species };
      });
    }
    const left = e.attempts_left - 1;
    if (left <= 0) {
      this.q("UPDATE encounters SET attempts_left = 0, status = 'fled' WHERE id = ?").run(e.id);
      return { result: 'fled', species: e.species };
    }
    this.q('UPDATE encounters SET attempts_left = ? WHERE id = ?').run(left, e.id);
    return { result: 'escaped', species: e.species, attemptsLeft: left };
  }

  // ------------------------------------------------------------------ trades between accounts

  trades(userId) {
    const rows = this.q('SELECT * FROM trades WHERE (from_user = ? OR to_user = ?) ORDER BY id DESC LIMIT 50').all(userId, userId);
    const catchInfo = (id) => {
      const c = this.q('SELECT id, species, stats_json, attitude, user_id FROM catches WHERE id = ?').get(id);
      return c ? { id: c.id, species: c.species, stats: parse(c.stats_json), attitude: c.attitude, ownerId: c.user_id } : null;
    };
    return rows.map((t) => ({
      id: t.id, status: t.status, createdAt: t.created_at,
      from: this.user(t.from_user), to: this.user(t.to_user),
      offer: catchInfo(t.offer_catch_id), request: catchInfo(t.request_catch_id),
    }));
  }

  // Public view of another player's collection, used to pick what to ask for in a trade.
  publicCollection(username) {
    const u = this.q('SELECT id FROM users WHERE username = ? AND is_bot = 0').get(String(username || '').trim());
    if (!u) throw new RuleError('No player with that name', 404);
    return { user: this.user(u.id), catches: this.collection(u.id) };
  }

  proposeTrade(userId, toUsername, offerCatchId, requestCatchId) {
    const to = this.q('SELECT id FROM users WHERE username = ? AND is_bot = 0').get(String(toUsername || '').trim());
    if (!to) throw new RuleError('No player with that name', 404);
    if (to.id === userId) throw new RuleError("You can't trade with yourself");
    const offer = this.q('SELECT * FROM catches WHERE id = ? AND user_id = ?').get(offerCatchId, userId);
    if (!offer) throw new RuleError("You don't own the creature you're offering");
    const req = this.q('SELECT * FROM catches WHERE id = ? AND user_id = ?').get(requestCatchId, to.id);
    if (!req) throw new RuleError("They don't own the creature you asked for");
    const { lastInsertRowid } = this.q('INSERT INTO trades (from_user, to_user, offer_catch_id, request_catch_id) VALUES (?, ?, ?, ?)')
      .run(userId, to.id, offerCatchId, requestCatchId);
    return Number(lastInsertRowid);
  }

  respondTrade(userId, tradeId, action) {
    const t = this.q("SELECT * FROM trades WHERE id = ? AND status = 'pending'").get(tradeId);
    if (!t) throw new RuleError('That trade is no longer open', 404);
    if (action === 'cancel') {
      if (t.from_user !== userId) throw new RuleError('Only the sender can cancel', 403);
      this.q("UPDATE trades SET status = 'cancelled' WHERE id = ?").run(t.id);
      return 'cancelled';
    }
    if (t.to_user !== userId) throw new RuleError('Only the receiver can answer', 403);
    if (action === 'decline') {
      this.q("UPDATE trades SET status = 'declined' WHERE id = ?").run(t.id);
      return 'declined';
    }
    if (action !== 'accept') throw new RuleError('Unknown action');
    return tx(this.db, () => {
      const offer = this.q('SELECT user_id FROM catches WHERE id = ?').get(t.offer_catch_id);
      const req = this.q('SELECT user_id FROM catches WHERE id = ?').get(t.request_catch_id);
      if (!offer || !req || offer.user_id !== t.from_user || req.user_id !== t.to_user) {
        this.q("UPDATE trades SET status = 'void' WHERE id = ?").run(t.id);
        throw new RuleError('One of those creatures has already changed hands');
      }
      this.q("UPDATE catches SET user_id = ?, source = 'trade' WHERE id = ?").run(t.to_user, t.offer_catch_id);
      this.q("UPDATE catches SET user_id = ?, source = 'trade' WHERE id = ?").run(t.from_user, t.request_catch_id);
      this.q("UPDATE trades SET status = 'accepted' WHERE id = ?").run(t.id);
      // Any other open trades involving these two creatures can no longer happen.
      this.q("UPDATE trades SET status = 'void' WHERE status = 'pending' AND (offer_catch_id IN (?, ?) OR request_catch_id IN (?, ?))")
        .run(t.offer_catch_id, t.request_catch_id, t.offer_catch_id, t.request_catch_id);
      return 'accepted';
    });
  }

  // ------------------------------------------------------------------ leagues

  league(leagueId) {
    const l = this.q('SELECT * FROM leagues WHERE id = ?').get(leagueId);
    if (!l) throw new RuleError('League not found', 404);
    return { ...l, settings: parse(l.settings_json) };
  }

  members(leagueId) {
    return this.q(`SELECT m.user_id, m.team_name, m.draft_slot, m.lineup_json, u.username, u.is_bot
                   FROM league_members m JOIN users u ON u.id = m.user_id WHERE m.league_id = ? ORDER BY m.joined_at, m.user_id`)
      .all(leagueId)
      .map((m) => ({ userId: m.user_id, teamName: m.team_name, draftSlot: m.draft_slot, lineup: parse(m.lineup_json), username: m.username, isBot: !!m.is_bot }));
  }

  requireMember(leagueId, userId) {
    const m = this.q('SELECT 1 FROM league_members WHERE league_id = ? AND user_id = ?').get(leagueId, userId);
    if (!m) throw new RuleError("You're not in this league", 403);
  }

  requireCommissioner(league, userId) {
    if (league.commissioner_id !== userId) throw new RuleError('Only the commissioner can do that', 403);
  }

  log(leagueId, userId, kind, detail) {
    this.q('INSERT INTO league_log (league_id, user_id, kind, detail_json) VALUES (?, ?, ?, ?)').run(leagueId, userId, kind, JSON.stringify(detail));
  }

  myLeagues(userId) {
    return this.q(`SELECT l.id, l.name, l.status, l.current_week, m.team_name,
                     (SELECT COUNT(*) FROM league_members x WHERE x.league_id = l.id) AS managers
                   FROM leagues l JOIN league_members m ON m.league_id = l.id WHERE m.user_id = ? ORDER BY l.id DESC`).all(userId)
      .map((r) => ({ id: r.id, name: r.name, status: r.status, currentWeek: r.current_week, teamName: r.team_name, managers: r.managers }));
  }

  createLeague(userId, { name, teamName, settings }) {
    name = String(name || '').trim();
    if (name.length < 2 || name.length > 40) throw new RuleError('League names are 2 to 40 characters');
    const s = R.normalizeSettings(settings);
    const poolSpecies = R.speciesInPool(this.catalog, s.poolRule);
    const cap = R.maxManagersForPool(poolSpecies.length, s);
    if (cap < 2) throw new RuleError(`That pool only has ${poolSpecies.length} species, too few for even 2 rosters of ${s.rosterSize}`);
    if (s.maxManagers > cap) s.maxManagers = cap;
    const seed = 1 + Math.floor(this.random() * 2_000_000_000);
    let code;
    do {
      code = Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(this.random() * 32)]).join('');
    } while (this.q('SELECT 1 FROM leagues WHERE code = ?').get(code));
    return tx(this.db, () => {
      const { lastInsertRowid } = this.q('INSERT INTO leagues (name, code, commissioner_id, seed, settings_json) VALUES (?, ?, ?, ?, ?)')
        .run(name, code, userId, seed, JSON.stringify(s));
      const id = Number(lastInsertRowid);
      this.addMember(id, userId, teamName || `${this.user(userId).username}'s team`);
      this.log(id, userId, 'created', { name });
      return id;
    });
  }

  addMember(leagueId, userId, teamName) {
    teamName = String(teamName || '').trim().slice(0, 30) || 'Team';
    this.q('INSERT INTO league_members (league_id, user_id, team_name) VALUES (?, ?, ?)').run(leagueId, userId, teamName);
  }

  joinLeague(userId, code, teamName) {
    const l = this.q('SELECT * FROM leagues WHERE code = ?').get(String(code || '').trim().toUpperCase());
    if (!l) throw new RuleError('No league with that code', 404);
    if (l.status !== 'setup') throw new RuleError('That league has already drafted');
    if (this.q('SELECT 1 FROM league_members WHERE league_id = ? AND user_id = ?').get(l.id, userId)) return l.id;
    const s = parse(l.settings_json);
    if (this.members(l.id).length >= s.maxManagers) throw new RuleError('That league is full');
    this.addMember(l.id, userId, teamName || `${this.user(userId).username}'s team`);
    this.log(l.id, userId, 'joined', {});
    return l.id;
  }

  addBots(userId, leagueId, count = 1) {
    const l = this.league(leagueId);
    this.requireCommissioner(l, userId);
    if (l.status !== 'setup') throw new RuleError('Bots can only join before the draft');
    const names = ['Moss Wardens', 'Tidebreakers', 'Ashfall', 'Peak Hunters', 'Mire Kings', 'Storm Court', 'Riverbend', 'Cinder Crew'];
    const n = Math.max(1, Math.min(Number(count) || 1, 5));
    for (let i = 0; i < n; i++) {
      const have = this.members(leagueId);
      if (have.length >= l.settings.maxManagers) break;
      const used = new Set(have.map((m) => m.teamName));
      const team = names.find((x) => !used.has(x)) || `Bot team ${have.length + 1}`;
      const botId = this.createBot(team.replace(/\s+/g, ''));
      this.addMember(leagueId, botId, team);
    }
    this.log(leagueId, userId, 'bots_added', { count: n });
  }

  startDraft(userId, leagueId) {
    const l = this.league(leagueId);
    this.requireCommissioner(l, userId);
    if (l.status !== 'setup') throw new RuleError('The draft has already started');
    const members = this.members(leagueId);
    if (members.length < 2) throw new RuleError('You need at least 2 managers. Invite someone or add a bot.');
    const species = R.speciesInPool(this.catalog, l.settings.poolRule);
    if (species.length * 3 < members.length * l.settings.rosterSize) throw new RuleError('The pool is too small for this many managers');
    const allowed = new Set(species.map((s) => s.id));
    const rolled = this.sim.pool(l.seed).filter((ind) => allowed.has(ind.species));
    const order = R.shuffle(members.map((m) => m.userId), l.seed);
    tx(this.db, () => {
      const ins = this.q('INSERT INTO pool (league_id, id, species, copy, individual_seed, stats_json, attitude) VALUES (?, ?, ?, ?, ?, ?, ?)');
      rolled.forEach((ind, i) => ins.run(leagueId, i + 1, ind.species, ind.copy, ind.seed, JSON.stringify(ind.stats), ind.attitude));
      order.forEach((uid, slot) => this.q('UPDATE league_members SET draft_slot = ? WHERE league_id = ? AND user_id = ?').run(slot, leagueId, uid));
      this.q("UPDATE leagues SET status = 'drafting', draft_pick = 0 WHERE id = ?").run(leagueId);
      this.log(leagueId, userId, 'draft_started', { order });
    });
    this.runBotPicks(leagueId);
  }

  onTheClock(leagueId) {
    const l = this.league(leagueId);
    if (l.status !== 'drafting') return null;
    const members = this.members(leagueId);
    const slot = R.snakeSlot(l.draft_pick, members.length);
    return members.find((m) => m.draftSlot === slot) || null;
  }

  pick(userId, leagueId, poolId, { asCommissioner = false } = {}) {
    const l = this.league(leagueId);
    if (l.status !== 'drafting') throw new RuleError("The draft isn't running");
    const clock = this.onTheClock(leagueId);
    if (!clock) throw new RuleError("The draft isn't running");
    if (clock.userId !== userId && !(asCommissioner && l.commissioner_id === userId)) throw new RuleError("It's not your pick", 403);
    const entry = this.q('SELECT * FROM pool WHERE league_id = ? AND id = ?').get(leagueId, poolId);
    if (!entry) throw new RuleError('That creature is not in the pool', 404);
    if (entry.owner_id != null) throw new RuleError('That creature has already been drafted');
    tx(this.db, () => {
      this.q('UPDATE pool SET owner_id = ?, drafted_pick = ? WHERE league_id = ? AND id = ?').run(clock.userId, l.draft_pick + 1, leagueId, poolId);
      this.q('UPDATE leagues SET draft_pick = draft_pick + 1 WHERE id = ?').run(leagueId);
      this.log(leagueId, clock.userId, 'pick', { pick: l.draft_pick + 1, poolId, species: entry.species, copy: entry.copy });
      const total = this.members(leagueId).length * l.settings.rosterSize;
      if (l.draft_pick + 1 >= total) this.beginSeason(leagueId);
    });
  }

  // Best available by stat total, preferring species the manager doesn't already have.
  // When the league requires access, creatures the manager can actually field come first.
  bestAvailable(leagueId, userId) {
    const l = this.league(leagueId);
    const avail = this.q('SELECT * FROM pool WHERE league_id = ? AND owner_id IS NULL').all(leagueId);
    const mine = new Set(this.q('SELECT species FROM pool WHERE league_id = ? AND owner_id = ?').all(leagueId, userId).map((r) => r.species));
    const access = l.settings.requireAccess ? new Set(this.accessibleSpecies(userId)) : null;
    let best = null;
    let bestScore = -Infinity;
    for (const p of avail) {
      const score = R.statTotal(parse(p.stats_json)) - (mine.has(p.species) ? 60 : 0) + (access && access.has(p.species) ? 1000 : 0);
      if (score > bestScore) { best = p; bestScore = score; }
    }
    return best;
  }

  autopick(userId, leagueId) {
    const clock = this.onTheClock(leagueId);
    if (!clock) throw new RuleError("The draft isn't running");
    const l = this.league(leagueId);
    if (clock.userId !== userId && l.commissioner_id !== userId) throw new RuleError("It's not your pick", 403);
    const best = this.bestAvailable(leagueId, clock.userId);
    this.pick(userId, leagueId, best.id, { asCommissioner: true });
    this.runBotPicks(leagueId);
  }

  runBotPicks(leagueId) {
    for (let guard = 0; guard < 500; guard++) {
      const clock = this.onTheClock(leagueId);
      if (!clock || !clock.isBot) return;
      const best = this.bestAvailable(leagueId, clock.userId);
      this.pick(clock.userId, leagueId, best.id);
    }
  }

  beginSeason(leagueId) {
    const l = this.league(leagueId);
    const ids = R.shuffle(this.members(leagueId).map((m) => m.userId), l.seed + 1);
    const weeks = R.roundRobin(ids, l.settings.regularWeeks);
    const ins = this.q("INSERT INTO matchups (league_id, week, kind, home_id, away_id) VALUES (?, ?, 'regular', ?, ?)");
    weeks.forEach((pairs, w) => pairs.forEach(([h, a]) => ins.run(leagueId, w + 1, h, a)));
    this.q("UPDATE leagues SET status = 'season', current_week = 1 WHERE id = ?").run(leagueId);
    this.log(leagueId, null, 'season_started', { weeks: l.settings.regularWeeks });
  }

  roster(leagueId, userId) {
    return this.q('SELECT * FROM pool WHERE league_id = ? AND owner_id = ? ORDER BY drafted_pick').all(leagueId, userId).map(poolRow);
  }

  isPlayable(league, userId, species) {
    if (!league.settings.requireAccess) return true;
    return this.accessibleSpecies(userId).includes(species);
  }

  // The individual whose stats a battle uses, following the league's "stats used" setting.
  battleSeed(league, userId, entry) {
    if (league.settings.statsUsed === 'caught' && !this.user(userId).isBot) {
      const best = this.bestCatch(userId, entry.species);
      if (best) return best.seed;
    }
    return entry.individualSeed;
  }

  validateLineup(league, userId, lineup) {
    const stadium = this.catalog.stadiumsById[league.settings.stadium];
    const members = (lineup && lineup.members) || [];
    if (members.length !== 4) throw new RuleError('A lineup needs exactly 4 creatures');
    const roster = new Map(this.roster(league.id, userId).map((p) => [p.id, p]));
    const seenIds = new Set();
    const seenSpots = new Set();
    const clean = [];
    for (const m of members) {
      const entry = roster.get(Number(m.poolId));
      if (!entry) throw new RuleError("A lineup creature isn't on your roster");
      if (seenIds.has(entry.id)) throw new RuleError('The same creature is in the lineup twice');
      seenIds.add(entry.id);
      const sp = this.catalog.speciesById[entry.species];
      if (!this.isPlayable(league, userId, entry.species)) throw new RuleError(`You haven't caught a ${sp.name} yet, so you can't field it`);
      const col = Number(m.col);
      const row = Number(m.row);
      if (![0, 1].includes(col) || ![0, 1, 2].includes(row)) throw new RuleError('Pick a spot for every creature');
      const key = `${col},${row}`;
      if (seenSpots.has(key)) throw new RuleError('Two creatures are on the same spot');
      seenSpots.add(key);
      const spot = stadium.spots.find((s) => s.col === col && s.row === row).type;
      if (!R.canStandOn(sp, spot)) throw new RuleError(`${sp.name} can't stand on ${spot.replace('_', ' ')}`);
      const tactic = R.TACTICS.includes(m.tactic) ? m.tactic : 'aggressive';
      const movePlan = Array.isArray(m.movePlan) ? m.movePlan.filter((x) => sp.moves.includes(x)) : [];
      clean.push({ poolId: entry.id, col, row, tactic, movePlan });
    }
    return { members: clean };
  }

  setLineup(userId, leagueId, lineup) {
    const l = this.league(leagueId);
    this.requireMember(leagueId, userId);
    if (!['season', 'playoffs'].includes(l.status)) throw new RuleError('Lineups open once the draft is done');
    const clean = this.validateLineup(l, userId, lineup);
    this.q('UPDATE league_members SET lineup_json = ? WHERE league_id = ? AND user_id = ?').run(JSON.stringify(clean), leagueId, userId);
    return clean;
  }

  // Picks the 4 strongest playable creatures and the best legal spot for each.
  autoLineup(league, userId) {
    const stadium = this.catalog.stadiumsById[league.settings.stadium];
    const playable = this.roster(league.id, userId)
      .filter((p) => this.isPlayable(league, userId, p.species))
      .sort((a, b) => R.statTotal(b.stats) - R.statTotal(a.stats));
    const chosen = [];
    const free = stadium.spots.map((s) => ({ ...s }));
    for (const p of playable) {
      if (chosen.length === 4) break;
      const sp = this.catalog.speciesById[p.species];
      let best = null;
      let bestScore = -1;
      for (const s of free) {
        if (!R.canStandOn(sp, s.type)) continue;
        let score = 0;
        if (s.type === 'perch' && sp.form === 'flier') score += 5;
        if (s.type === 'shallows' && sp.form === 'swimmer') score += 5;
        if (s.type === 'soft_ground' && sp.form === 'burrower') score += 5;
        if ((SPOT_HABITATS[s.type] || []).includes(sp.habitat)) score += 3;
        if (s.type === 'tall_grass' || s.type === 'cover') score += 1;
        if (score > bestScore) { best = s; bestScore = score; }
      }
      if (!best) continue;
      free.splice(free.indexOf(best), 1);
      const supportsAllies = sp.moves.some((m) => ['ally', 'allies'].includes(this.catalog.movesById[m].target));
      const tactic = supportsAllies ? 'guardian' : p.stats.speed >= 100 ? 'disruptor' : 'aggressive';
      chosen.push({ poolId: p.id, col: best.col, row: best.row, tactic, movePlan: [] });
    }
    return chosen.length === 4 ? { members: chosen } : null;
  }

  // The lineup used at match time: the saved one if it's still legal, otherwise an automatic one.
  matchLineup(league, userId) {
    const saved = this.q('SELECT lineup_json FROM league_members WHERE league_id = ? AND user_id = ?').get(league.id, userId);
    const lineup = parse(saved && saved.lineup_json);
    if (lineup) {
      try { return { lineup: this.validateLineup(league, userId, lineup), auto: false }; } catch { /* fall through */ }
    }
    const auto = this.autoLineup(league, userId);
    return auto ? { lineup: auto, auto: true } : null;
  }

  teamForBattle(league, userId) {
    const m = this.q('SELECT team_name FROM league_members WHERE league_id = ? AND user_id = ?').get(league.id, userId);
    const picked = this.matchLineup(league, userId);
    if (!picked) return null;
    const roster = new Map(this.roster(league.id, userId).map((p) => [p.id, p]));
    return {
      name: m.team_name,
      auto: picked.auto,
      members: picked.lineup.members.map((x) => {
        const entry = roster.get(x.poolId);
        const member = {
          id: `${entry.species}#${entry.copy}`,
          species: entry.species,
          individualSeed: this.battleSeed(league, userId, entry),
          spot: { col: x.col, row: x.row },
          tactic: x.tactic,
        };
        if (x.movePlan && x.movePlan.length) member.movePlan = x.movePlan;
        return member;
      }),
    };
  }

  advice(userId, leagueId, poolIds) {
    const l = this.league(leagueId);
    this.requireMember(leagueId, userId);
    const roster = new Map(this.roster(leagueId, userId).map((p) => [p.id, p]));
    const creatures = poolIds.map((id) => roster.get(Number(id))).filter(Boolean);
    if (!creatures.length) return [];
    // Score against the next opponent's roster, or the whole pool if there's no fixture.
    const next = this.q('SELECT * FROM matchups WHERE league_id = ? AND week = ? AND (home_id = ? OR away_id = ?) AND played_at IS NULL')
      .get(leagueId, l.current_week, userId, userId);
    const oppId = next ? (next.home_id === userId ? next.away_id : next.home_id) : null;
    let opponents = oppId ? this.roster(leagueId, oppId) : [];
    if (!opponents.length) opponents = this.q('SELECT * FROM pool WHERE league_id = ?').all(leagueId).map(poolRow);
    const res = this.sim.advise(
      creatures.map((c) => ({ species: c.species, individualSeed: this.battleSeed(l, userId, c) })),
      opponents.map((o) => ({ species: o.species, individualSeed: o.individualSeed })),
      'clear'
    );
    return creatures.map((c, i) => ({ poolId: c.id, moves: res[i].moves }));
  }

  waiver(userId, leagueId, dropPoolId, addPoolId) {
    const l = this.league(leagueId);
    this.requireMember(leagueId, userId);
    if (!['season', 'playoffs'].includes(l.status)) throw new RuleError('Waivers open once the season starts');
    const drop = this.q('SELECT * FROM pool WHERE league_id = ? AND id = ? AND owner_id = ?').get(leagueId, dropPoolId, userId);
    if (!drop) throw new RuleError("That creature isn't on your roster");
    const add = this.q('SELECT * FROM pool WHERE league_id = ? AND id = ? AND owner_id IS NULL').get(leagueId, addPoolId);
    if (!add) throw new RuleError("That creature isn't available");
    tx(this.db, () => {
      this.q('UPDATE pool SET owner_id = NULL WHERE league_id = ? AND id = ?').run(leagueId, dropPoolId);
      this.q('UPDATE pool SET owner_id = ? WHERE league_id = ? AND id = ?').run(userId, leagueId, addPoolId);
      this.log(leagueId, userId, 'waiver', { drop: drop.species, add: add.species });
    });
  }

  runWeek(userId, leagueId) {
    const l = this.league(leagueId);
    this.requireCommissioner(l, userId);
    if (!['season', 'playoffs'].includes(l.status)) throw new RuleError('There is no week to play');
    const week = l.current_week;
    const games = this.q('SELECT * FROM matchups WHERE league_id = ? AND week = ? AND played_at IS NULL ORDER BY id').all(leagueId, week);
    const results = [];
    games.forEach((g, idx) => {
      results.push(this.playMatch(l, g, week, idx));
    });
    tx(this.db, () => {
      const kinds = new Set(games.map((g) => g.kind));
      if (kinds.has('final')) {
        const final = this.q("SELECT * FROM matchups WHERE league_id = ? AND week = ? AND kind = 'final'").get(leagueId, week);
        this.q("UPDATE leagues SET status = 'done', champion_id = ? WHERE id = ?").run(final.winner_id, leagueId);
        this.log(leagueId, final.winner_id, 'champion', {});
      } else if (kinds.has('semi')) {
        const semis = this.q("SELECT * FROM matchups WHERE league_id = ? AND week = ? AND kind = 'semi' ORDER BY id").all(leagueId, week);
        this.q("INSERT INTO matchups (league_id, week, kind, home_id, away_id) VALUES (?, ?, 'final', ?, ?)").run(leagueId, week + 1, semis[0].winner_id, semis[1].winner_id);
        this.q('UPDATE leagues SET current_week = ? WHERE id = ?').run(week + 1, leagueId);
      } else if (week >= l.settings.regularWeeks) {
        this.createPlayoffs(leagueId, week + 1);
      } else {
        this.q('UPDATE leagues SET current_week = ? WHERE id = ?').run(week + 1, leagueId);
      }
    });
    return results;
  }

  createPlayoffs(leagueId, week) {
    const table = R.standings(this.members(leagueId), this.matchupRows(leagueId));
    const ins = this.q('INSERT INTO matchups (league_id, week, kind, home_id, away_id) VALUES (?, ?, ?, ?, ?)');
    if (table.length >= 4) {
      ins.run(leagueId, week, 'semi', table[0].userId, table[3].userId);
      ins.run(leagueId, week, 'semi', table[1].userId, table[2].userId);
    } else {
      ins.run(leagueId, week, 'final', table[0].userId, table[1].userId);
    }
    this.q("UPDATE leagues SET status = 'playoffs', current_week = ? WHERE id = ?").run(week, leagueId);
    this.log(leagueId, null, 'playoffs', { seeds: table.slice(0, 4).map((t) => t.userId) });
  }

  playMatch(league, g, week, idx) {
    const done = (fields) => {
      this.q(`UPDATE matchups SET winner_id = ?, reason = ?, home_hp = ?, away_hp = ?, rounds = ?, replay_json = ?, played_at = datetime('now') WHERE id = ?`)
        .run(fields.winner ?? null, fields.reason, fields.homeHp ?? null, fields.awayHp ?? null, fields.rounds ?? null, fields.replay ? JSON.stringify(fields.replay) : null, g.id);
      return { matchupId: g.id, ...fields, replay: undefined };
    };
    if (g.away_id == null) return done({ reason: 'bye' });
    const home = this.teamForBattle(league, g.home_id);
    const away = this.teamForBattle(league, g.away_id);
    if (!home && !away) return done({ reason: 'double_forfeit' });
    if (!home) return done({ winner: g.away_id, reason: 'forfeit' });
    if (!away) return done({ winner: g.home_id, reason: 'forfeit' });
    const rand = R.seededRandom(league.seed + week * 31 + idx);
    const weather = league.settings.weather === 'random' ? R.WEATHERS[Math.floor(rand() * R.WEATHERS.length)] : 'clear';
    const setup = {
      stadium: league.settings.stadium,
      weather,
      seed: league.seed * 100 + week * 10 + idx,
      teams: [
        { name: home.name, members: home.members },
        { name: away.name, members: away.members },
      ],
    };
    const replay = this.sim.battle(setup);
    replay.autoLineups = [home.auto, away.auto];
    const r = replay.result;
    return done({
      winner: r.winner === 0 ? g.home_id : g.away_id,
      reason: r.reason,
      homeHp: r.hpPermille[0],
      awayHp: r.hpPermille[1],
      rounds: r.rounds,
      replay,
    });
  }

  matchupRows(leagueId) {
    return this.q('SELECT * FROM matchups WHERE league_id = ? ORDER BY week, id').all(leagueId).map((m) => ({
      id: m.id, week: m.week, kind: m.kind, homeId: m.home_id, awayId: m.away_id, winnerId: m.winner_id,
      reason: m.reason, homeHp: m.home_hp, awayHp: m.away_hp, rounds: m.rounds, played: !!m.played_at,
    }));
  }

  matchup(userId, matchupId) {
    const m = this.q('SELECT * FROM matchups WHERE id = ?').get(matchupId);
    if (!m) throw new RuleError('Matchup not found', 404);
    this.requireMember(m.league_id, userId);
    const row = this.matchupRows(m.league_id).find((x) => x.id === m.id);
    return { ...row, leagueId: m.league_id, replay: parse(m.replay_json) };
  }

  leagueState(userId, leagueId) {
    const l = this.league(leagueId);
    this.requireMember(leagueId, userId);
    const members = this.members(leagueId);
    const pool = this.q('SELECT * FROM pool WHERE league_id = ? ORDER BY id').all(leagueId).map(poolRow);
    const matchups = this.matchupRows(leagueId);
    const clock = this.onTheClock(leagueId);
    const me = members.find((m) => m.userId === userId);
    const order = [...members].filter((m) => m.draftSlot != null).sort((a, b) => a.draftSlot - b.draftSlot).map((m) => m.userId);
    const log = this.q('SELECT * FROM league_log WHERE league_id = ? ORDER BY id DESC LIMIT 40').all(leagueId)
      .map((x) => ({ kind: x.kind, userId: x.user_id, detail: parse(x.detail_json), at: x.at }));
    const poolSpecies = R.speciesInPool(this.catalog, l.settings.poolRule);
    return {
      league: {
        id: l.id, name: l.name, code: l.code, status: l.status, currentWeek: l.current_week, settings: l.settings,
        commissionerId: l.commissioner_id, championId: l.champion_id,
        poolSpecies: poolSpecies.length, maxManagersForPool: R.maxManagersForPool(poolSpecies.length, l.settings),
      },
      me: { userId, teamName: me.teamName, isCommissioner: l.commissioner_id === userId, lineup: me.lineup, access: this.accessibleSpecies(userId) },
      members: members.map((m) => ({ userId: m.userId, teamName: m.teamName, username: m.username, isBot: m.isBot, draftSlot: m.draftSlot })),
      pool,
      draft: { pick: l.draft_pick, total: members.length * l.settings.rosterSize, onTheClock: clock ? clock.userId : null, order },
      matchups,
      standings: R.standings(members, matchups),
      log,
    };
  }
}

function poolRow(p) {
  return {
    id: p.id, species: p.species, copy: p.copy, individualSeed: p.individual_seed,
    stats: parse(p.stats_json), attitude: p.attitude, ownerId: p.owner_id, draftedPick: p.drafted_pick,
  };
}

module.exports = { Game, BIOMES };
