/* Mentat.

   Tijdens het rekenen praat deze module nooit met de database: alles gaat naar
   een lokale log en pas aan het eind van een sessie de wachtrij in. Wat de app
   wél uit de database haalt is het bord (statistiek per som) en dat gebeurt bij
   het laden en na afloop van een sessie. */

import { MODES, PRESETS, rnd, pick, eligible } from './modes.js';
import * as db from './db.js';

const $ = id => document.getElementById(id);
const mem = {};
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return k in mem ? mem[k] : d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { mem[k] = v; } }
};
const clone = o => JSON.parse(JSON.stringify(o));
/* Nederlandse schrijfwijze: 24,0 in plaats van 24.0 */
const nl = (n, d = 1) => (Number(n) || 0).toFixed(d).replace('.', ',');

/* board: problem_key -> rij uit problem_board. Leeg tot je ingelogd bent. */
let board = new Map();
let families = [];
let customPresets = [];

/* ---------------------------------------------------------- instellingen */

/* Vult ontbrekende modi en velden aan, zodat een opgeslagen configuratie na
   een update van de app niet stukloopt. */
function fillGaps(conf, wide) {
  for (const k in MODES) {
    conf[k] = conf[k] || { on: wide ? 1 : 0 };
    MODES[k].fields.forEach(([f, , lo, hi]) => {
      if (!Array.isArray(conf[k][f])) conf[k][f] = wide ? [1, 9999] : [lo, hi];
    });
    (MODES[k].selects || []).forEach(([s, , v]) => {
      if (conf[k][s] == null) conf[k][s] = wide ? 0 : v[0];
    });
  }
  return conf;
}

let cfg = store.get('rt_cfg', null);
if (!cfg) {
  cfg = fillGaps({}, false);
  Object.assign(cfg, clone(PRESETS.zetamac.cfg));
}
fillGaps(cfg, false);

/* Het filter op het statistiekenscherm begint bewust wijd: je wil daar eerst
   alles zien wat je ooit gedaan hebt, en dan zelf inzoomen. */
let filterCfg = fillGaps(store.get('rt_filter', null) || {}, true);

const opt = store.get('rt_opt', { dur: 120, weighted: 1, auto: 1, tol: 1, pad: 'auto', preset: '' });

// begininstelling meteen vastleggen, zodat wat je ziet ook is wat er opgeslagen staat
store.set('rt_cfg', cfg);
store.set('rt_filter', filterCfg);
store.set('rt_opt', opt);

['dur', 'weighted', 'auto', 'tol', 'pad'].forEach(k => {
  $(k).value = opt[k];
  $(k).onchange = () => { opt[k] = $(k).value; store.set('rt_opt', opt); };
});

const show = id => ['boot', 'auth', 'setup', 'session', 'results', 'stats']
  .forEach(s => $(s).style.display = s === id ? 'block' : 'none');

/* ------------------------------------------------------------- inloggen */

async function boot() {
  const user = await db.currentUser();
  if (!user) { show('auth'); return; }
  show('setup');
  await refreshModel();
  await refreshBoard();
  await refreshPresets();
  syncStatus();
  db.flushOutbox().then(syncStatus);
}

$('doLogin').onclick = async () => {
  $('authErr').textContent = ''; $('authNote').textContent = 'Bezig...';
  try {
    await db.signIn($('email').value.trim(), $('pw').value);
    $('authNote').textContent = '';
    boot();
  } catch (e) {
    $('authNote').textContent = '';
    $('authErr').textContent = e.message === 'Invalid login credentials'
      ? 'E-mailadres of wachtwoord klopt niet.' : e.message;
  }
};

$('doSignup').onclick = async () => {
  $('authErr').textContent = ''; $('authNote').textContent = 'Bezig...';
  try {
    await db.signUp($('email').value.trim(), $('pw').value);
    $('authNote').textContent = 'Account aangemaakt. Bevestig eventueel je e-mail en log daarna in.';
  } catch (e) {
    $('authNote').textContent = '';
    $('authErr').textContent = e.message;
  }
};

$('doLogout').onclick = async () => { await db.signOut(); show('auth'); };

/* ------------------------------------------------------ modelparameters */

/* Hoe snel je wil zijn voordat een som als beheerst geldt is een keuze, geen
   meting. Die staat daarom in de database naast de gefitte waarden, zodat hij
   op je telefoon hetzelfde is. De andere drie ijkt de app zelf. */
let modelParams = null;

async function refreshModel() {
  try {
    modelParams = await db.loadModelParams();
    if (modelParams && modelParams.target != null) {
      $('target').value = String(+modelParams.target);
    }
  } catch { modelParams = null; }
}

$('target').onchange = async () => {
  try {
    await db.saveTarget(+$('target').value);
    await refreshModel();
    await refreshBoard();
  } catch (e) {
    $('setupErr').textContent = 'Doeltijd opslaan mislukt: ' + e.message;
  }
};

/* ---------------------------------------------------------------- bord */

async function refreshBoard() {
  try {
    const rows = await db.loadBoard();
    board = new Map(rows.map(r => [r.problem_key, r]));
    const n = rows.reduce((s, r) => s + r.n, 0);
    $('totalDone').textContent = n ? `${n} sommen gedaan` : '';
  } catch (e) {
    console.warn('bord laden mislukt', e);
  }
  renderModes();
}

