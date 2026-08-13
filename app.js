/* Rekentrainer.

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

/* board: problem_key -> rij uit problem_board. Leeg tot je ingelogd bent. */
let board = new Map();
let families = [];

/* ---------------------------------------------------------- instellingen */

let cfg = store.get('rt_cfg', null);
if (!cfg) {
  cfg = {};
  for (const k in MODES) {
    cfg[k] = { on: 0 };
    MODES[k].fields.forEach(([f, , lo, hi]) => cfg[k][f] = [lo, hi]);
    (MODES[k].selects || []).forEach(([s, , v]) => cfg[k][s] = v[0]);
  }
  Object.assign(cfg, JSON.parse(JSON.stringify(PRESETS.zetamac.cfg)));
}
for (const k in MODES) {   // gaten vullen na een update
  cfg[k] = cfg[k] || { on: 0 };
  MODES[k].fields.forEach(([f, , lo, hi]) => { if (!Array.isArray(cfg[k][f])) cfg[k][f] = [lo, hi]; });
  (MODES[k].selects || []).forEach(([s, , v]) => { if (cfg[k][s] == null) cfg[k][s] = v[0]; });
}

const opt = store.get('rt_opt', { dur: 120, weighted: 1, auto: 1, tol: 1, pad: 'auto', preset: '' });
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
  await refreshBoard();
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

/* ------------------------------------------------------- setup renderen */

function renderPresets() {
  $('presets').innerHTML = '';
  for (const p in PRESETS) {
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = PRESETS[p].label;
    b.onclick = () => {
      for (const k in cfg) cfg[k].on = 0;
      const c = JSON.parse(JSON.stringify(PRESETS[p].cfg));
      for (const k in c) Object.assign(cfg[k], c[k]);
      opt.dur = String(PRESETS[p].dur); $('dur').value = opt.dur;
      opt.preset = PRESETS[p].label;
      store.set('rt_cfg', cfg); store.set('rt_opt', opt);
      renderModes();
    };
    $('presets').appendChild(b);
  }
}

function renderModes() {
  const box = $('modes'); box.innerHTML = '';
  for (const k in MODES) {
    const m = MODES[k], c = cfg[k];
    const card = document.createElement('div');
    card.className = 'card' + (c.on ? ' on' : '');
    const head = document.createElement('label');
    head.className = 'mode-head';
    head.innerHTML = `<input type="checkbox" ${c.on ? 'checked' : ''}>
      <span class="mode-name">${m.label}</span><span class="mode-hint">${m.hint}</span>`;
    head.querySelector('input').onchange = e => {
      c.on = e.target.checked ? 1 : 0;
      card.classList.toggle('on', !!c.on);
      opt.preset = ''; store.set('rt_opt', opt);
      store.set('rt_cfg', cfg);
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
        opt.preset = ''; store.set('rt_opt', opt); store.set('rt_cfg', cfg);
      };
      lo.onchange = save; hi.onchange = save;
      f.appendChild(row);
    });
    (m.selects || []).forEach(([key, label, vals]) => {
      const row = document.createElement('div'); row.className = 'frow';
      row.innerHTML = `<label>${label}</label><select>${vals.map(v =>
        `<option value="${v}" ${c[key] == v ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
      row.querySelector('select').onchange = e => {
        c[key] = +e.target.value; store.set('rt_cfg', cfg);
      };
      f.appendChild(row);
    });
    card.appendChild(f); box.appendChild(card);
  }
}

/* ------------------------------------------------------------- trekking */

const activeModes = () => Object.keys(MODES).filter(k => cfg[k].on);

/* Gewicht bij het vers trekken. Relatief ten opzichte van je eigen normtijd
   voor die vorm, verhoogd bij fouten. Een onbekende som weegt als een
   gemiddelde bekende som, zodat nieuw materiaal blijft langskomen. */
function weightOf(key) {
  const r = board.get(key);
  if (!r || !r.n) return 2.5;
  const rel = r.relative != null ? +r.relative : 1;
  const err = 1 - (r.acc != null ? +r.acc : 1);
  return Math.min(12, Math.max(0.4, rel * (1 + 2 * err) * 2.5));
}

