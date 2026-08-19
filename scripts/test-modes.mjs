import { MODES, PRESETS, eligible, parseLegacyKey,
         ANCHORS, nearestAnchor, anchorPos, anchorBias } from '../modes.js';

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

/* ------------------------------------------------- logaritme-interpolatie */

const A = MODES.antilog, L = MODES.log;
const vraagA = g => ({ ...A.gen({ x: [g, g] }) });
const vraagL = g => ({ ...L.gen({ m: [g, g] }) });

// 7. de vraag staat er met Nederlandse komma en het juiste aantal decimalen
if (vraagA(296).q !== '10^0,296') fail(`antilog toont "${vraagA(296).q}"`);
if (vraagA(50).q !== '10^0,050') fail(`antilog toont "${vraagA(50).q}"`);
if (vraagL(340).q !== 'log 3,40') fail(`log toont "${vraagL(340).q}"`);
if (A.fmt(vraagA(296).ans) !== '1,98') fail(`antilog antwoord "${A.fmt(vraagA(296).ans)}"`);
if (L.fmt(vraagL(340).ans) !== '0,531') fail(`log antwoord "${L.fmt(vraagL(340).ans)}"`);

// 8. elk anker ligt waar het zegt te liggen
for (const a of ANCHORS) {
  if (Math.abs(Math.log10(a.num) - a.log) > 0.0006)
    fail(`anker ${a.num} staat op ${a.log} maar log is ${Math.log10(a.num)}`);
}
// de vier uit je hoofd, de samengestelde, en de tabel zelf moeten er zijn
for (const n of [2, 3, 5, 7, 1.5, 2.5, 3.5]) {
  if (!ANCHORS.some(a => a.named && a.num === n)) fail(`anker log ${n} ontbreekt`);
}
if (ANCHORS.filter(a => !a.named).length !== 21) fail('de antilog-tabel telt geen 21 stappen');
if (!ANCHORS.find(a => a.num === 3.5).deriv.includes('log 7'))
  fail('log 3,5 mist zijn afleiding');
if (!ANCHORS.find(a => a.num === 1.5).deriv.includes('log 15'))
  fail('log 1,5 mist de afleiding via log 15');

// 9. het dichtstbijzijnde anker, met voorrang voor een benoemd anker vlakbij
if (nearestAnchor(0.296).num !== 2) fail('0,296 hoort bij log 2');
if (nearestAnchor(0.3005).num !== 2) fail('0,3005 hoort bij log 2, niet bij de tabel');
if (nearestAnchor(0.6985).num !== 5) fail('0,6985 hoort bij log 5');
if (nearestAnchor(0.8460).num !== 7) fail('0,8460 hoort bij log 7');
if (nearestAnchor(0.5400).num !== 3.5) fail('0,5400 hoort bij log 3,5');
if (nearestAnchor(0.1770).num !== 1.5) fail('0,1770 hoort bij log 1,5');
if (nearestAnchor(0.3960).num !== 2.5) fail('0,3960 hoort bij log 2,5');
// midden tussen twee ankers: dan wint gewoon de kortste afstand
if (nearestAnchor(0.123).log !== 0.1) fail('0,123 hoort bij het tabelanker 0,10');
if (nearestAnchor(0.62).log !== 0.6) fail('0,62 hoort bij het tabelanker 0,60');

// 10. de marges: scherp, goed, fout
const gradeA = (q, f) => A.grade(q.ans * f, q);
const qa = vraagA(296);
if (gradeA(qa, 1.0009) !== 'scherp') fail('0,09 procent zou scherp moeten zijn');
if (gradeA(qa, 0.9991) !== 'scherp') fail('0,09 procent onder zou scherp moeten zijn');
if (gradeA(qa, 1.003) !== 'goed') fail('0,3 procent zou goed moeten zijn');
if (gradeA(qa, 1.006) !== false) fail('0,6 procent zou fout moeten zijn');
const ql = vraagL(340);
if (L.grade(ql.ans + 0.0019, ql) !== 'scherp') fail('0,0019 zou scherp moeten zijn');
if (L.grade(ql.ans - 0.004, ql) !== 'goed') fail('0,004 zou goed moeten zijn');
if (L.grade(ql.ans + 0.0051, ql) !== false) fail('0,0051 zou fout moeten zijn');