function syncStatus() {
  const left = db.outboxSize();
  $('syncDot').className = 'dot' + (left ? ' pending' : '');
  $('syncText').textContent = left
    ? `${left} sessie${left > 1 ? 's' : ''} wacht op verbinding`
    : 'gesynchroniseerd';
}

/* ------------------------------------------------------------- presets */

async function refreshPresets() {
  try { customPresets = await db.loadPresets(); } catch { customPresets = []; }
  renderPresets();
}

function applyPreset(conf, dur, label) {
  for (const k in cfg) cfg[k].on = 0;
  const c = clone(conf);
  for (const k in c) if (cfg[k]) Object.assign(cfg[k], c[k]);
  if (dur != null) { opt.dur = String(dur); $('dur').value = opt.dur; }
  opt.preset = label;
  store.set('rt_cfg', cfg); store.set('rt_opt', opt);
  renderModes();
}

function renderPresets() {
  const box = $('presets'); box.innerHTML = '';

  for (const p in PRESETS) {
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = PRESETS[p].label;
    b.onclick = () => applyPreset(PRESETS[p].cfg, PRESETS[p].dur, PRESETS[p].label);
    box.appendChild(b);
  }

  for (const p of customPresets) {
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = p.name;
    b.onclick = () => applyPreset(p.config, p.limit_s, p.name);
    box.appendChild(b);

    const x = document.createElement('button');
    x.className = 'chip del'; x.textContent = '×';
    x.title = `${p.name} verwijderen`;
    x.onclick = async () => {
      if (!confirm(`Preset "${p.name}" verwijderen?`)) return;
      try { await db.deletePreset(p.id); await refreshPresets(); }
      catch (e) { alert('Verwijderen mislukt: ' + e.message); }
    };
    box.appendChild(x);
  }
}

$('savePreset').onclick = async () => {
  const on = activeModes();
  if (!on.length) { $('setupErr').textContent = 'Zet eerst een oefening aan.'; return; }
  const name = (prompt('Naam voor deze preset?') || '').trim();
  if (!name) return;
  // alleen de aangezette modi bewaren, net als bij de ingebouwde presets
  const conf = Object.fromEntries(on.map(k => [k, clone(cfg[k])]));
  try {
    await db.savePreset(name, conf, +opt.dur);
    opt.preset = name; store.set('rt_opt', opt);
    await refreshPresets();
  } catch (e) {
    alert('Opslaan mislukt: ' + e.message);
  }
};

/* ------------------------------------------------------- setup renderen */

/* Eén renderer voor de modus-kaarten, gebruikt door zowel de oefeninstellingen
   als het filter op het statistiekenscherm. In het filter mag een keuzelijst
   ook "alle" zijn, wat als 0 wordt opgeslagen. */