function generate() {
  const modes = activeModes();
  const make = () => { const k = pick(modes); const q = MODES[k].gen(cfg[k]); q.mode = k; return q; };
  if (opt.weighted !== '1' && opt.weighted !== 1) return make();
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
let pendingTimeout = null;

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

function startSession(drill) {
  const modes = activeModes();
  if (!modes.length) { $('setupErr').textContent = 'Zet minstens één oefening aan.'; return; }

  isDrill = !!drill;
  dueQueue = [];
  if (isDrill) {
    // Alleen sommen die je al eens zag, gesorteerd op struggle-score.
    dueQueue = [...board.values()]
      .filter(r => r.n >= 1 && eligible(r, cfg))
      .sort((a, b) => (b.struggle ?? 0) - (a.struggle ?? 0))
      .slice(0, 60);
    if (!dueQueue.length) {
      $('setupErr').textContent = 'Nog te weinig historie om te stampen. Doe eerst een gewone sessie.';
      return;
    }
  } else {
    // Sommen die volgens de kansen-klok toe zijn aan een herhaling.
    dueQueue = [...board.values()]
      .filter(r => r.is_due && eligible(r, cfg))
      .sort((a, b) => (b.struggle ?? 0) - (a.struggle ?? 0));
  }

  $('setupErr').textContent = '';
  limit = +opt.dur; log = []; goed = 0; fout = 0; running = true;
  answered = 0; modeCounts = {}; localDue = []; interrupted = false; hiddenAt = 0;
  sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  tStart = Date.now();
  $('fill').style.width = '100%';
  document.querySelectorAll('.tick').forEach(t => t.remove());
  $('score').textContent = '0';
  buildPad(); show('session');
  askNew();
  timer = setInterval(tick, 100);
  tick();
}

function tick() {
  const el = (Date.now() - tStart) / 1000;
  if (limit > 0) {
    const left = Math.max(0, limit - el);
    $('clock').textContent = left >= 10 ? Math.ceil(left) : left.toFixed(1);
    $('fill').style.width = (left / limit * 100) + '%';
    if (left <= 0) endSession();
  } else {
    $('clock').textContent = Math.floor(el) + 's';
    $('fill').style.width = '100%';
  }
}

function nextQuestion() {
  // 1. In deze sessie fout gedaan en weer aan de beurt.
  const i = localDue.findIndex(d => d.at <= answered);
  if (i >= 0) {
    const d = localDue.splice(i, 1)[0];
    return { ...d.q, repeat: true };
  }
  // 2. Volgens de kansen-klok toe aan herhaling. In de stampmodus komt alles
  //    hiervandaan; in een gewone sessie ongeveer één op de drie.
  if (dueQueue.length && (isDrill || answered % 3 === 2)) {
    const row = dueQueue.shift();
    const q = fromRow(row);
    if (q) { if (isDrill) dueQueue.push(row); return { ...q, due: true }; }
  }
  // 3. Anders vers trekken.
  return generate();
}

function askNew() {
  cur = nextQuestion();
  typed = ''; t0 = Date.now(); interrupted = false;
  $('q').textContent = cur.q;
  $('a').textContent = ''; $('a').className = 'a mono';
  $('flash').textContent = '';
  $('srsTag').textContent = cur.repeat ? 'nogmaals' : cur.due ? 'herhaling' : '';
}

function fmt(n) {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 10000) / 10000).replace('.', ',');
}

function correct(v) {
  if (v === '' || v == null) return false;
  const num = parseFloat(String(v).replace(',', '.'));
  if (isNaN(num)) return false;
  if (!cur.dec) return num === cur.ans;
  const tol = +opt.tol / 100;
  if (tol === 0) return Math.abs(num - cur.ans) < 1e-9;
  return Math.abs(num - cur.ans) <= Math.max(Math.abs(cur.ans) * tol, 1e-9);
}

