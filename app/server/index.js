// Starts the league server: node server/index.js (or npm start).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const { Simulator } = require('./sim');
const { loadCatalog } = require('./catalog');
const { Game } = require('./game');
const { createApp } = require('./app');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'league.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const sim = new Simulator();
const game = new Game({ db: openDb(dbPath), sim, catalog: loadCatalog(sim.dataDir) });
const port = Number(process.env.PORT) || 3000;

createApp(game).listen(port, () => {
  console.log(`Creature League running at http://localhost:${port}`);
  console.log(`Simulator: ${sim.clsim}`);
  console.log(`Database: ${dbPath}`);
});