function renderModeCards(box, conf, { onChange, anyBase = false } = {}) {
  box.innerHTML = '';
  const changed = () => { if (onChange) onChange(); };

  for (const k in MODES) {
    const m = MODES[k], c = conf[k];
    const card = document.createElement('div');
    card.className = 'card' + (c.on ? ' on' : '');

    const head = document.createElement('label');
    head.className = 'mode-head';
    head.innerHTML = `<input type="checkbox" ${c.on ? 'checked' : ''}>
      <span class="mode-name">${m.label}</span><span class="mode-hint">${m.hint}</span>`;
    head.querySelector('input').onchange = e => {
      c.on = e.target.checked ? 1 : 0;
      card.classList.toggle('on', !!c.on);
      changed();
    };
    card.appendChild(head);

    const f = document.createElement('div'); f.className = 'fields';
    m.fields.forEach(([key, label]) => {
      const row = document.createElement('div'); row.className = 'frow';
      row.innerHTML = `<label>${label}</label>
        <input type="number" inputmode="numeric" value="${c[key][0]}">
        <span class="dash">tot</span>
        <input type="number" inputmode="numeric" value="${c[key][1]}">`;
      const [lo, hi] = row.querySelectorAll('input');
      const save = () => {
        const a = +lo.value || 0, b = +hi.value || 0;
        c[key] = [Math.min(a, b), Math.max(a, b)];
        changed();
      };
      lo.onchange = save; hi.onchange = save;
      f.appendChild(row);
    });

    (m.selects || []).forEach(([key, label, vals]) => {
      const row = document.createElement('div'); row.className = 'frow';
      const options = (anyBase ? [[0, 'alle']] : []).concat(vals.map(v => [v, v]));
      row.innerHTML = `<label>${label}</label><select>${options.map(([v, t]) =>
        `<option value="${v}" ${c[key] == v ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
      row.querySelector('select').onchange = e => { c[key] = +e.target.value; changed(); };
      f.appendChild(row);
    });

    card.appendChild(f); box.appendChild(card);
  }
}

function renderModes() {
  renderModeCards($('modes'), cfg, {
    onChange: () => {
      opt.preset = '';
      store.set('rt_opt', opt);
      store.set('rt_cfg', cfg);
    }
  });
}

/* Leesbare omschrijving van een configuratie, voor het sessieoverzicht. */
function describeConfig(conf) {
  const out = [];
  for (const k in (conf || {})) {
    const c = conf[k], m = MODES[k];
    if (!c || !c.on || !m) continue;
    const ranges = m.fields
      .map(([n]) => Array.isArray(c[n]) ? `${c[n][0]}-${c[n][1]}` : null)
      .filter(Boolean).join(' × ');
    const sel = (m.selects || [])
      .map(([n]) => c[n] ? `tot ${c[n]}` : null).filter(Boolean).join(' ');
    out.push(`${m.label} ${[ranges, sel].filter(Boolean).join(' ')}`.trim());
  }
  return out;
}

function durLabel(limitS, elapsedS) {
  if (limitS > 0) {
    return limitS % 60 === 0 ? `${limitS / 60} min` : `${limitS} sec`;
  }
  const s = Math.round(+elapsedS || 0);
  return s >= 60 ? `${Math.round(s / 60)} min, geen limiet` : `${s} sec, geen limiet`;
}

/* ------------------------------------------------------------- trekking */

const activeModes = (conf = cfg) => Object.keys(MODES).filter(k => conf[k] && conf[k].on);

/* Gewicht bij het vers trekken: hoe ver je voorspeld boven je doeltijd zit.
   Fouten zitten hier al in verwerkt, want een fout antwoord telt in het model
   als een mislukte ophaling en dus als een trage. Een onbekende som weegt als
   een gemiddelde bekende som, zodat nieuw materiaal blijft langskomen. */
function weightOf(key) {
  const r = board.get(key);
  if (!r || !r.n) return 2.5;
  const u = r.urgency != null ? +r.urgency : 1;
  return Math.min(12, Math.max(0.4, u * 2.5));
}

function generate(conf) {
  const modes = activeModes(conf);
  const make = () => { const k = pick(modes); const q = MODES[k].gen(conf[k]); q.mode = k; return q; };
  if (opt.weighted !== '1' && opt.weighted !== 1) return make();
  // Eén op de tien volledig willekeurig, zonder weging. De planner kiest anders
  // zelf wat je ziet en leert daarna alleen van wat hij koos: een som waarvan
  // hij ten onrechte denkt dat je hem kent, komt dan nooit langs om dat te
  // weerleggen. Dit houdt de metingen eerlijk.
  if (Math.random() < 0.1) return make();
  const cands = [make(), make(), make(), make(), make(), make()];
  const w = cands.map(c => weightOf(c.key));
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < cands.length; i++) { r -= w[i]; if (r <= 0) return cands[i]; }
  return cands[0];
}

/* Een som terugbouwen uit opgeslagen operanden, voor herhalingen en stampen. */
function fromRow(row) {
  const m = MODES[row.mode];
  if (!m) return null;
  const b = m.build(row.g1, row.g2, row.base);
  return {
    q: b.q, ans: b.ans, dec: b.dec, key: row.problem_key,
    mode: row.mode, g1: row.g1, g2: row.g2, base: row.base
  };
}

/* ------------------------------------------------------------- sessie */

let cur = null, typed = '', t0 = 0, tStart = 0, limit = 0, timer = null;
let log = [], goed = 0, fout = 0, running = false, answered = 0;
let modeCounts = {}, localDue = [], dueQueue = [], isDrill = false;
let hiddenAt = 0, interrupted = false, sessionId = '';
let pendingTimeout = null, scope = null, countTimer = null, lastWasRepeat = false;

function wantPad() {
  if (opt.pad === '1') return true;
  if (opt.pad === '0') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

function buildPad() {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '←'];
  $('keypad').innerHTML = '';
  if (!wantPad()) { $('keypad').style.display = 'none'; return; }
  $('keypad').style.display = 'grid';
  keys.forEach(k => {
    const b = document.createElement('button');
    b.className = 'key'; b.textContent = k;
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => press(k === '←' ? 'Backspace' : k);
    $('keypad').appendChild(b);
  });
  // Zonder deze toets kun je op een telefoon geen antwoord inleveren zodra
  // "doorgaan zodra het antwoord klopt" uitstaat.
  const ok = document.createElement('button');
  ok.className = 'key ok'; ok.textContent = 'OK';
  ok.onmousedown = e => e.preventDefault();
  ok.onclick = () => press('Enter');
  $('keypad').appendChild(ok);
}

/* drill: alleen je zwakste sommen. scopeCfg beperkt waaruit getrokken wordt;
   zo kun je gericht één categorie stampen in plaats van alles door elkaar. */
