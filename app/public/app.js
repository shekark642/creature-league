// Creature League web app. Plain JavaScript, no build step.
'use strict';

const $view = document.getElementById('view');
const S = { me: null, catalog: null, league: null, lineup: null, advice: {}, sel: null, replay: null };

// ------------------------------------------------------------------ helpers

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const words = (s) => String(s || '').replace(/_/g, ' ');
const title = (s) => words(s).replace(/\b\w/g, (c) => c.toUpperCase());

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/login')) { S.me = null; location.hash = '#/login'; }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const GET = (u) => api('GET', u);
const POST = (u, b = {}) => api('POST', u, b);

let toastTimer;
function toast(msg, err = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = err ? 'toast err' : 'toast';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// Runs an action, shows its error as a toast, then re-renders the current page.
async function act(fn, okMsg) {
  try {
    const out = await fn();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(out) : okMsg);
    await route();
    return out;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

const sp = (id) => S.catalog.species.find((s) => s.id === id) || { id, name: id, elements: [], moves: [] };
const mv = (id) => S.catalog.moves.find((m) => m.id === id) || { id, name: id };
const elChips = (els) => els.map((e) => `<span class="chip el el-${e}">${title(e)}</span>`).join('');
const statTotal = (s) => s.hp + s.attack + s.defense + s.focus + s.speed;

function statsRow(st) {
  const keys = [['hp', 'HP'], ['attack', 'Atk'], ['defense', 'Def'], ['focus', 'Foc'], ['speed', 'Spd'], ['stamina', 'Sta']];
  return `<div class="stats">${keys.map(([k, l]) => `<div>${l}<b>${st[k] ?? '–'}</b></div>`).join('')}</div>`;
}

function creatureLine(speciesId, extra = '') {
  const s = sp(speciesId);
  return `<div class="spread"><div><b>${esc(s.name)}</b> ${elChips(s.elements)}<div class="small muted">${title(s.form)} · ${title(s.size)} · ${title(s.habitat)} · ${title(s.rarity)}</div></div>${extra}</div>`;
}

function canStandOn(s, spotType) {
  if (spotType === 'perch') return s.form === 'flier';
  if (spotType === 'cover') return s.size !== 'large' && s.size !== 'huge';
  return true;
}

const teamName = (st, uid) => (st.members.find((m) => m.userId === uid) || {}).teamName || '—';

// ------------------------------------------------------------------ router

const routes = [
  [/^#\/login$/, viewLogin],
  [/^#\/?$/, viewHome],
  [/^#\/collection$/, viewCollection],
  [/^#\/trades$/, viewTrades],
  [/^#\/guide$/, viewGuide],
  [/^#\/league\/(\d+)(?:\/(\w+))?$/, viewLeague],
  [/^#\/matchup\/(\d+)$/, viewMatchup],
];

async function route() {
  const hash = location.hash || '#/';
  if (!S.catalog) S.catalog = await GET('/api/catalog');
  if (!S.me && hash !== '#/login') {
    try { S.me = (await GET('/api/me')).user; } catch { return; }
  }
  document.getElementById('tabbar').hidden = !S.me;
  document.getElementById('who').innerHTML = S.me ? `${esc(S.me.username)} <button class="small" id="logout">Log out</button>` : '';
  const lo = document.getElementById('logout');
  if (lo) lo.onclick = async () => { await POST('/api/logout'); S.me = null; location.hash = '#/login'; };
  const tab = hash.startsWith('#/collection') ? 'collection' : hash.startsWith('#/trades') ? 'trades' : hash.startsWith('#/guide') ? 'guide' : 'home';
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      try { await fn(...m.slice(1)); } catch (e) { $view.innerHTML = `<div class="card">${esc(e.message)}</div>`; }
      return;
    }
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', () => { stopReplay(); route(); });

// ------------------------------------------------------------------ login

function viewLogin() {
  $view.innerHTML = `
    <div class="card stack">
      <h1>Creature League</h1>
      <p class="muted">Draft creatures, set your lineup on the stadium grid, and battle your league every week.</p>
      <label>Username <input id="u" autocomplete="username"></label>
      <label>Password <input id="p" type="password" autocomplete="current-password"></label>
      <div class="row"><button class="primary" id="login">Log in</button><button id="signup">Create account</button></div>
    </div>`;
  const go = (path) => async () => {
    try {
      S.me = (await POST(path, { username: $('#u').value, password: $('#p').value })).user;
      location.hash = '#/';
    } catch (e) { toast(e.message, true); }
  };
  $('#login').onclick = go('/api/login');
  $('#signup').onclick = go('/api/signup');
  $('#p').onkeydown = (e) => { if (e.key === 'Enter') go('/api/login')(); };
}
const $ = (sel) => $view.querySelector(sel);

// ------------------------------------------------------------------ home: leagues

async function viewHome() {
  const { leagues } = await GET('/api/leagues');
  const d = S.catalog.defaults;
  $view.innerHTML = `
    <h1>Your leagues</h1>
    ${leagues.length ? leagues.map((l) => `
      <a class="card" style="display:block;text-decoration:none;color:inherit" href="#/league/${l.id}">
        <div class="spread"><b>${esc(l.name)}</b><span class="chip">${statusText(l.status, l.currentWeek)}</span></div>
        <div class="small muted">${esc(l.teamName)} · ${l.managers} managers</div>
      </a>`).join('') : '<p class="muted">You are not in a league yet. Create one or join with a code.</p>'}
    <div class="card stack">
      <h2>Join a league</h2>
      <div class="grid2"><input id="code" placeholder="6-letter code"><input id="jteam" placeholder="Your team name"></div>
      <button id="join">Join</button>
    </div>
    <div class="card stack">
      <h2>Create a league</h2>
      <div class="grid2">
        <label>League name <input id="name" placeholder="Sunday League"></label>
        <label>Your team name <input id="team" placeholder="${esc(S.me.username)}'s team"></label>
        <label>Managers (2 to 6) <input id="mm" type="number" min="2" max="6" value="${d.maxManagers}"></label>
        <label>Roster size <input id="rs" type="number" min="4" max="15" value="${d.rosterSize}"></label>
        <label>Regular season weeks <input id="wk" type="number" min="1" max="20" value="${d.regularWeeks}"></label>
        <label>Weather <select id="wx"><option value="clear">Always clear</option><option value="random">Random each match</option></select></label>
        <label>Creature pool
          <select id="pr"><option value="all">Every creature</option><option value="tier:common">Common only</option><option value="tier:rare">Rare only</option><option value="habitats">Chosen habitats</option></select></label>
        <label>Stats used in battle
          <select id="su"><option value="drafted">The drafted copy's stats</option><option value="caught">Your own caught creature's stats</option></select></label>
      </div>
      <div id="habs" class="row" hidden>${S.catalog.habitats.map((h) => `<label class="row" style="margin:0"><input type="checkbox" value="${h}" style="width:auto"> ${title(h)}</label>`).join('')}</div>
      <label class="row" style="color:var(--ink)"><input type="checkbox" id="ra" checked style="width:auto"> Players can only field creatures they've caught or traded for</label>
      <p class="small muted">Battles are always 4 on 4. Each species appears 3 times in the pool with slightly different stats. Playoffs are 2 weeks.</p>
      <button class="primary" id="create">Create league</button>
    </div>`;
  $('#pr').onchange = () => { $('#habs').hidden = $('#pr').value !== 'habitats'; };
  $('#join').onclick = () => act(async () => {
    const { id } = await POST('/api/leagues/join', { code: $('#code').value, teamName: $('#jteam').value });
    location.hash = `#/league/${id}`;
  });
  $('#create').onclick = async () => {
    const pr = $('#pr').value;
    const poolRule = pr === 'all' ? { type: 'all' } : pr.startsWith('tier:') ? { type: 'tier', tier: pr.slice(5) }
      : { type: 'habitats', habitats: [...$view.querySelectorAll('#habs input:checked')].map((i) => i.value) };
    try {
      const { id } = await POST('/api/leagues', {
        name: $('#name').value, teamName: $('#team').value,
        settings: { maxManagers: $('#mm').value, rosterSize: $('#rs').value, regularWeeks: $('#wk').value, weather: $('#wx').value, poolRule, statsUsed: $('#su').value, requireAccess: $('#ra').checked },
      });
      location.hash = `#/league/${id}`;
    } catch (e) { toast(e.message, true); }
  };
}

function statusText(status, week) {
  return { setup: 'Waiting to draft', drafting: 'Drafting', season: `Week ${week}`, playoffs: 'Playoffs', done: 'Season over' }[status] || status;
}

// ------------------------------------------------------------------ collection and catching

async function viewCollection() {
  const { catches, encounter } = await GET('/api/collection');
  $view.innerHTML = `
    <h1>Catch creatures</h1>
    <p class="small muted">Stand-in for the open world: pick a biome to look for a wild creature. You get 3 tries before it runs. Catching a species gives you access to field it in leagues.</p>
    <div class="card">
      <div class="row">${S.catalog.biomes.map((b) => `<button data-biome="${b.id}">${esc(b.name)}</button>`).join('')}</div>
    </div>
    ${encounter ? `
      <div class="card stack">
        <div class="small muted">A wild creature appeared in the ${esc((S.catalog.biomes.find((b) => b.id === encounter.biome) || {}).name)}</div>
        ${creatureLine(encounter.species)}
        <div class="small">Attitude: <b>${title(encounter.attitude)}</b></div>
        ${statsRow(encounter.stats)}
        <div class="row"><button class="primary" id="throw">Try to catch (${encounter.attemptsLeft} left)</button><button id="leave">Leave it</button></div>
      </div>` : ''}
    <h2>Your collection (${catches.length})</h2>
    <div class="card"><ul class="list">${catches.length ? catches.map((c) => `
      <li>${creatureLine(c.species, `<span class="small muted">#${c.id}</span>`)}
        <div class="small">Attitude: <b>${title(c.attitude)}</b> · total ${statTotal(c.stats)} · ${c.source === 'trade' ? 'traded' : 'caught'}</div>
        ${statsRow(c.stats)}</li>`).join('') : '<li class="muted">Nothing yet. Go exploring.</li>'}</ul></div>`;
  $view.querySelectorAll('[data-biome]').forEach((b) => { b.onclick = () => act(() => POST('/api/explore', { biome: b.dataset.biome })); });
  if (encounter) {
    $('#throw').onclick = () => act(() => POST('/api/catch', { encounterId: encounter.id }), (r) => {
      const n = sp(r.species).name;
      return r.result === 'caught' ? `Caught ${n}!` : r.result === 'fled' ? `${n} ran away.` : `${n} broke free. ${r.attemptsLeft} tries left.`;
    });
    $('#leave').onclick = () => act(() => POST('/api/explore', { biome: encounter.biome }));
  }
}

// ------------------------------------------------------------------ trades

async function viewTrades() {
  const [{ trades }, { catches }] = await Promise.all([GET('/api/trades'), GET('/api/collection')]);
  const desc = (c) => (c ? `${esc(sp(c.species).name)} (${title(c.attitude)}, total ${statTotal(c.stats)})` : 'a creature that moved');
  $view.innerHTML = `
    <h1>Trades</h1>
    <div class="card stack">
      <h2>Propose a trade</h2>
      <div class="row"><input id="tradeTo" placeholder="Their username" style="flex:1"><button id="look">See their creatures</button></div>
      <div id="tradeform"></div>
    </div>
    <div class="card"><h2>Your trades</h2><ul class="list">${trades.length ? trades.map((t) => {
      const mine = t.from.id === S.me.id;
      const btns = t.status !== 'pending' ? `<span class="chip">${title(t.status)}</span>`
        : mine ? `<button class="small" data-t="${t.id}" data-a="cancel">Cancel</button>`
        : `<button class="small primary" data-t="${t.id}" data-a="accept">Accept</button> <button class="small" data-t="${t.id}" data-a="decline">Decline</button>`;
      return `<li><div class="spread"><div class="small">${mine ? `You offered <b>${esc(t.to.username)}</b>` : `<b>${esc(t.from.username)}</b> offered you`}
        ${desc(t.offer)} for ${desc(t.request)}</div><div>${btns}</div></div></li>`;
    }).join('') : '<li class="muted">No trades yet.</li>'}</ul></div>`;
  $view.querySelectorAll('[data-t]').forEach((b) => {
    b.onclick = () => act(() => POST(`/api/trades/${b.dataset.t}/${b.dataset.a}`), (r) => `Trade ${r.status}`);
  });
  $('#look').onclick = async () => {
    try {
      const them = await GET(`/api/players/${encodeURIComponent($('#tradeTo').value.trim())}/collection`);
      if (!catches.length) { $('#tradeform').innerHTML = '<p class="muted">Catch something first so you have a creature to offer.</p>'; return; }
      if (!them.catches.length) { $('#tradeform').innerHTML = '<p class="muted">They have no creatures yet.</p>'; return; }
      $('#tradeform').innerHTML = `
        <label>You give <select id="give">${catches.map((c) => `<option value="${c.id}">${desc(c)}</option>`).join('')}</select></label>
        <label>You get <select id="get">${them.catches.map((c) => `<option value="${c.id}">${desc(c)}</option>`).join('')}</select></label>
        <button class="primary" id="send">Send offer</button>`;
      $('#send').onclick = () => act(() => POST('/api/trades', { to: them.user.username, offerCatchId: Number($('#give').value), requestCatchId: Number($('#get').value) }), 'Offer sent');
    } catch (e) { toast(e.message, true); }
  };
}

// ------------------------------------------------------------------ field guide

function viewGuide() {
  const ch = S.catalog.elements;
  $view.innerHTML = `
    <h1>Field guide</h1>
    <div class="card small">
      <h3>Elements</h3>
      ${ch.elements.map((e) => `<div>${elChips([e])} strong against ${ch.strongAgainst[e].map((x) => elChips([x])).join(' ')}</div>`).join('')}
      <p class="muted">Strong hits do ×1.5, weak hits ×0.67. Rain boosts Tide, sun boosts Ember, snow boosts Frost, storms boost Volt. Ground-wave moves can't hit fliers, and only fliers can use perches. Large and huge creatures can't use cover.</p>
    </div>
    ${S.catalog.species.map((s) => `
      <div class="card">
        ${creatureLine(s.id)}
        <div class="small muted">Inspired by: ${esc(s.basedOn || '')} · usual attitude ${title(s.usualAttitude)}</div>
        ${statsRow(s.base)}
        <div class="small" style="margin-top:6px">${s.moves.map((m) => moveChip(m)).join(' ')}</div>
      </div>`).join('')}`;
}

function moveChip(id, label, extra = '') {
  const m = mv(id);
  const tip = `${m.name}: ${title(m.category)}, power ${m.power}, accuracy ${m.accuracy}, ${words(m.range)} ${words(m.area)}, stamina ${m.staminaCost}`;
  const cls = label ? `lbl-${label}` : `el el-${m.element}`;
  return `<span class="chip movechip ${cls} ${extra}" data-move="${id}" title="${esc(tip)}">${esc(m.name)}${label ? ` · ${label}` : ''}</span>`;
}

// ------------------------------------------------------------------ league

async function viewLeague(id, tab) {
  const st = await GET(`/api/leagues/${id}`);
  S.league = st;
  const L = st.league;
  tab = tab || (L.status === 'drafting' ? 'draft' : 'overview');
  const tabs = [['overview', 'Overview'], ['draft', 'Draft'], ['team', 'My team'], ['free', 'Free agents'], ['results', 'Results']];
  $view.innerHTML = `
    <div class="spread"><h1>${esc(L.name)}</h1><span class="chip">${statusText(L.status, L.currentWeek)}</span></div>
    <div class="tabs">${tabs.map(([k, n]) => `<a href="#/league/${id}/${k}" class="${k === tab ? 'on' : ''}">${n}</a>`).join('')}</div>
    <div id="pane"></div>`;
  const pane = $('#pane');
  if (tab === 'draft') return paneDraft(st, pane);
  if (tab === 'team') return paneTeam(st, pane);
  if (tab === 'free') return paneFree(st, pane);
  if (tab === 'results') return paneResults(st, pane);
  return paneOverview(st, pane);
}

function rulesSummary(s) {
  const pool = s.poolRule.type === 'all' ? 'every creature' : s.poolRule.type === 'tier' ? `${s.poolRule.tier} creatures only` : `habitats: ${s.poolRule.habitats.map(title).join(', ')}`;
  return `${s.maxManagers} managers max · roster ${s.rosterSize} · 4v4 · ${s.regularWeeks} weeks + 2 playoff weeks · pool: ${pool} · battles use ${s.statsUsed === 'caught' ? 'your own caught creature' : 'the drafted copy'} · ${s.requireAccess ? 'must have caught a species to field it' : 'any drafted creature can be fielded'} · weather ${s.weather}`;
}

function paneOverview(st, pane) {
  const L = st.league;
  const lid = L.id;
  const isC = st.me.isCommissioner;
  const champion = L.championId ? teamName(st, L.championId) : null;
  const unplayed = st.matchups.filter((m) => m.week === L.currentWeek && !m.played);
  pane.innerHTML = `
    ${champion ? `<div class="banner"><b>${esc(champion)}</b> won the league!</div>` : ''}
    ${L.status === 'drafting' ? `<div class="banner">The draft is on. ${st.draft.onTheClock === st.me.userId ? "<b>You're on the clock.</b>" : `${esc(teamName(st, st.draft.onTheClock))} is picking.`} <a href="#/league/${lid}/draft">Go to draft</a></div>` : ''}
    ${L.status === 'setup' ? `
      <div class="card stack">
        <h2>Invite managers</h2>
        <p>Share this code: <b style="font-size:1.3rem;letter-spacing:.1em">${esc(L.code)}</b></p>
        <p class="small muted">${st.members.length} of ${L.settings.maxManagers} managers. This pool holds ${L.poolSpecies} species (${L.poolSpecies * 3} creatures).</p>
        ${isC ? `<div class="row"><button id="bot">Add a bot</button><button id="fill">Fill with bots</button><button class="primary" id="start" ${st.members.length < 2 ? 'disabled' : ''}>Start the draft</button></div>` : '<p class="muted">Waiting for the commissioner to start the draft.</p>'}
      </div>` : ''}
    ${isC && ['season', 'playoffs'].includes(L.status) ? `
      <div class="card stack">
        <div class="spread"><b>${L.status === 'playoffs' ? 'Playoffs' : `Week ${L.currentWeek} of ${L.settings.regularWeeks}`}</b><span class="small muted">${unplayed.length} match${unplayed.length === 1 ? '' : 'es'} to play</span></div>
        <p class="small muted">Lineups lock when the week runs. Anyone without a saved lineup gets an automatic one.</p>
        <button class="primary" id="run">Play this week</button>
      </div>` : ''}
    ${['season', 'playoffs', 'done'].includes(L.status) ? `
      <div class="card"><h2>Standings</h2><table>
        <tr><th>#</th><th>Team</th><th class="num">W</th><th class="num">L</th><th class="num">Pts</th><th class="num">HP left</th></tr>
        ${st.standings.map((r, i) => `<tr class="${r.userId === st.me.userId ? 'me' : ''}"><td>${i + 1}</td><td>${esc(r.teamName)}</td><td class="num">${r.wins}</td><td class="num">${r.losses}</td><td class="num">${r.points}</td><td class="num">${Math.round(r.hpTotal / 40)}%</td></tr>`).join('')}
      </table><p class="small muted">3 points a win. Ties go to total HP left over the season. Top 4 make the playoffs.</p></div>` : ''}
    <div class="card"><h2>Managers</h2><ul class="list">${st.members.map((m) => `<li class="spread"><span class="${m.userId === st.me.userId ? 'me' : ''}">${esc(m.teamName)}</span><span class="small muted">${m.isBot ? 'bot' : esc(m.username)}${m.userId === L.commissionerId ? ' · commissioner' : ''}</span></li>`).join('')}</ul></div>
    <div class="card small"><h3>Rules</h3><p class="muted">${esc(rulesSummary(L.settings))}</p></div>
    <div class="card small"><h3>Activity</h3><ul class="list">${st.log.slice(0, 15).map((x) => `<li>${logLine(st, x)} <span class="muted">${esc(x.at)}</span></li>`).join('')}</ul></div>`;
  const on = (sel, fn) => { const el = pane.querySelector(sel); if (el) el.onclick = fn; };
  on('#bot', () => act(() => POST(`/api/leagues/${lid}/bots`, { count: 1 })));
  on('#fill', () => act(() => POST(`/api/leagues/${lid}/bots`, { count: 5 })));
  on('#start', () => act(async () => { await POST(`/api/leagues/${lid}/start-draft`); location.hash = `#/league/${lid}/draft`; }));
  on('#run', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Playing…';
    await act(() => POST(`/api/leagues/${lid}/run-week`), 'Week played. See the results tab.');
  });
}

function logLine(st, x) {
  const who = x.userId ? esc(teamName(st, x.userId)) : 'League';
  switch (x.kind) {
    case 'pick': return `${who} drafted ${esc(sp(x.detail.species).name)} (pick ${x.detail.pick})`;
    case 'waiver': return `${who} dropped ${esc(sp(x.detail.drop).name)} for ${esc(sp(x.detail.add).name)}`;
    case 'champion': return `${who} are champions`;
    case 'joined': return `${who} joined`;
    case 'created': return 'League created';
    case 'bots_added': return 'Bots joined';
    case 'draft_started': return 'The draft started';
    case 'season_started': return 'The season started';
    case 'playoffs': return 'The playoffs are set';
    default: return `${who}: ${esc(x.kind)}`;
  }
}

// ------------------------------------------------------------------ draft

function paneDraft(st, pane) {
  const L = st.league;
  if (L.status === 'setup') { pane.innerHTML = '<div class="card muted">The draft has not started yet.</div>'; return; }
  const myTurn = st.draft.onTheClock === st.me.userId;
  const access = new Set(st.me.access);
  const mine = st.pool.filter((p) => p.ownerId === st.me.userId);
  const avail = st.pool.filter((p) => p.ownerId == null);
  const filter = S.draftFilter || '';
  const shown = avail.filter((p) => !filter || sp(p.species).elements.includes(filter) || sp(p.species).habitat === filter)
    .sort((a, b) => statTotal(b.stats) - statTotal(a.stats));
  pane.innerHTML = `
    ${L.status === 'drafting' ? `
      <div class="banner">${myTurn ? "<b>You're on the clock.</b> Pick a creature." : `${esc(teamName(st, st.draft.onTheClock))} is picking.`}
        Pick ${st.draft.pick + 1} of ${st.draft.total}.</div>
      <div class="row" style="margin-bottom:12px">
        ${myTurn ? '<button id="auto">Pick best available for me</button>' : ''}
        ${!myTurn && st.me.isCommissioner ? '<button id="auto">Auto-pick for them</button>' : ''}
        <button id="refresh">Refresh</button>
      </div>` : '<div class="card">The draft is complete.</div>'}
    <div class="card small"><b>Your roster (${mine.length}/${L.settings.rosterSize})</b><div>${mine.map((p) => `<span class="chip">${esc(sp(p.species).name)}</span>`).join('') || '<span class="muted">Empty</span>'}</div></div>
    ${L.status === 'drafting' ? `
      <div class="row" style="margin-bottom:8px">
        <select id="flt" style="width:auto"><option value="">All available (${avail.length})</option>
          ${S.catalog.elements.elements.map((e) => `<option value="${e}" ${filter === e ? 'selected' : ''}>${title(e)}</option>`).join('')}
          ${S.catalog.habitats.map((h) => `<option value="${h}" ${filter === h ? 'selected' : ''}>${title(h)} habitat</option>`).join('')}
        </select>
      </div>
      <div class="card"><ul class="list">${shown.map((p) => `
        <li>${creatureLine(p.species, myTurn ? `<button class="small primary" data-pick="${p.id}">Draft</button>` : '')}
          <div class="small">Copy ${p.copy + 1} of 3 · <b>${title(p.attitude)}</b> · total ${statTotal(p.stats)} ${L.settings.requireAccess && !access.has(p.species) ? '· <span style="color:var(--warn)">not caught yet</span>' : ''}</div>
          ${statsRow(p.stats)}</li>`).join('')}</ul></div>` : ''}
    <div class="card small"><h3>Draft board</h3><ul class="list">${st.pool.filter((p) => p.draftedPick).sort((a, b) => b.draftedPick - a.draftedPick).map((p) => `<li>${p.draftedPick}. ${esc(teamName(st, p.ownerId))}: ${esc(sp(p.species).name)}</li>`).join('') || '<li class="muted">No picks yet</li>'}</ul></div>`;
  const lid = L.id;
  const auto = pane.querySelector('#auto');
  if (auto) auto.onclick = () => act(() => POST(`/api/leagues/${lid}/autopick`));
  const ref = pane.querySelector('#refresh');
  if (ref) ref.onclick = () => route();
  const flt = pane.querySelector('#flt');
  if (flt) flt.onchange = () => { S.draftFilter = flt.value; paneDraft(st, pane); };
  pane.querySelectorAll('[data-pick]').forEach((b) => { b.onclick = () => act(() => POST(`/api/leagues/${lid}/pick`, { poolId: Number(b.dataset.pick) })); });
}

// ------------------------------------------------------------------ my team: lineup editor

async function paneTeam(st, pane) {
  const L = st.league;
  if (!['season', 'playoffs', 'done'].includes(L.status)) { pane.innerHTML = '<div class="card muted">Lineups open once the draft is done.</div>'; return; }
  const data = await GET(`/api/leagues/${L.id}/lineup`);
  if (!S.lineup || S.lineup.leagueId !== L.id) {
    S.lineup = { leagueId: L.id, members: data.lineup ? data.lineup.members.map((m) => ({ ...m })) : [], dirty: false, auto: data.auto };
    S.sel = null;
    S.advice = {};
    if (data.roster.length) {
      GET(`/api/leagues/${L.id}/advice?poolIds=${data.roster.map((p) => p.id).join(',')}`)
        .then((r) => { for (const a of r.advice) S.advice[a.poolId] = a.moves; renderTeam(st, data, pane); })
        .catch(() => {});
    }
  }
  renderTeam(st, data, pane);
}

function renderTeam(st, data, pane) {
  const L = st.league;
  const stadium = S.catalog.stadiums.find((s) => s.id === L.settings.stadium);
  const access = new Set(st.me.access);
  const playable = (p) => !L.settings.requireAccess || access.has(p.species);
  const lu = S.lineup;
  const byId = new Map(data.roster.map((p) => [p.id, p]));
  const at = (col, row) => lu.members.find((m) => m.col === col && m.row === row);
  const selEntry = S.sel != null ? byId.get(S.sel) : null;
  const editable = L.status !== 'done';

  const spotHtml = (col, row) => {
    const type = stadium.spots.find((s) => s.col === col && s.row === row).type;
    const m = at(col, row);
    let cls = `spot t-${type}`;
    if (m) cls += ' filled';
    else if (selEntry) cls += canStandOn(sp(selEntry.species), type) ? ' legal' : ' illegal';
    return `<div class="${cls}" data-col="${col}" data-row="${row}"><span class="type">${words(type)}</span>${m ? `<b>${esc(sp(byId.get(m.poolId).species).name)}</b><span class="small muted">${m.tactic}</span>` : '<span class="muted small">empty</span>'}</div>`;
  };

  pane.innerHTML = `
    ${L.settings.requireAccess && !data.roster.some(playable) ? `<div class="banner">You haven't caught any of your drafted species yet, so you can't field them. <a href="#/collection">Go catch some</a>.</div>` : ''}
    <div class="card">
      <div class="spread"><h2>Lineup</h2>${lu.dirty ? '<span class="chip">Unsaved</span>' : !lu.members.length ? '<span class="chip">Not set</span>' : lu.auto ? '<span class="chip">Automatic</span>' : '<span class="chip">Saved</span>'}</div>
      <p class="small muted">${editable ? 'Tap a creature below, then tap a spot. Tap a placed creature to take it off.' : 'The season is over.'} ${esc(stadium.name)}: the front row is closest to the opponent.</p>
      <div class="field">
        <div class="hdr">Back row</div><div class="hdr">Front row →</div>
        ${[0, 1, 2].map((row) => spotHtml(0, row) + spotHtml(1, row)).join('')}
      </div>
      ${editable ? `<div class="row" style="margin-top:10px">
        <button class="primary" id="save" ${lu.members.length !== 4 ? 'disabled' : ''}>Save lineup</button>
        <button id="rec" ${data.recommended ? '' : 'disabled'}>Use recommended</button>
        <button id="clear">Clear</button></div>` : ''}
    </div>
    ${lu.members.length ? `<div class="card"><h3>Tactics and moves</h3>
      <p class="small muted">Labels are scored against your next opponent. Tap moves to limit what a creature uses; with none picked it uses all its moves sensibly.</p>
      <ul class="list">${lu.members.map((m, i) => {
        const p = byId.get(m.poolId);
        const s = sp(p.species);
        const adv = S.advice[p.id];
        const moves = adv ? adv : s.moves.map((id) => ({ move: id }));
        return `<li><div class="spread"><b>${esc(s.name)}</b>
          <select data-tactic="${i}" style="width:auto" ${editable ? '' : 'disabled'}>${S.catalog.tactics.map((t) => `<option ${t === m.tactic ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
          <div style="margin-top:6px">${moves.map((x) => moveChip(x.move, x.label, `${m.movePlan.includes(x.move) ? 'inplan' : ''}" data-member="${i}`)).join(' ')}</div></li>`;
      }).join('')}</ul></div>` : ''}
    <div class="card"><h3>Roster</h3><ul class="list">${data.roster.map((p) => {
      const inLu = lu.members.some((m) => m.poolId === p.id);
      const ok = playable(p);
      return `<li class="pick ${S.sel === p.id ? 'sel' : ''} ${ok ? '' : 'off'}" data-sel="${p.id}" style="cursor:${ok && editable ? 'pointer' : 'default'}">
        ${creatureLine(p.species, inLu ? '<span class="chip">In lineup</span>' : ok ? '' : '<span class="chip">Not caught</span>')}
        <div class="small">${title(p.attitude)} · total ${statTotal(p.stats)}</div>${statsRow(p.stats)}</li>`;
    }).join('')}</ul></div>`;

  if (!editable) return;
  const rerender = () => renderTeam(st, data, pane);
  pane.querySelectorAll('[data-sel]').forEach((li) => {
    li.onclick = () => {
      const p = byId.get(Number(li.dataset.sel));
      if (!playable(p)) { toast(`You need to catch a ${sp(p.species).name} before you can field it.`, true); return; }
      S.sel = S.sel === p.id ? null : p.id;
      rerender();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
  });
  pane.querySelectorAll('.spot').forEach((el) => {
    el.onclick = () => {
      const col = Number(el.dataset.col);
      const row = Number(el.dataset.row);
      const here = at(col, row);
      if (here && S.sel == null) { lu.members = lu.members.filter((m) => m !== here); lu.dirty = true; return rerender(); }
      if (S.sel == null) return toast('Pick a creature from your roster first.');
      const type = stadium.spots.find((s) => s.col === col && s.row === row).type;
      const p = byId.get(S.sel);
      if (!canStandOn(sp(p.species), type)) return toast(`${sp(p.species).name} can't stand on ${words(type)}.`, true);
      const existing = lu.members.find((m) => m.poolId === p.id);
      if (here) lu.members = lu.members.filter((m) => m !== here);
      if (existing) { existing.col = col; existing.row = row; }
      else {
        if (lu.members.length >= 4) return toast('A lineup has 4 creatures. Take one off first.', true);
        lu.members.push({ poolId: p.id, col, row, tactic: 'aggressive', movePlan: [] });
      }
      S.sel = null;
      lu.dirty = true;
      rerender();
    };
  });
  pane.querySelectorAll('[data-tactic]').forEach((sel) => {
    sel.onchange = () => { lu.members[Number(sel.dataset.tactic)].tactic = sel.value; lu.dirty = true; rerender(); };
  });
  pane.querySelectorAll('[data-member]').forEach((chip) => {
    chip.onclick = () => {
      const m = lu.members[Number(chip.dataset.member)];
      const id = chip.dataset.move;
      m.movePlan = m.movePlan.includes(id) ? m.movePlan.filter((x) => x !== id) : [...m.movePlan, id];
      lu.dirty = true;
      rerender();
    };
  });
  pane.querySelector('#clear').onclick = () => { lu.members = []; lu.dirty = true; S.sel = null; rerender(); };
  pane.querySelector('#rec').onclick = () => {
    lu.members = data.recommended.members.map((m) => ({ ...m, movePlan: [] }));
    lu.dirty = true;
    rerender();
  };
  pane.querySelector('#save').onclick = async () => {
    try {
      const r = await api('PUT', `/api/leagues/${L.id}/lineup`, { members: lu.members });
      lu.members = r.lineup.members;
      lu.dirty = false;
      lu.auto = false;
      toast('Lineup saved');
      rerender();
    } catch (e) { toast(e.message, true); }
  };
}

// ------------------------------------------------------------------ free agents

function paneFree(st, pane) {
  const L = st.league;
  if (!['season', 'playoffs'].includes(L.status)) { pane.innerHTML = '<div class="card muted">Free agents open during the season.</div>'; return; }
  const mine = st.pool.filter((p) => p.ownerId === st.me.userId);
  const avail = st.pool.filter((p) => p.ownerId == null).sort((a, b) => statTotal(b.stats) - statTotal(a.stats));
  pane.innerHTML = `
    <div class="card stack"><h3>Drop</h3>
      <select id="drop">${mine.map((p) => `<option value="${p.id}">${esc(sp(p.species).name)} (${title(p.attitude)}, total ${statTotal(p.stats)})</option>`).join('')}</select>
      <p class="small muted">Pick who to release, then tap Add on a free agent. Swaps happen right away.</p></div>
    <div class="card"><h3>Available (${avail.length})</h3><ul class="list">${avail.map((p) => `
      <li>${creatureLine(p.species, `<button class="small" data-add="${p.id}">Add</button>`)}
      <div class="small">${title(p.attitude)} · total ${statTotal(p.stats)}</div>${statsRow(p.stats)}</li>`).join('') || '<li class="muted">Every creature is on a roster.</li>'}</ul></div>`;
  pane.querySelectorAll('[data-add]').forEach((b) => {
    b.onclick = () => act(() => POST(`/api/leagues/${L.id}/waiver`, { dropPoolId: Number($('#drop').value), addPoolId: Number(b.dataset.add) }), 'Roster updated');
  });
  S.lineup = null; // the roster may change, so reload the lineup next time
}

// ------------------------------------------------------------------ results

function paneResults(st, pane) {
  const weeks = [...new Set(st.matchups.map((m) => m.week))].sort((a, b) => b - a);
  const kindName = { regular: '', semi: 'Semifinal · ', final: 'Final · ' };
  pane.innerHTML = weeks.length ? weeks.map((w) => `
    <div class="card"><h3>Week ${w}</h3><ul class="list">${st.matchups.filter((m) => m.week === w).map((m) => {
      const home = teamName(st, m.homeId);
      const away = m.awayId ? teamName(st, m.awayId) : null;
      if (!away) return `<li class="small">${esc(home)} has a bye</li>`;
      const win = m.winnerId;
      const res = !m.played ? '<span class="muted">to play</span>'
        : m.reason === 'knockout' || m.reason === 'round_limit' || m.reason === 'tiebreak'
          ? `<a href="#/matchup/${m.id}">Watch replay</a>` : `<span class="muted">${words(m.reason)}</span>`;
      const mark = (uid, name) => `<span class="${uid === win ? 'me' : ''} ${uid === st.me.userId ? '' : ''}">${esc(name)}</span>`;
      return `<li><div class="spread"><div class="small">${kindName[m.kind]}${mark(m.homeId, home)} vs ${mark(m.awayId, away)}
        ${m.played && m.homeHp != null ? `<div class="muted">${Math.round(m.homeHp / 40)}% to ${Math.round(m.awayHp / 40)}% HP left · ${m.rounds} rounds · ${words(m.reason)}</div>` : ''}</div>${res}</div></li>`;
    }).join('')}</ul></div>`).join('') : '<div class="card muted">The schedule appears once the draft is done.</div>';
}

// ------------------------------------------------------------------ replay viewer

let replayTimer = null;
function stopReplay() { clearInterval(replayTimer); replayTimer = null; }

async function viewMatchup(id) {
  const mu = await GET(`/api/matchups/${id}`);
  const r = mu.replay;
  if (!r) { $view.innerHTML = `<div class="card">No replay for this match (${words(mu.reason)}). <a href="#/league/${mu.leagueId}/results">Back</a></div>`; return; }
  const units = {};
  r.teams.forEach((t, side) => t.members.forEach((m) => {
    units[m.uid] = { uid: m.uid, side, name: m.name, max: m.individual.stats.hp, hp: m.individual.stats.hp, spot: m.spot, down: false };
  }));
  S.replay = { r, units, i: 0, mu };
  $view.innerHTML = `
    <a href="#/league/${mu.leagueId}/results" class="small">← Results</a>
    <h1><span class="s0">${esc(r.teams[0].name)}</span> vs <span class="s1">${esc(r.teams[1].name)}</span></h1>
    <p class="small muted">${esc(r.stadium.name)} · ${title(r.weather)} · seed ${r.seed}${r.autoLineups && r.autoLineups.some(Boolean) ? ' · automatic lineup used' : ''}</p>
    <div class="card"><div class="teams" id="teams"></div></div>
    <div class="row" style="margin-bottom:12px">
      <button class="primary" id="play">Play</button><button id="step">Next</button><button id="end">Skip to end</button>
      <select id="speed" style="width:auto"><option value="900">Slow</option><option value="450" selected>Normal</option><option value="150">Fast</option></select>
    </div>
    <div class="card"><div class="log" id="log"></div></div>`;
  drawUnits();
  $('#step').onclick = () => { stopReplay(); stepReplay(); };
  $('#end').onclick = () => { stopReplay(); while (stepReplay()); };
  $('#play').onclick = () => {
    if (replayTimer) { stopReplay(); $('#play').textContent = 'Play'; return; }
    $('#play').textContent = 'Pause';
    replayTimer = setInterval(() => { if (!stepReplay()) { stopReplay(); $('#play').textContent = 'Play'; } }, Number($('#speed').value));
  };
}

function drawUnits(active) {
  const { r, units } = S.replay;
  const el = document.getElementById('teams');
  if (!el) return;
  el.innerHTML = r.teams.map((t, side) => `<div><b class="small s${side}">${esc(t.name)}</b>${t.members.map((m) => {
    const u = units[m.uid];
    const pct = Math.max(0, Math.round((u.hp / u.max) * 100));
    return `<div class="unit ${u.down ? 'down' : ''} ${active === u.uid ? 'active' : ''}"><div class="spread"><span class="nm">${esc(u.name)}</span><span class="muted">${u.hp}/${u.max}</span></div>
      <div class="bar ${pct < 30 ? 'low' : ''}"><i style="width:${pct}%"></i></div><div class="muted" style="font-size:.7rem">${words(u.spot.type)}</div></div>`;
  }).join('')}</div>`).join('');
}

function stepReplay() {
  const R = S.replay;
  if (!R || R.i >= R.r.events.length) return false;
  const e = R.r.events[R.i++];
  const log = document.getElementById('log');
  if (!log) return false;
  const u = R.units;
  const nm = (uid) => (u[uid] ? `<span class="s${u[uid].side}">${esc(u[uid].name)}</span>` : esc(uid));
  let line = '';
  let cls = '';
  switch (e.type) {
    case 'round_start': line = `Round ${e.round} · ${title(e.weather)}`; cls = 'round'; break;
    case 'move': {
      const parts = (e.targets || []).map((t) => {
        if (t.target && u[t.target] && t.hpAfter != null) u[t.target].hp = t.hpAfter;
        if (t.hit === false) return `misses ${nm(t.target)}`;
        if (t.damage != null) {
          const eff = t.typeModPermille > 1000 ? ' It hits hard!' : t.typeModPermille < 1000 ? ' Not very effective.' : '';
          return `hits ${nm(t.target)} for ${t.damage}${t.crit ? ' (critical)' : ''}${eff}${t.status ? ` ${nm(t.target)} is ${t.status === 'snare' ? 'snared' : t.status === 'slow' ? 'slowed' : t.status === 'blind' ? 'blinded' : t.status === 'burn' ? 'burned' : 'poisoned'}.` : ''}`;
        }
        if (t.healed != null) return `heals ${nm(t.target)} by ${t.healed}`;
        if (t.shield != null) return `shields ${nm(t.target)}`;
        if (t.buff) return `boosts ${nm(t.target)}'s ${t.buff}`;
        if (t.weather) return `changes the weather to ${t.weather}`;
        return nm(t.target);
      });
      line = `${nm(e.actor)} uses <b>${esc(e.moveName)}</b>${parts.length ? `: ${parts.join('; ')}` : ''}`;
      if (e.hype >= 4) cls = 'big';
      break;
    }
    case 'reposition': if (u[e.actor]) u[e.actor].spot = e.to; line = `${nm(e.actor)} moves to ${words(e.to.type)}`; break;
    case 'rest': line = `${nm(e.actor)} rests (+${e.gained} stamina)`; break;
    case 'distracted': line = `${nm(e.actor)} is too wild to listen and wastes its turn`; break;
    case 'terrain_change': line = `The ground changes from ${words(e.from)} to ${words(e.to)}`; break;
    case 'tick': if (u[e.actor]) u[e.actor].hp = e.hpAfter; line = `${nm(e.actor)} takes ${e.damage} from ${words(e.cause)}`; break;
    case 'faint': if (u[e.actor]) { u[e.actor].down = true; u[e.actor].hp = 0; } line = `<b>${nm(e.actor)} faints!</b>`; cls = 'big'; break;
    case 'battle_end': line = `<b class="s${e.winner}">${esc(R.r.teams[e.winner].name)} win</b> (${words(e.reason)})`; cls = 'round'; break;
    default: line = esc(e.type);
  }
  const p = document.createElement('p');
  p.className = cls;
  p.innerHTML = line;
  log.appendChild(p);
  log.scrollTop = log.scrollHeight;
  drawUnits(e.actor);
  return R.i < R.r.events.length;
}

route();
