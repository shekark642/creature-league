// HTTP routes. Each one is a thin wrapper around a Game method.
'use strict';

const path = require('node:path');
const express = require('express');
const { BIOMES } = require('./game');
const R = require('./rules');

const COOKIE = 'cl_session';

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// The catalog the browser sees. Hidden stats stay on the server.
function publicCatalog(catalog) {
  return {
    elements: catalog.elements,
    species: catalog.species.map(({ hidden, ...rest }) => rest),
    moves: catalog.moves,
    stadiums: catalog.stadiums,
    biomes: Object.entries(BIOMES).map(([id, b]) => ({ id, ...b })),
    habitats: R.HABITATS,
    tactics: R.TACTICS,
    defaults: R.DEFAULT_SETTINGS,
  };
}

function createApp(game) {
  const app = express();
  app.use(express.json({ limit: '200kb' }));

  const catalogJson = publicCatalog(game.catalog);

  const setCookie = (res, token) => {
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 60}`);
  };

  // Wraps a handler so thrown RuleErrors become JSON errors with their status.
  const h = (fn) => (req, res) => {
    try {
      const out = fn(req, res);
      if (!res.headersSent) res.json(out === undefined ? { ok: true } : out);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server' : err.message });
    }
  };

  const auth = (req, res, next) => {
    const token = readCookie(req, COOKIE);
    const user = game.userForToken(token);
    if (!user) return res.status(401).json({ error: 'Please log in' });
    req.user = user;
    req.token = token;
    next();
  };

  const id = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) {
      const e = new Error('Bad id');
      e.status = 400;
      throw e;
    }
    return n;
  };

  // ---------------------------------------------------------------- accounts
  app.post('/api/signup', h((req, res) => {
    const { token, user } = game.signup(req.body.username, req.body.password);
    setCookie(res, token);
    return { user };
  }));
  app.post('/api/login', h((req, res) => {
    const { token, user } = game.login(req.body.username, req.body.password);
    setCookie(res, token);
    return { user };
  }));
  app.post('/api/logout', h((req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) game.logout(token);
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0`);
  }));
  app.get('/api/me', auth, h((req) => ({ user: req.user })));

  app.get('/api/catalog', h(() => catalogJson));

  // ---------------------------------------------------------------- collection
  app.get('/api/collection', auth, h((req) => ({
    catches: game.collection(req.user.id),
    encounter: game.openEncounter(req.user.id),
  })));
  app.post('/api/explore', auth, h((req) => ({ encounter: game.explore(req.user.id, req.body.biome) })));
  app.post('/api/catch', auth, h((req) => game.attemptCatch(req.user.id, id(req.body.encounterId))));

  // ---------------------------------------------------------------- trades
  app.get('/api/trades', auth, h((req) => ({ trades: game.trades(req.user.id) })));
  app.post('/api/trades', auth, h((req) => ({
    id: game.proposeTrade(req.user.id, req.body.to, id(req.body.offerCatchId), id(req.body.requestCatchId)),
  })));
  app.post('/api/trades/:id/:action(accept|decline|cancel)', auth, h((req) => ({
    status: game.respondTrade(req.user.id, id(req.params.id), req.params.action),
  })));
  app.get('/api/players/:username/collection', auth, h((req) => game.publicCollection(req.params.username)));

  // ---------------------------------------------------------------- leagues
  app.get('/api/leagues', auth, h((req) => ({ leagues: game.myLeagues(req.user.id) })));
  app.post('/api/leagues', auth, h((req) => ({
    id: game.createLeague(req.user.id, { name: req.body.name, teamName: req.body.teamName, settings: req.body.settings }),
  })));
  app.post('/api/leagues/join', auth, h((req) => ({ id: game.joinLeague(req.user.id, req.body.code, req.body.teamName) })));
  app.get('/api/leagues/:id', auth, h((req) => game.leagueState(req.user.id, id(req.params.id))));
  app.post('/api/leagues/:id/bots', auth, h((req) => game.addBots(req.user.id, id(req.params.id), req.body.count)));
  app.post('/api/leagues/:id/start-draft', auth, h((req) => game.startDraft(req.user.id, id(req.params.id))));
  app.post('/api/leagues/:id/pick', auth, h((req) => {
    const leagueId = id(req.params.id);
    game.pick(req.user.id, leagueId, id(req.body.poolId));
    game.runBotPicks(leagueId);
  }));
  app.post('/api/leagues/:id/autopick', auth, h((req) => game.autopick(req.user.id, id(req.params.id))));
  app.post('/api/leagues/:id/waiver', auth, h((req) => game.waiver(req.user.id, id(req.params.id), id(req.body.dropPoolId), id(req.body.addPoolId))));
  app.post('/api/leagues/:id/run-week', auth, h((req) => ({ results: game.runWeek(req.user.id, id(req.params.id)) })));
  app.get('/api/leagues/:id/lineup', auth, h((req) => {
    const leagueId = id(req.params.id);
    game.requireMember(leagueId, req.user.id);
    const league = game.league(leagueId);
    const current = ['season', 'playoffs', 'done'].includes(league.status) ? game.matchLineup(league, req.user.id) : null;
    return {
      roster: game.roster(leagueId, req.user.id),
      lineup: current ? current.lineup : null,
      auto: current ? current.auto : false,
      recommended: ['season', 'playoffs'].includes(league.status) ? game.autoLineup(league, req.user.id) : null,
    };
  }));
  app.put('/api/leagues/:id/lineup', auth, h((req) => ({ lineup: game.setLineup(req.user.id, id(req.params.id), req.body) })));
  app.get('/api/leagues/:id/advice', auth, h((req) => {
    const ids = String(req.query.poolIds || '').split(',').filter(Boolean).map(Number).slice(0, 15);
    return { advice: game.advice(req.user.id, id(req.params.id), ids) };
  }));

  app.get('/api/matchups/:id', auth, h((req) => game.matchup(req.user.id, id(req.params.id))));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ---------------------------------------------------------------- the web app
  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub));
  app.get('*', (req, res) => res.sendFile(path.join(pub, 'index.html')));

  return app;
}

module.exports = { createApp, publicCatalog };