function startSession(drill, scopeCfg) {
  cancelCountdown();
  scope = scopeCfg || cfg;
  const modes = activeModes(scope);
  // foutmelding op het scherm waar je vandaan kwam, niet altijd bij de instellingen
  const onStats = $('stats').style.display === 'block';
  const err = (onStats && $('sErr')) || $('setupErr');
  err.textContent = '';
  if (!modes.length) {
    err.textContent = 'Zet minstens één oefening aan.';
    return;
  }

  isDrill = !!drill;
  dueQueue = [];
  if (isDrill) {
    dueQueue = [...board.values()]
      .filter(r => r.n >= 1 && eligible(r, scope))
      .sort((a, b) => (b.expected_rel ?? 0) - (a.expected_rel ?? 0))
      .slice(0, 60);
    if (!dueQueue.length) {
      err.textContent = 'Nog geen historie binnen deze selectie. Doe eerst een gewone sessie.';
      return;
    }
  } else {
    // Sommen die volgens de kansen-klok toe zijn aan een herhaling.
    dueQueue = [...board.values()]
      .filter(r => r.is_due && eligible(r, scope))
      .sort((a, b) => (b.urgency ?? 0) - (a.urgency ?? 0));
  }

  limit = +opt.dur; log = []; goed = 0; fout = 0; running = false;
  answered = 0; modeCounts = {}; localDue = []; interrupted = false; hiddenAt = 0;
  lastWasRepeat = false;
  sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  tStart = Date.now();
  $('fill').style.width = '100%';
  document.querySelectorAll('.tick').forEach(t => t.remove());
  $('score').textContent = '0';
  buildPad(); show('session');

  // Even aftellen, anders zit de tijd waarin je nog naar het scherm kijkt in de
  // meting van je eerste som. Dat is bij elke sessie dezelfde vertekening, in
  // precies het getal waar de hele planning op draait.
  countdown(() => {
    running = true;
    tStart = Date.now();
    askNew();
    timer = setInterval(tick, 100);
    tick();
  });
}

function countdown(then) {
  let n = 3;
  $('a').textContent = ''; $('flash').textContent = '';
  $('hint').textContent = ''; $('srsTag').textContent = '';
  $('clock').textContent = String(limit > 0 ? limit : 0);
  const step = () => {
    if (n === 0) { countTimer = null; $('q').textContent = ''; then(); return; }
    $('q').textContent = String(n--);
    countTimer = setTimeout(step, 600);
  };
  step();
}

function cancelCountdown() {
  if (!countTimer) return false;
  clearTimeout(countTimer); countTimer = null; running = false;
  return true;
}

function tick() {
  const el = (Date.now() - tStart) / 1000;
  if (limit > 0) {
    const left = Math.max(0, limit - el);
    $('clock').textContent = left >= 10 ? Math.ceil(left) : nl(left);
    $('fill').style.width = (left / limit * 100) + '%';
    if (left <= 0) endSession();
  } else {
    $('clock').textContent = Math.floor(el) + 's';
    $('fill').style.width = '100%';
  }
}

/* Welk deel van een gewone sessie mag een herhaling zijn?

   Nooit meer dan een derde, ook niet als alles openstaat: een sessie moet
   blijven voelen als willekeurig oefenen en niet als stampen. Wel minder zodra
   er weinig echt dringend is, dan is er meer ruimte voor nieuw materiaal. */
function repeatShare() {
  if (!dueQueue.length) return 0;
  const dringend = dueQueue.filter(r => (r.urgency ?? 1) >= 1.25).length;
  return Math.min(0.33, 0.12 + dringend / 80);
}

function nextQuestion() {
  // 1. In deze sessie fout gedaan en weer aan de beurt.
  const i = localDue.findIndex(d => d.at <= answered);
  if (i >= 0) {
    const d = localDue.splice(i, 1)[0];
    lastWasRepeat = true;
    return { ...d.q, repeat: true };
  }
  // 2. Een herhaling uit de database. In de stampmodus komt alles hiervandaan.
  //    Daarbuiten is de plaatsing willekeurig in plaats van elke derde som,
  //    zodat er geen ritme in komt te zitten, en nooit twee achter elkaar.
  const wilHerhaling = isDrill || (!lastWasRepeat && Math.random() < repeatShare());
  if (dueQueue.length && wilHerhaling) {
    const row = dueQueue.shift();
    const q = fromRow(row);
    if (q) {
      if (isDrill) dueQueue.push(row);
      lastWasRepeat = true;
      return { ...q, due: true };
    }
  }
  // 3. Anders vers trekken.
  lastWasRepeat = false;
  return generate(scope);
}

/* Hoeveel decimalen moet je geven voordat een antwoord goed gerekend wordt?
   null betekent: beoordeel met een procentuele marge. */
function decimalsRequired() {
  const m = String(opt.tol).match(/^d(\d)$/);
  return m ? +m[1] : null;
}

function tolLabel() {
  const d = decimalsRequired();
  if (d != null) return `op ${d} ${d === 1 ? 'decimaal' : 'decimalen'}`;
  const t = +opt.tol;
  return t > 0 ? `marge ${String(t).replace('.', ',')} procent` : 'exact';
}

function askNew() {
  cur = nextQuestion();
  typed = ''; t0 = Date.now(); interrupted = false;
  $('q').textContent = cur.q;
  $('a').textContent = ''; $('a').className = 'a mono';
  $('flash').textContent = '';
  $('hint').textContent = cur.dec ? tolLabel() : '';
  $('srsTag').textContent = cur.repeat ? 'nogmaals' : cur.due ? 'herhaling' : '';
}

function fmt(n) {
  if (Number.isInteger(n)) return String(n);
  const d = decimalsRequired();
  if (d != null) return n.toFixed(d).replace('.', ',');
  return String(Math.round(n * 10000) / 10000).replace('.', ',');
}