function record(ok, ms) {
  // Een som waarbij je tussendoor weg bent geweest, of die absurd lang duurde,
  // telt niet mee in de gemiddelden. Anders vergiftigt één onderbreking je data.
  const outlier = interrupted || ms > 30000;

  // Op het scherm mag 98 + 43 net zo goed als 43 + 98 verschijnen, maar in de
  // database krijgt de som altijd dezelfde schrijfwijze, anders wisselt hij van
  // vorm tussen twee pogingen.
  const canon = MODES[cur.mode].build(cur.g1, cur.g2, cur.base).q;

  log.push({
    problem_key: cur.key, mode: cur.mode, g1: cur.g1, g2: cur.g2, base: cur.base ?? null,
    display: canon, swappable: !!MODES[cur.mode].swappable,
    answer: Number.isFinite(cur.ans) ? cur.ans : null,
    ms, ok, outlier, asked_at: new Date(t0).toISOString()
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
  if (auto && !cur.dec && typed !== '') {
    if (correct(typed)) { finish(true); return; }
    // Evenveel cijfers als het juiste antwoord en toch niet goed: dat is een
    // fout. Zonder deze regel werd in deze stand nooit een fout geregistreerd.
    if (typed.replace('-', '').length >= String(cur.ans).length) { finish(false); return; }
  }
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

async function endSession() {
  if (!running) return;
  running = false;
  clearInterval(timer);
  if (pendingTimeout) { clearTimeout(pendingTimeout); pendingTimeout = null; }

  const secs = limit > 0 ? Math.min(limit, (Date.now() - tStart) / 1000) : (Date.now() - tStart) / 1000;
  const scored = log.filter(l => !l.outlier);
  const tempo = secs > 0 ? (goed / secs * 60) : 0;
  const acc = log.length ? Math.round(goed / log.length * 100) : 0;

  $('rGoed').textContent = goed;
  $('rTempo').textContent = tempo.toFixed(1);
  $('rAcc').textContent = acc + '%';
  $('pb').textContent = isDrill ? 'stampsessie' : '';

  const max = Math.max(1, ...log.map(l => l.ms));
  $('strip').innerHTML = log.map(l =>
    `<i class="${l.ok ? '' : 'bad'}" style="height:${Math.max(4, l.ms / max * 66)}px" title="${l.display}"></i>`
  ).join('') || '<span class="empty">geen antwoorden</span>';

  const slow = scored.filter(l => l.ok).sort((a, b) => b.ms - a.ms).slice(0, 8);
  $('rSlow').innerHTML = slow.length
    ? `<table><tr><th>som</th><th>seconden</th></tr>${slow.map(l =>
        `<tr><td>${l.display}</td><td>${(l.ms / 1000).toFixed(1)}</td></tr>`).join('')}</table>`
    : '<p class="empty">Nog niks om te tonen.</p>';

  show('results');

  if (!log.length) { $('rSync').textContent = ''; return; }

  const payload = {
    client_id: sessionId,
    kind: isDrill ? 'drill' : 'practice',
    preset: opt.preset || '',
    started_at: new Date(tStart).toISOString(),
    ended_at: new Date().toISOString(),
    limit_s: limit,
    elapsed_s: +secs.toFixed(2),
    n_correct: goed,
    n_wrong: fout,
    config: Object.fromEntries(activeModes().map(k => [k, cfg[k]])),
    // Een stampsessie laat de kansen-klok bewust stilstaan: daar konden alleen
    // je zwakke sommen vallen, dus de rest heeft geen kans gehad.
    modes: isDrill ? [] : activeModes().map(k => ({
      mode: k, ...MODES[k].range(cfg[k]),
      swappable: !!MODES[k].swappable,
      answered: modeCounts[k] || 0
    })),
    attempts: log
  };

  $('rSync').textContent = 'Opslaan...';
  const res = await db.queueSession(payload);
  $('rSync').textContent = res.left
    ? 'Nog niet opgeslagen, dit gaat vanzelf zodra je verbinding hebt.'
    : 'Opgeslagen.';
  syncStatus();
  await refreshBoard();
}

/* --------------------------------------------------------- statistieken */

let tab = 'sommen';

const TABS = {
  sommen: 'Zwakste sommen',
  families: 'Patronen',
  tafels: 'Tafels',
  sessies: 'Sessies'
};

function heatColor(rel) {
  if (rel == null) return 'var(--sunk)';
  const t = Math.max(0, Math.min(1, (rel - 0.7) / 0.9));
  return `hsl(${Math.round(145 - t * 145)} 55% 45%)`;
}

async function renderStats() {
  $('sTabs').innerHTML = '';
  for (const k in TABS) {
    const b = document.createElement('button');
    b.className = 'chip' + (tab === k ? ' on' : '');
    b.textContent = TABS[k];
    b.onclick = () => { tab = k; renderStats(); };
    $('sTabs').appendChild(b);
  }

  const rows = [...board.values()];
  $('sCount').textContent = rows.length ? `${rows.length} sommen bekend` : '';
  const body = $('sBody');

  if (tab === 'sommen') {
    const list = rows
      .filter(r => r.n >= 2 && r.relative != null)
      .sort((a, b) => (b.struggle ?? 0) - (a.struggle ?? 0))
      .slice(0, 30);
    body.innerHTML = `<p class="sub">Gesorteerd op hoeveel trager dan jouw eigen normtijd voor
      dat soort som, zwaarder gewogen als je hem ook fout doet. 1,0 is precies gemiddeld.</p>
      <div class="card">${list.length
        ? `<table><tr><th>som</th><th>keer</th><th>sec</th><th>t.o.v. norm</th></tr>${list.map(r =>
            `<tr><td>${r.display}</td><td>${r.n}</td>
             <td>${(r.recent_ms / 1000).toFixed(1)}</td>
             <td class="${r.relative >= 1.3 ? 'warm' : ''}">${(+r.relative).toFixed(2)}</td></tr>`).join('')}</table>`
        : '<p class="empty">Nog te weinig herhalingen. Doe eerst een paar sessies.</p>'}</div>`;

  } else if (tab === 'families') {
    const list = [...families]
      .filter(f => f.n_attempts >= 5)
      .sort((a, b) => (b.avg_relative ?? 0) - (a.avg_relative ?? 0))
      .slice(0, 30);
    body.innerHTML = `<p class="sub">Losse sommen zie je zelden twee keer, groepen wel.
      Hier zit je patroon: een hele tafel, sommen met tientaloverschrijding, een reeks kwadraten.</p>
      <div class="card">${list.length
        ? `<table><tr><th>groep</th><th>sommen</th><th>sec</th><th>t.o.v. norm</th></tr>${list.map(f =>
            `<tr><td>${f.label}</td><td>${f.n_problems}</td>
             <td>${(f.median_ms / 1000).toFixed(1)}</td>
             <td class="${f.avg_relative >= 1.2 ? 'warm' : ''}">${(+f.avg_relative).toFixed(2)}</td></tr>`).join('')}</table>`
        : '<p class="empty">Nog te weinig data voor groepen.</p>'}</div>`;

  } else if (tab === 'tafels') {
    const by = new Map();
    rows.filter(r => r.mode === 'mul').forEach(r => {
      by.set(`${r.g1}x${r.g2}`, r);
    });
    const lo = 2, hi = 19;
    let html = '<div class="heat"><table><tr><th></th>';
    for (let b = lo; b <= hi; b++) html += `<th>${b}</th>`;
    html += '</tr>';
    for (let a = lo; a <= hi; a++) {
      html += `<tr><th>${a}</th>`;
      for (let b = lo; b <= hi; b++) {
        const key = a <= b ? `${a}x${b}` : `${b}x${a}`;
        const r = by.get(key);
        const rel = r && r.relative != null ? +r.relative : null;
        const title = r ? `${r.display}: ${(r.recent_ms / 1000).toFixed(1)}s, ${r.n}x` : `${a} x ${b}: nog niet gezien`;
        html += `<td><i style="background:${heatColor(rel)}" title="${title}"></i></td>`;
      }
      html += '</tr>';
    }
    html += '</table><div class="legend"><i style="background:' + heatColor(0.7) + '"></i>snel'
      + '<i style="background:' + heatColor(1.15) + '"></i>gemiddeld'
      + '<i style="background:' + heatColor(1.6) + '"></i>traag'
      + '<i style="background:var(--sunk)"></i>nog niet gezien</div></div>';
    body.innerHTML = `<p class="sub">De tafels 2 tot en met 19, gekleurd naar hoe snel je ze doet
      vergeleken met je eigen gemiddelde.</p>` + html;

  } else {
    let list = [];
    try { list = await db.loadSessions(30); } catch { /* offline */ }
    body.innerHTML = `<div class="card">${list.length
      ? `<table><tr><th>wanneer</th><th>goed</th><th>per min</th></tr>${list.map(s => {
          const secs = +s.elapsed_s || s.limit_s || 0;
          const tempo = secs > 0 ? (s.n_correct / secs * 60).toFixed(1) : '-';
          return `<tr><td>${new Date(s.started_at).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })}${s.kind === 'drill' ? ' *' : ''}</td>
            <td>${s.n_correct}</td><td>${tempo}</td></tr>`;
        }).join('')}</table><p class="sub" style="margin-top:8px">* stampsessie</p>`
      : '<p class="empty">Nog geen sessies.</p>'}</div>`;
  }
}

/* ------------------------------------------------------------- knoppen */

$('start').onclick = () => startSession(false);
$('drill').onclick = () => startSession(true);
$('stop').onclick = endSession;
$('again').onclick = () => startSession(isDrill);
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
  a.download = 'rekentrainer-backup.json';
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
