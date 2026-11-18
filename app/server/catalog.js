// Loads the shared game data (the same JSON files the simulator reads).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadCatalog(dataDir) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
  const elements = read('elements.json');
  const species = read('species.json').species;
  const moves = read('moves.json').moves;
  const stadiums = read('stadiums.json').stadiums;
  const speciesById = Object.fromEntries(species.map((s) => [s.id, s]));
  const movesById = Object.fromEntries(moves.map((m) => [m.id, m]));
  const stadiumsById = Object.fromEntries(stadiums.map((s) => [s.id, s]));
  return { elements, species, moves, stadiums, speciesById, movesById, stadiumsById };
}

module.exports = { loadCatalog };