function correct(v) {
  if (v === '' || v == null) return false;
  const num = parseFloat(String(v).replace(',', '.'));
  if (isNaN(num)) return false;
  if (!cur.dec) return num === cur.ans;

  const d = decimalsRequired();
  // Afronden op een vast aantal decimalen: allebei de kanten door dezelfde
  // functie halen, dan zijn afrondingsgrillen van floats voor beide gelijk.
  if (d != null) return num.toFixed(d) === cur.ans.toFixed(d);

  const tol = +opt.tol / 100;
  if (!(tol > 0)) return Math.abs(num - cur.ans) < 1e-9;
  return Math.abs(num - cur.ans) <= Math.max(Math.abs(cur.ans) * tol, 1e-9);
}

function record(ok, ms) {
  // Een som waarbij je tussendoor weg bent geweest, of die absurd lang duurde,
  // telt niet mee in de gemiddelden. Anders vergiftigt één onderbreking je data.
  // De grens hangt af van je normtijd voor dit soort som: dertig seconden kan
  // bij 4-cijferig optellen echt zijn en is bij 6 x 7 overduidelijk niet.
  const known = board.get(cur.key);
  const norm = known && known.norm_ms ? +known.norm_ms : null;
  const cap = norm ? Math.min(60000, Math.max(10000, norm * 8)) : 30000;
  const outlier = interrupted || ms > cap;

  // Op het scherm mag 98 + 43 net zo goed als 43 + 98 verschijnen, maar in de
  // database krijgt de som altijd dezelfde schrijfwijze, anders wisselt hij van
  // vorm tussen twee pogingen.
  const canon = MODES[cur.mode].build(cur.g1, cur.g2, cur.base).q;

  log.push({
    problem_key: cur.key, mode: cur.mode, g1: cur.g1, g2: cur.g2, base: cur.base ?? null,
    display: canon, swappable: !!MODES[cur.mode].swappable,
    answer: Number.isFinite(cur.ans) ? cur.ans : null,
    ms, ok, outlier, asked_at: new Date(t0).toISOString(),
    // wat je intypte; alleen voor het resultaatscherm, gaat niet naar de database
    given: typed
  });

  answered++;
  modeCounts[cur.mode] = (modeCounts[cur.mode] || 0) + 1;
  if (ok) goed++; else fout++;
  $('score').textContent = String(goed);

  // Fout gedaan? Dan komt hij verderop in deze sessie terug. Twaalf sommen is
  // dezelfde afstand als trede 0 van de spaced repetition.
  if (!ok && !cur.repeat) {
    localDue.push({ at: answered + 12, q: { q: cur.q, ans: cur.ans, dec: cur.dec, key: cur.key,
      mode: cur.mode, g1: cur.g1, g2: cur.g2, base: cur.base } });
  }

  if (limit > 0) {
    const t = document.createElement('div');
    t.className = 'tick' + (ok ? '' : ' bad');
    t.style.left = Math.min(99, ((Date.now() - tStart) / 1000 / limit) * 100) + '%';
    $('fill').parentNode.appendChild(t);
  }
}

function finish(ok) {
  if (pendingTimeout) return;
  record(ok, Date.now() - t0);
  if (ok) { askNew(); return; }
  $('a').className = 'a mono bad';
  $('flash').textContent = `${cur.q} = ${fmt(cur.ans)}`;
  typed = '';
  pendingTimeout = setTimeout(() => {
    pendingTimeout = null;
    if (running) askNew();
  }, 900);
}

function press(k) {
  if (!running || pendingTimeout) return;
  if (k === 'Backspace') typed = typed.slice(0, -1);
  else if (k === 'Enter') { if (typed !== '') finish(correct(typed)); return; }
  else if (/^[0-9]$/.test(k)) typed += k;
  else if (k === '.' || k === ',') { if (!typed.includes(',')) typed += ','; }
  else if (k === '-') { if (typed === '') typed = '-'; }
  else return;

  $('a').textContent = typed;
  $('a').className = 'a mono';
  $('flash').textContent = '';

  const auto = (opt.auto === '1' || opt.auto === 1);
  if (!auto || typed === '') return;

  if (cur.dec) {
    // Met een vast aantal decimalen weten we wanneer je klaar bent met typen,
    // dus dan kan doorgaan-zodra-het-klopt ook bij decimale antwoorden.
    const d = decimalsRequired();
    if (d == null) return;
    if (correct(typed)) { finish(true); return; }
    if ((typed.split(',')[1] || '').length >= d) { finish(false); return; }
    return;
  }

  if (correct(typed)) { finish(true); return; }
  // Evenveel cijfers als het juiste antwoord en toch niet goed: dat is een
  // fout. Zonder deze regel werd in deze stand nooit een fout geregistreerd.
  if (typed.replace('-', '').length >= String(cur.ans).length) finish(false);
}

document.addEventListener('keydown', e => {
  if (!running) return;
  if (e.key === 'Escape') { endSession(); return; }
  if (['Enter', 'Backspace'].includes(e.key) || /^[0-9.,-]$/.test(e.key)) {
    e.preventDefault(); press(e.key);
  }
});

/* Scherm weg? Dan staat de klok stil en telt de lopende som als onderbroken. */
document.addEventListener('visibilitychange', () => {
  if (!running) return;
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (hiddenAt) {
    const d = Date.now() - hiddenAt;
    tStart += d; t0 += d; hiddenAt = 0; interrupted = true;
  }
});

