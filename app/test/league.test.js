// End-to-end tests through the HTTP API, using the real C++ simulator.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../server/db');
const { Simulator } = require('../server/sim');
const { loadCatalog } = require('../server/catalog');
const { Game } = require('../server/game');
const { createApp } = require('../server/app');
const R = require('../server/rules');

function setup() {
  const sim = new Simulator();
  const game = new Game({ db: openDb(':memory:'), sim, catalog: loadCatalog(sim.dataDir), random: R.seededRandom(7) });
  const server = createApp(game).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    const call = async (method, url, body) => {
      const res = await fetch(base + url, {
        method,
        headers: { 'content-type': 'application/json', cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const data = await res.json();
      return { status: res.status, data };
    };
    return {
      get: (u) => call('GET', u),
      post: (u, b = {}) => call('POST', u, b),
      put: (u, b) => call('PUT', u, b),
    };
  };
  return { game, server, client };
}

test('accounts: signup, login, auth required', async (t) => {
  const { server, client } = setup();
  t.after(() => server.close());
  const a = client();
  assert.strictEqual((await a.get('/api/me')).status, 401);
  assert.strictEqual((await a.post('/api/signup', { username: 'x', password: 'secret1' })).status, 400);
  const s = await a.post('/api/signup', { username: 'shekar', password: 'secret1' });
  assert.strictEqual(s.status, 200);
  assert.strictEqual((await a.get('/api/me')).data.user.username, 'shekar');
  const b = client();
  assert.strictEqual((await b.post('/api/login', { username: 'shekar', password: 'nope!!' })).status, 401);
  assert.strictEqual((await b.post('/api/login', { username: 'SHEKAR', password: 'secret1' })).status, 200);
  const cat = (await b.get('/api/catalog')).data;
  assert.strictEqual(cat.species.length, 20);
  assert.ok(!('hidden' in cat.species[0]), 'hidden stats must not reach the browser');
});

test('catching and trading between accounts', async (t) => {
  const { server, client } = setup();
  t.after(() => server.close());
  const a = client();
  const b = client();
  await a.post('/api/signup', { username: 'alice', password: 'secret1' });
  await b.post('/api/signup', { username: 'bruno', password: 'secret1' });
  const catchOne = async (c) => {
    for (let i = 0; i < 50; i++) {
      const enc = (await c.post('/api/explore', { biome: 'forest_river' })).data.encounter;
      for (let k = 0; k < 3; k++) {
        const r = (await c.post('/api/catch', { encounterId: enc.id })).data;
        if (r.result === 'caught') return r.catchId;
        if (r.result === 'fled') break;
      }
    }
    throw new Error('never caught anything');
  };
  const ca = await catchOne(a);
  const cb = await catchOne(b);
  const view = (await a.get('/api/players/bruno/collection')).data;
  assert.strictEqual(view.catches[0].id, cb);
  const tr = await a.post('/api/trades', { to: 'bruno', offerCatchId: ca, requestCatchId: cb });
  assert.strictEqual(tr.status, 200);
  assert.strictEqual((await a.post(`/api/trades/${tr.data.id}/accept`)).status, 403, 'sender cannot accept');
  assert.strictEqual((await b.post(`/api/trades/${tr.data.id}/accept`)).data.status, 'accepted');
  const mine = (await a.get('/api/collection')).data.catches;
  assert.deepStrictEqual(mine.map((c) => c.id), [cb]);
  assert.strictEqual(mine[0].source, 'trade');
});

test('a full season with bots: draft, lineups, 5 weeks, playoffs, champion', async (t) => {
  const { game, server, client } = setup();
  t.after(() => server.close());
  const me = client();
  await me.post('/api/signup', { username: 'commish', password: 'secret1' });
  // Turn off access so a brand new account can field its drafted team.
  const created = await me.post('/api/leagues', { name: 'Test League', teamName: 'Home Side', settings: { requireAccess: false, weather: 'random' } });
  assert.strictEqual(created.status, 200, JSON.stringify(created.data));
  const L = created.data.id;
  await me.post(`/api/leagues/${L}/bots`, { count: 5 });
  let state = (await me.get(`/api/leagues/${L}`)).data;
  assert.strictEqual(state.members.length, 6);
  assert.strictEqual((await me.post(`/api/leagues/${L}/bots`, { count: 1 })).data.error, undefined, 'adding past the cap is a no-op');

  const started = await me.post(`/api/leagues/${L}/start-draft`);
  assert.strictEqual(started.status, 200, JSON.stringify(started.data));
  state = (await me.get(`/api/leagues/${L}`)).data;
  assert.strictEqual(state.pool.length, 60);
  assert.strictEqual(state.draft.onTheClock, state.me.userId, 'bots pick until it is my turn');

  // Draft: pick the first available by hand once, then autopick the rest.
  const first = state.pool.find((p) => p.ownerId == null);
  assert.strictEqual((await me.post(`/api/leagues/${L}/pick`, { poolId: first.id })).status, 200);
  for (let guard = 0; guard < 20; guard++) {
    state = (await me.get(`/api/leagues/${L}`)).data;
    if (state.league.status !== 'drafting') break;
    const r = await me.post(`/api/leagues/${L}/autopick`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  }
  assert.strictEqual(state.league.status, 'season');
  for (const m of state.members) assert.strictEqual(state.pool.filter((p) => p.ownerId === m.userId).length, 10);

  // Lineup: the recommended one saves, and an illegal one is rejected.
  const lu = (await me.get(`/api/leagues/${L}/lineup`)).data;
  assert.strictEqual(lu.roster.length, 10);
  assert.strictEqual(lu.recommended.members.length, 4);
  const saved = await me.put(`/api/leagues/${L}/lineup`, lu.recommended);
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.data));
  const bad = { members: lu.recommended.members.map((m) => ({ ...m, col: 0, row: 0 })) };
  assert.strictEqual((await me.put(`/api/leagues/${L}/lineup`, bad)).status, 400);

  const adv = (await me.get(`/api/leagues/${L}/advice?poolIds=${lu.roster.map((p) => p.id).join(',')}`)).data.advice;
  assert.strictEqual(adv.length, 10);
  for (const a of adv) assert.ok(a.moves.length >= 2 && a.moves.every((m) => ['recommended', 'situational', 'risky'].includes(m.label)));
  assert.ok(adv.some((a) => a.moves.some((m) => m.label === 'recommended')));

  // Waiver: drop one, add a free agent.
  const free = state.pool.find((p) => p.ownerId == null);
  if (free) {
    const w = await me.post(`/api/leagues/${L}/waiver`, { dropPoolId: lu.roster[9].id, addPoolId: free.id });
    assert.strictEqual(w.status, 200, JSON.stringify(w.data));
  }

  // Play the season.
  for (let week = 1; week <= 5; week++) {
    const r = await me.post(`/api/leagues/${L}/run-week`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.results.length, 3);
    for (const res of r.data.results) assert.ok(['knockout', 'round_limit', 'tiebreak'].includes(res.reason), res.reason);
  }
  state = (await me.get(`/api/leagues/${L}`)).data;
  assert.strictEqual(state.league.status, 'playoffs');
  const semis = state.matchups.filter((m) => m.kind === 'semi');
  assert.strictEqual(semis.length, 2);
  assert.deepStrictEqual([semis[0].homeId, semis[0].awayId], [state.standings[0].userId, state.standings[3].userId]);
  await me.post(`/api/leagues/${L}/run-week`);
  await me.post(`/api/leagues/${L}/run-week`);
  state = (await me.get(`/api/leagues/${L}`)).data;
  assert.strictEqual(state.league.status, 'done');
  const final = state.matchups.find((m) => m.kind === 'final');
  assert.strictEqual(state.league.championId, final.winnerId);
  assert.strictEqual((await me.post(`/api/leagues/${L}/run-week`)).status, 400);

  // Replays are stored and readable.
  const mu = (await me.get(`/api/matchups/${final.id}`)).data;
  assert.strictEqual(mu.replay.format, 'creature-league-replay');
  assert.ok(mu.replay.events.length > 0);

  // Determinism: replaying the stored setup gives the same result.
  const again = game.sim.battle({
    stadium: mu.replay.stadium.id, weather: mu.replay.weather, seed: mu.replay.seed,
    teams: mu.replay.teams.map((tm) => ({ name: tm.name, members: tm.members.map((x) => ({ id: x.individual.id, species: x.individual.species, individualSeed: x.individual.seed, spot: { col: x.spot.col, row: x.spot.row }, tactic: x.tactic, movePlan: x.movePlan })) })),
  });
  assert.deepStrictEqual(again.result, mu.replay.result);
});

test('access rules: uncaught creatures cannot be fielded when access is required', async (t) => {
  const { server, client } = setup();
  t.after(() => server.close());
  const me = client();
  await me.post('/api/signup', { username: 'newbie', password: 'secret1' });
  const L = (await me.post('/api/leagues', { name: 'Strict', settings: { maxManagers: 2 } })).data.id;
  await me.post(`/api/leagues/${L}/bots`, { count: 1 });
  await me.post(`/api/leagues/${L}/start-draft`);
  for (let i = 0; i < 20; i++) {
    const s = (await me.get(`/api/leagues/${L}`)).data;
    if (s.league.status !== 'drafting') break;
    await me.post(`/api/leagues/${L}/autopick`);
  }
  const lu = (await me.get(`/api/leagues/${L}/lineup`)).data;
  assert.strictEqual(lu.recommended, null, 'nothing is playable without catches');
  const attempt = await me.put(`/api/leagues/${L}/lineup`, { members: lu.roster.slice(0, 4).map((p, i) => ({ poolId: p.id, col: 1, row: i % 3 })) });
  assert.strictEqual(attempt.status, 400);
  const r = (await me.post(`/api/leagues/${L}/run-week`)).data.results[0];
  assert.strictEqual(r.reason, 'forfeit');
});

test('autopick puts species you can field first when access is required', async (t) => {
  const { game, server, client } = setup();
  t.after(() => server.close());
  const me = client();
  const uid = (await me.post('/api/signup', { username: 'catcher', password: 'secret1' })).data.user.id;
  game.db.prepare("INSERT INTO catches (user_id, species, individual_seed, stats_json, attitude) VALUES (?, 'rillotter', 1, '{}', 'calm')").run(uid);
  const L = (await me.post('/api/leagues', { name: 'Picky', settings: { maxManagers: 2 } })).data.id;
  await me.post(`/api/leagues/${L}/bots`, { count: 1 });
  await me.post(`/api/leagues/${L}/start-draft`);
  await me.post(`/api/leagues/${L}/autopick`);
  const st = (await me.get(`/api/leagues/${L}`)).data;
  const mine = st.pool.filter((p) => p.ownerId === uid);
  assert.strictEqual(mine[0].species, 'rillotter');
});
