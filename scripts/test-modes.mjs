import { MODES, PRESETS, eligible, parseLegacyKey } from '../modes.js';

let fails = 0;
const fail = (m) => { console.log('FOUT: ' + m); fails++; };

// standaardconfig zoals de app hem opbouwt
const cfg = {};
for (const k in MODES) {
  cfg[k] = { on: 1 };
  MODES[k].fields.forEach(([f, , lo, hi]) => cfg[k][f] = [lo, hi]);
  (MODES[k].selects || []).forEach(([s, , v]) => cfg[k][s] = v[0]);
}

for (const k in MODES) {
  const m = MODES[k];
  for (let i = 0; i < 3000; i++) {
    const q = m.gen(cfg[k]);

    // 1. build() moet dezelfde som teruggeven. Bij optellen en vermenigvuldigen
    //    mag de volgorde van de operanden verschillen (98+43 en 43+98 zijn
    //    dezelfde som); het antwoord moet altijd exact kloppen.
    const b = m.build(q.g1, q.g2, q.base);
    if (Math.abs(b.ans - q.ans) > 1e-12) fail(`${k}: build antwoord ${b.ans} vs ${q.ans}`);
    if (!!b.dec !== !!q.dec) fail(`${k}: dec-vlag verschilt`);
    const norm = s => s.split(/\s*[+x]\s*/).sort().join('|');
    if (m.swappable ? norm(b.q) !== norm(q.q) : b.q !== q.q)
      fail(`${k}: build gaf "${b.q}" maar gen gaf "${q.q}"`);
    // build() is deterministisch: dezelfde operanden geven altijd dezelfde
    // schrijfwijze, en dat is wat er in de database belandt
    if (m.build(q.g1, q.g2, q.base).q !== b.q) fail(`${k}: build is niet deterministisch`);

    // 2. de som moet trekbaar zijn binnen zijn eigen bereiken
    const row = { mode: k, g1: q.g1, g2: q.g2 ?? null, base: q.base ?? null };
    if (!eligible(row, cfg)) fail(`${k}: eigen som ${q.q} (g1=${q.g1},g2=${q.g2}) niet eligible`);

    // 3. de oude sleutel moet dezelfde operanden opleveren
    const p = parseLegacyKey(q.key);
    if (!p) fail(`${k}: sleutel ${q.key} niet te parsen`);
    else {
      if (p.mode !== k) fail(`${k}: sleutel ${q.key} gaf mode ${p.mode}`);
      if (p.g1 !== q.g1) fail(`${k}: sleutel ${q.key} gaf g1 ${p.g1} i.p.v. ${q.g1}`);
      if ((p.g2 ?? null) !== (q.g2 ?? null)) fail(`${k}: sleutel ${q.key} gaf g2 ${p.g2} i.p.v. ${q.g2}`);
      if ((p.base ?? null) !== (q.base ?? null)) fail(`${k}: sleutel ${q.key} gaf base ${p.base}`);
    }
  }
}

// 4. eligible moet buiten bereik juist NEE zeggen
const smal = JSON.parse(JSON.stringify(cfg));
smal.mul.a = [2, 5]; smal.mul.b = [2, 9];
if (eligible({ mode: 'mul', g1: 7, g2: 13, base: null }, smal)) fail('7x13 zou buiten 2-5 x 2-9 moeten vallen');
if (!eligible({ mode: 'mul', g1: 3, g2: 8, base: null }, smal)) fail('3x8 zou binnen 2-5 x 2-9 moeten vallen');
// verwisselbaar: 8x3 opgeslagen als g1=3,g2=8 maar ook andersom moet werken
if (!eligible({ mode: 'mul', g1: 2, g2: 4, base: null }, smal)) fail('2x4 zou moeten passen');

// 5. uitgezette modus levert nooit een kans op
const uit = JSON.parse(JSON.stringify(cfg));
uit.mul.on = 0;
if (eligible({ mode: 'mul', g1: 3, g2: 8, base: null }, uit)) fail('uitgezette modus geeft toch een kans');

// 6. presets verwijzen alleen naar bestaande modi en velden
for (const p in PRESETS) {
  for (const k in PRESETS[p].cfg) {
    if (!MODES[k]) fail(`preset ${p} verwijst naar onbekende modus ${k}`);
    else for (const f in PRESETS[p].cfg[k]) {
      if (f === 'on') continue;
      const known = MODES[k].fields.some(([n]) => n === f) ||
                    (MODES[k].selects || []).some(([n]) => n === f);
      if (!known) fail(`preset ${p} zet onbekend veld ${k}.${f}`);
    }
  }
}

console.log(fails ? `\n${fails} fouten` : 'alle controles goed');
process.exit(fails ? 1 : 0);