/* ------------------------------------------------------------ afronden */

/* Het resultaatscherm: eerst je fouten met wat je invulde ernaast, daarna elke
   som die je zag met het juiste antwoord erbij. */
let resultSort = 'volgorde';

function renderResults() {
  const antwoord = l => (l.answer == null ? '?' : fmt(l.answer));

  const fouten = log.filter(l => !l.ok);
  $('rMistakes').innerHTML = fouten.length
    ? `<h2>Fouten</h2><div class="card"><table>
        <tr><th>som</th><th>jij</th><th>juist</th></tr>
        ${fouten.map(l => `<tr class="wrong"><td>${l.display}</td>
          <td>${l.given || '—'}</td><td>${antwoord(l)}</td></tr>`).join('')}
       </table></div>`
    : '';

  $('rSort').textContent = resultSort === 'traag' ? 'op volgorde' : 'traagste eerst';
  const rows = resultSort === 'traag' ? [...log].sort((a, b) => b.ms - a.ms) : log;

  $('rAll').innerHTML = rows.length
    ? `<table><tr><th>som</th><th>antwoord</th><th>sec</th></tr>${rows.map(l =>
        `<tr class="${!l.ok ? 'wrong' : l.outlier ? 'skipped' : ''}">
           <td>${l.display}</td><td class="ans">${antwoord(l)}</td>
           <td>${nl(l.ms / 1000)}${l.outlier ? ' *' : ''}</td></tr>`).join('')}</table>
       ${log.some(l => l.outlier)
         ? '<p class="sub" style="margin-top:8px">* onderbroken, telt niet mee in je gemiddelden</p>'
         : ''}`
    : '<p class="empty">Geen antwoorden.</p>';
}

$('rSort').onclick = () => {
  resultSort = resultSort === 'traag' ? 'volgorde' : 'traag';
  renderResults();
};

async function endSession() {
  if (!running) return;
  running = false;
  clearInterval(timer);
  if (pendingTimeout) { clearTimeout(pendingTimeout); pendingTimeout = null; }

  const secs = limit > 0 ? Math.min(limit, (Date.now() - tStart) / 1000) : (Date.now() - tStart) / 1000;
  const tempo = secs > 0 ? (goed / secs * 60) : 0;
  const acc = log.length ? Math.round(goed / log.length * 100) : 0;

  $('rGoed').textContent = goed;
  $('rTempo').textContent = nl(tempo);
  $('rAcc').textContent = acc + '%';
  $('pb').textContent = isDrill ? 'stampsessie' : '';

  const max = Math.max(1, ...log.map(l => l.ms));
  $('strip').innerHTML = log.map(l =>
    `<i class="${l.ok ? '' : 'bad'}" style="height:${Math.max(4, l.ms / max * 66)}px" title="${l.display}"></i>`
  ).join('') || '<span class="empty">geen antwoorden</span>';

  renderResults();
  show('results');

  if (!log.length) { $('rSync').textContent = ''; return; }

  const payload = {
    client_id: sessionId,
    kind: isDrill ? 'drill' : 'practice',
    preset: isDrill ? '' : (opt.preset || ''),
    started_at: new Date(tStart).toISOString(),
    ended_at: new Date().toISOString(),
    limit_s: limit,
    elapsed_s: +secs.toFixed(2),
    n_correct: goed,
    n_wrong: fout,
    config: Object.fromEntries(activeModes(scope).map(k => [k, scope[k]])),
    // Een stampsessie laat de kansen-klok bewust stilstaan: daar konden alleen
    // je zwakke sommen vallen, dus de rest heeft geen kans gehad.
    modes: isDrill ? [] : activeModes(scope).map(k => ({
      mode: k, ...MODES[k].range(scope[k]),
      swappable: !!MODES[k].swappable,
      answered: modeCounts[k] || 0
    })),
    // given is alleen voor het resultaatscherm en hoort niet in de payload
    attempts: log.map(({ given, ...rest }) => rest)
  };

  $('rSync').textContent = 'Opslaan...';
  const res = await db.queueSession(payload);
  $('rSync').textContent = res.left
    ? 'Nog niet opgeslagen, dit gaat vanzelf zodra je verbinding hebt.'
    : 'Opgeslagen.';
  syncStatus();
  // ijkt de parameters bij zodra er genoeg nieuwe pogingen liggen
  try { if (await db.maybeFitModel()) await refreshModel(); } catch { /* geeft niet */ }
  await refreshBoard();
}

/* --------------------------------------------------------- statistieken */

let tab = 'sommen';
let sortKey = 'zwak';
let filterOpen = false;

const TABS = {
  sommen: 'Zwakste sommen',
  families: 'Patronen',
  tafels: 'Tafels',
  sessies: 'Sessies'
};

const SORTS = {
  zwak:    ['zwakste eerst', (a, b) => (b.expected_rel ?? 0) - (a.expected_rel ?? 0)],
  urgent:  ['eerst aan de beurt', (a, b) => (b.urgency ?? 0) - (a.urgency ?? 0)],
  ms:      ['traagst in seconden', (a, b) => (b.expected_s ?? 0) - (a.expected_s ?? 0)],
  acc: ['vaakst fout', (a, b) => (a.acc ?? 1) - (b.acc ?? 1)],
  seen: ['minst gezien', (a, b) => a.n - b.n]
};