// 11. wanneer is een antwoord af? pas dan wordt het beoordeeld
if (A.complete('1,9')) fail('twee cijfers is nog geen antwoord bij antilog');
if (!A.complete('1,98')) fail('drie significante cijfers is af');
if (!A.complete('10,0')) fail('10,0 is af');
if (L.complete('0,53')) fail('twee decimalen is nog geen antwoord bij log');
if (!L.complete('0,531')) fail('drie decimalen is af');

// 12. de feedbackregel: exacte waarde, jouw afwijking, het anker met afleiding,
//     en de vuistregel waarmee je de correctie maakt
const fa = A.feedback(qa, '1,98', 'scherp');
for (const deel of ['10^0,296 = 1,977', 'jij 1,98', 'scherp', 'log 2 = 0,3010',
                    '0,23 procent', '−1,15 procent', '2 × 0,9885 = 1,977']) {
  if (!fa.includes(deel)) fail(`feedback antilog mist "${deel}": ${fa}`);
}
const fl = L.feedback(ql, '0,531', 'scherp');
for (const deel of ['log 3,40 = 0,5315', 'jij 0,531', '−0,0005', 'log 3,5 = 0,5441',
                    'log 7 − log 2 = 0,8451 − 0,3010', '1 procent is 0,00434',
                    '0,5441 − 0,0124 = 0,5317']) {
  if (!fl.includes(deel)) fail(`feedback log mist "${deel}": ${fl}`);
}
// een fout antwoord krijgt dezelfde uitleg, zonder het woord scherp
if (A.feedback(qa, '2,10', false).includes('scherp')) fail('fout antwoord heet toch scherp');
// nooit een punt als decimaalteken in de uitleg
for (const g of [1, 50, 123, 296, 500, 544, 843, 999]) {
  const q = vraagA(g), t = A.feedback(q, A.fmt(q.ans), 'goed');
  if (/\d\.\d/.test(t)) fail(`punt als decimaalteken in de uitleg: ${t}`);
}
for (const g of [100, 152, 250, 355, 700, 999]) {
  const q = vraagL(g), t = L.feedback(q, L.fmt(q.ans), 'goed');
  if (/\d\.\d/.test(t)) fail(`punt als decimaalteken in de uitleg: ${t}`);
}

// 13. plek tussen de ankers en de weging die daarop stuurt
if (anchorPos(0.3010) > 0.001) fail('op een anker hoort 0 te zijn');
if (anchorPos(0.325) < 0.9) fail('midden tussen 0,3010 en 0,35 hoort bij 1');
const opAnker = vraagA(301), tussenIn = vraagA(325);
if (!(A.bias(opAnker, 0) > A.bias(tussenIn, 0)))
  fail('in het begin hoort een anker zwaarder te wegen dan het midden');
if (!(A.bias(tussenIn, 1) > A.bias(opAnker, 1)))
  fail('later hoort het midden zwaarder te wegen dan een anker');
if (Math.abs(anchorBias(0, 0) - anchorBias(1, 1)) > 1e-9)
  fail('de weging hoort symmetrisch te zijn in de fase');
// de bias blijft binnen een bereik dat de urgentie niet overstemt
for (let u = 0; u <= 1; u += 0.05) for (const t of [0, 0.5, 1]) {
  const b = anchorBias(u, t);
  if (!(b >= 0.4 && b <= 3.01)) fail(`bias ${b} valt buiten 0,4 tot 3`);
}

console.log(fails ? `\n${fails} fouten` : 'alle controles goed');
process.exit(fails ? 1 : 0);
