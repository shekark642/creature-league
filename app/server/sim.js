// Runs the C++ simulator (clsim). The league never computes battle results itself.
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function findClsim() {
  if (process.env.CLSIM_PATH) return process.env.CLSIM_PATH;
  const candidates = [
    path.join(REPO_ROOT, 'build', 'simulator', 'clsim'),
    path.join(REPO_ROOT, 'build', 'simulator', 'Release', 'clsim.exe'),
    path.join(REPO_ROOT, 'build', 'simulator', 'clsim.exe'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error('Simulator not built. Run: cmake -S . -B build && cmake --build build (from the repo root), or set CLSIM_PATH.');
  }
  return found;
}

class Simulator {
  constructor({ clsimPath, dataDir } = {}) {
    this.clsim = clsimPath || findClsim();
    this.dataDir = dataDir || path.join(REPO_ROOT, 'data');
  }

  run(args, input) {
    try {
      const out = execFileSync(this.clsim, ['--data', this.dataDir, ...args], {
        input,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      return JSON.parse(out);
    } catch (err) {
      const msg = (err.stderr || err.message || '').toString().replace(/^error:\s*/, '').trim();
      const e = new Error(`Simulator: ${msg}`);
      e.status = 400;
      throw e;
    }
  }

  // 3 rolled individuals per species, seeded from the league.
  pool(poolSeed) {
    return this.run(['pool', String(poolSeed)]);
  }

  // setup: { stadium, weather, seed, teams: [{ name, members: [{ species, individualSeed, spot, tactic, movePlan }] }] }
  battle(setup) {
    return this.run(['battle', '-', '--compact'], JSON.stringify(setup));
  }

  // creatures/opponents: [{ species, individualSeed }]
  advise(creatures, opponents, weather = 'clear') {
    return this.run(['advise-json', '-'], JSON.stringify({ weather, creatures, opponents }));
  }

  roll(species, seed) {
    return this.run(['roll', species, String(seed)]);
  }
}

module.exports = { Simulator, findClsim, REPO_ROOT };