function heatColor(rel) {
  // nog niet gezien: een rustige vulling in de lijnkleur, zodat het als leeg
  // vakje leest en niet als een gat in het raster
  if (rel == null) return 'var(--line)';
  const t = Math.max(0, Math.min(1, (rel - 0.7) / 0.9));
  return `hsl(${Math.round(145 - t * 145)} 55% 45%)`;
}

/* De sommen die binnen het filter vallen. */
function filtered() {
  return [...board.values()].filter(r => eligible(r, filterCfg));
}

function renderControls() {
  const box = $('sControls');
  if (tab !== 'sommen') { box.innerHTML = ''; return; }

  box.innerHTML = `
    <div class="ctl">
      <select id="sSort">${Object.entries(SORTS).map(([k, [label]]) =>
        `<option value="${k}" ${sortKey === k ? 'selected' : ''}>${label}</option>`).join('')}</select>
      <button class="chip ${filterOpen ? 'on' : ''}" id="sToggle">Filter</button>
    </div>
    <div class="panel ${filterOpen ? 'open' : ''}" id="sPanel">
      <p class="sub">Kies precies zoals bij het instellen van een sessie welke sommen
        je hier wil zien. Dit bepaalt ook waar de stampsessie uit trekt.</p>
      <div id="sFilterBox"></div>
      <div class="ctl" style="margin-top:10px">
        <button class="chip" id="sFromCfg">Overnemen uit oefeninstellingen</button>
        <button class="chip" id="sAll">Alles</button>
      </div>
      <button class="btn" id="sDrill">Stampen met deze selectie</button>
      <p class="err" id="sErr"></p>
    </div>`;

  $('sSort').onchange = e => { sortKey = e.target.value; renderStats(); };
  $('sToggle').onclick = () => { filterOpen = !filterOpen; renderStats(); };

  renderModeCards($('sFilterBox'), filterCfg, {
    anyBase: true,
    onChange: () => { store.set('rt_filter', filterCfg); renderBody(); }
  });

  $('sFromCfg').onclick = () => {
    for (const k in MODES) filterCfg[k] = clone(cfg[k]);
    store.set('rt_filter', filterCfg);
    renderStats();
  };
  $('sAll').onclick = () => {
    filterCfg = fillGaps({}, true);
    store.set('rt_filter', filterCfg);
    renderStats();
  };
  $('sDrill').onclick = () => startSession(true, filterCfg);
}

function renderBody() {
  const body = $('sBody');

  if (tab === 'sommen') {
    const rows = filtered();
    const list = rows
      .filter(r => r.n >= 1 && r.expected_rel != null)
      .sort(SORTS[sortKey][1])
      .slice(0, 40);
    $('sCount').textContent = `${rows.length} van ${board.size} sommen`;
    body.innerHTML = `<p class="sub">De schatting is hoe lang je er nú over zou doen, afgezet
      tegen jouw eigen normtijd voor dat soort som: 1,0 is precies gemiddeld. Sommen die je
      nog nauwelijks zag leunen op het gemiddelde van hun familie.</p>
      <div class="card">${list.length
        ? `<table><tr><th>som</th><th>keer</th><th>goed</th><th>sec</th><th>norm</th></tr>${list.map(r =>
            `<tr><td>${r.display}</td><td>${r.n}</td>
             <td>${Math.round((r.acc ?? 1) * 100)}%</td>
             <td>${r.expected_s != null ? nl(r.expected_s) : '-'}</td>
             <td class="${r.expected_rel >= 1.3 ? 'warm' : ''}">${nl(r.expected_rel, 2)}</td></tr>`).join('')}</table>`
        : '<p class="empty">Niets binnen dit filter met genoeg herhalingen.</p>'}</div>`;

  } else if (tab === 'families') {
    $('sCount').textContent = `${board.size} sommen bekend`;
    const list = [...families]
      .filter(f => f.n_attempts >= 5)
      .sort((a, b) => (b.avg_relative ?? 0) - (a.avg_relative ?? 0))
      .slice(0, 30);
    body.innerHTML = `<p class="sub">Losse sommen zie je zelden twee keer, groepen wel.
      Hier zit je patroon: een hele tafel, sommen met tientaloverschrijding, een reeks kwadraten.</p>
      <div class="card">${list.length
        ? `<table><tr><th>groep</th><th>sommen</th><th>sec</th><th>norm</th></tr>${list.map(f =>
            `<tr><td>${f.label}</td><td>${f.n_problems}</td>
             <td>${nl(f.median_ms / 1000)}</td>
             <td class="${f.avg_relative >= 1.2 ? 'warm' : ''}">${nl(f.avg_relative, 2)}</td></tr>`).join('')}</table>`
        : '<p class="empty">Nog te weinig data voor groepen.</p>'}</div>`;

  } else if (tab === 'tafels') {
    $('sCount').textContent = `${board.size} sommen bekend`;
    const by = new Map();
    [...board.values()].filter(r => r.mode === 'mul').forEach(r => by.set(`${r.g1}x${r.g2}`, r));
    const lo = 2, hi = 19;
    let html = '<div class="heat"><table><tr><th></th>';
    for (let b = lo; b <= hi; b++) html += `<th>${b}</th>`;
    html += '</tr>';
    for (let a = lo; a <= hi; a++) {
      html += `<tr><th>${a}</th>`;
      for (let b = lo; b <= hi; b++) {
        const key = a <= b ? `${a}x${b}` : `${b}x${a}`;
        const r = by.get(key);
        const rel = r && r.expected_rel != null ? +r.expected_rel : null;
        const title = r ? `${r.display}: ${nl(r.expected_s)}s, ${r.n}x`
                        : `${a} x ${b}: nog niet gezien`;
        html += `<td><i style="background:${heatColor(rel)}" title="${title}"></i></td>`;
      }
      html += '</tr>';
    }
    html += '</table><div class="legend"><i style="background:' + heatColor(0.7) + '"></i>snel'
      + '<i style="background:' + heatColor(1.15) + '"></i>gemiddeld'
      + '<i style="background:' + heatColor(1.6) + '"></i>traag'
      + '<i style="background:var(--line)"></i>nog niet gezien</div></div>';
    body.innerHTML = `<p class="sub">De tafels 2 tot en met 19, gekleurd naar hoe snel je ze doet
      vergeleken met je eigen gemiddelde.</p>` + html;

  } else {
    body.innerHTML = '<p class="empty">Laden...</p>';
    db.loadSessions(40).then(list => {
      $('sCount').textContent = list.length ? `${list.length} sessies` : '';
      body.innerHTML = list.length ? list.map(s => {
        const secs = +s.elapsed_s || s.limit_s || 0;
        const tempo = secs > 0 ? nl(s.n_correct / secs * 60) : '-';
        const total = s.n_correct + s.n_wrong;
        const acc = total ? Math.round(s.n_correct / total * 100) : 0;
        const what = describeConfig(s.config);
        const when = new Date(s.started_at).toLocaleString('nl-NL',
          { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        return `<div class="sess">
          <div class="when"><span>${when}</span>
            <span>${durLabel(s.limit_s, s.elapsed_s)}${s.kind === 'drill' ? ' · stampen' : ''}</span></div>
          <div class="what">${what.length
            ? what.map(w => `<span>${w}</span>`).join('')
            : '<span class="empty">geen categorieën vastgelegd</span>'}</div>
          <div class="nums">${s.n_correct} goed · ${tempo} per minuut · ${acc}% accuraat${
            s.preset ? ` · ${s.preset}` : ''}</div>
        </div>`;
      }).join('') : '<p class="empty">Nog geen sessies.</p>';
    }).catch(() => { body.innerHTML = '<p class="empty">Sessies laden mislukt.</p>'; });
  }
}

function renderStats() {
  $('sTabs').innerHTML = '';
  for (const k in TABS) {
    const b = document.createElement('button');
    b.className = 'chip' + (tab === k ? ' on' : '');
    b.textContent = TABS[k];
    b.onclick = () => { tab = k; renderStats(); };
    $('sTabs').appendChild(b);
  }
  renderControls();
  renderBody();
}

/* ------------------------------------------------------------- knoppen */

$('start').onclick = () => startSession(false);
$('drill').onclick = () => startSession(true);
$('stop').onclick = () => {
  if (cancelCountdown()) { show('setup'); return; }
  endSession();
};
$('again').onclick = () => startSession(isDrill, scope);
$('back').onclick = () => { renderModes(); show('setup'); };
$('sBack').onclick = () => show('setup');

$('toStats').onclick = async () => {
  show('stats');
  $('sBody').innerHTML = '<p class="empty">Laden...</p>';
  try { families = await db.loadFamilies(); } catch { families = []; }
  renderStats();
};

$('doExport').onclick = () => {
  const blob = new Blob([JSON.stringify({ board: [...board.values()], cfg, opt }, null, 1)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'mentat-backup.json';
  a.click();
};

/* Neemt de oude localStorage-data over. Staat er niets meer lokaal, dan kun je
   een eerder geëxporteerd backupbestand kiezen. */
$('doImport').onclick = async () => {
  const local = store.get('rt_stats', null);
  if (local && Object.keys(local).length) {
    if (!confirm(`${Object.keys(local).length} sommen uit dit apparaat overnemen?`)) return;
    await runImport(local, store.get('rt_hist', []));
    return;
  }
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json';
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = async () => {
      try {
        const d = JSON.parse(r.result);
        if (!d.stats) { alert('Geen oude statistieken in dit bestand.'); return; }
        await runImport(d.stats, d.hist || []);
      } catch { alert('Dat bestand kon ik niet lezen.'); }
    };
    r.readAsText(f);
  };
  inp.click();
};

async function runImport(stats, hist) {
  try {
    const res = await db.importLegacy(stats, hist);
    alert(`${res.problems} sommen en ${res.sessions} sessies overgenomen.`);
    await refreshBoard();
  } catch (e) {
    alert('Overnemen mislukt: ' + e.message);
  }
}

renderPresets();
renderModes();
window.__rtReady = true;   // het vangnet in index.html weet nu dat de module draait
boot();
