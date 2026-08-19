/* Oefensoorten.
   Elke modus levert:
     gen(c)            -> een verse som binnen de ingestelde bereiken
     build(g1,g2,base) -> dezelfde som opnieuw opbouwen uit opgeslagen operanden
                          (nodig voor de stampmodus, die uit de database trekt)
     range(c)          -> de bereiken zoals ze in session_modes belanden; dat is
                          waarop de kansen-klok bepaalt of een som getrokken
                          had kunnen worden

   g1 en g2 zijn de generator-invoer, niet per se wat je op het scherm ziet.
   Bij aftrekken is g1 het antwoord en g2 de aftrekker; het aftrekgetal is g1+g2.
   Bij optellen en vermenigvuldigen staan ze gesorteerd, zodat 98+43 en 43+98
   dezelfde som zijn. Die modi zijn daarom swappable: bij het bepalen van een
   kans mogen de twee bereiken verwisseld worden.
*/

export const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
export const pick = arr => arr[Math.floor(Math.random() * arr.length)];

const PCTS = [5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 80];

/* ------------------------------------------------------------ logaritmen

   De ankers waartussen je interpoleert, met de twee vuistregels die de app in
   de feedback gebruikt. Ze zijn elkaars omgekeerde: 0,001 in de log is 0,23
   procent in het getal, en 1 procent in het getal is 0,00434 in de log.

   Alles staat hier in log-ruimte, want daarin wordt ook het dichtstbijzijnde
   anker gekozen: bij antilog is de vraag zelf al een logwaarde, bij log is het
   het antwoord. */

const PCT_PER_MILLI = 0.23;    // procent in het getal per 0,001 log
const LOG_PER_PCT = 0.00434;   // log per procent in het getal

const komma = s => String(s).replace('.', ',');
const dec = (n, d) => komma(n.toFixed(d));
const dec3 = n => dec(n, 3);
/* Drie significante cijfers; tussen 1 en 10 zijn dat twee decimalen. */
const sig3 = n => dec(n, n >= 9.995 ? 1 : 2);
/* Een ankergetal zoals je het uitspreekt: 2, 3,5, 1,995, 10. */
const tal = n => komma(String(Math.round(n * 1000) / 1000));
const teken = (n, d) => (n < 0 ? '−' : '+') + dec(Math.abs(n), d);
const getal = s => { const n = parseFloat(String(s).replace(',', '.')); return isNaN(n) ? null : n; };

const benoemd = (num, log, deriv) => ({ num, log, named: true, deriv: deriv || null });

/* log 2, 3, 5 en 7 uit je hoofd, de veelvouden van 0,05 uit de antilog-tabel,
   en de samengestelde ankers met hun afleiding erbij. log 15 is dezelfde plek
   als log 1,5, dus die staat als tweede afleiding op datzelfde anker. */
export const ANCHORS = [
  benoemd(2, 0.3010),
  benoemd(3, 0.4771),
  benoemd(5, 0.6990),
  benoemd(7, 0.8451),
  benoemd(3.5, 0.5441, 'log 7 − log 2 = 0,8451 − 0,3010'),
  benoemd(2.5, 0.3980, '1 − log 4 = 1 − 0,6020'),
  benoemd(1.5, 0.1761, 'log 3 − log 2 = 0,4771 − 0,3010, en log 15 = log 3 + log 5 = 1,1761')
].concat(
  Array.from({ length: 21 }, (_, i) => {
    const log = Math.round(i * 5) / 100;
    return { num: Math.round(Math.pow(10, log) * 1000) / 1000, log, named: false, deriv: null };
  })
).sort((a, b) => a.log - b.log);

/* Het anker waar een logwaarde het dichtst bij ligt.

   Een tabelanker ligt soms vlak naast een benoemd anker: 0,300 naast
   log 2 = 0,3010. Op kale afstand wint dan bijna altijd de tabel, terwijl "2"
   in je hoofd veel bruikbaarder is dan 1,995. Ligt er een benoemd anker binnen
   0,003 van de winnaar, dan gaat dat voor. */
export function nearestAnchor(x) {
  let dichtst = ANCHORS[0];
  for (const a of ANCHORS) if (Math.abs(a.log - x) < Math.abs(dichtst.log - x)) dichtst = a;
  if (dichtst.named) return dichtst;
  let keuze = dichtst;
  for (const a of ANCHORS) {
    if (!a.named || Math.abs(a.log - dichtst.log) > 0.003) continue;
    if (keuze === dichtst || Math.abs(a.log - x) < Math.abs(keuze.log - x)) keuze = a;
  }
  return keuze;
}

/* Dezelfde ankers, maar zonder de bijna-dubbelen: voor de vraag "hoe ver zit ik
   tussen twee ankers in" is het paar 0,300 en 0,3010 één plek en geen gat. */
const GAPS = ANCHORS.reduce((keep, a) => {
  const prev = keep[keep.length - 1];
  if (prev && a.log - prev.log <= 0.004) { if (a.named && !prev.named) keep[keep.length - 1] = a; }
  else keep.push(a);
  return keep;
}, []).map(a => a.log);

/* 0 = precies op een anker, 1 = precies in het midden tussen twee ankers. */
export function anchorPos(x) {
  let lo = -Infinity, hi = Infinity;
  for (const g of GAPS) {
    if (g <= x && g > lo) lo = g;
    if (g >= x && g < hi) hi = g;
  }
  if (!isFinite(lo) || !isFinite(hi)) return 1;
  const half = (hi - lo) / 2;
  if (!(half > 0)) return 0;
  return Math.min(1, Math.min(x - lo, hi - x) / half);
}

/* Het gewicht dat de trekking aan die plek geeft, bovenop de gewone weging.
   In de eerste sessies (t = 0) ligt het zwaartepunt op de ankers zelf, daarna
   schuift het naar het midden ertussen (t = 1). */
export function anchorBias(u, t) {
  return 0.4 + 2.6 * Math.exp(-Math.pow((u - t) / 0.35, 2));
}

/* Hoe het anker in de feedback wordt genoemd, met afleiding als die er is. */
const ankerZin = a => `log ${tal(a.num)} = ${dec(a.log, a.named ? 4 : 2)}`
  + (a.deriv ? ` (${a.deriv})` : a.named ? '' : ' (uit de tabel)');

/* De vraag uit de opgeslagen gehele eenheden. attempts.g1 is een integer-kolom
   en de kansen-klok vergelijkt g1 met lo1/hi1, dus alles wat de database in gaat
   moet heel zijn: bij antilog is g1 de exponent in duizendsten (296 = 0,296),
   bij log het getal in honderdsten (340 = 3,40). */
const antilogQ = g1 => ({ q: `10^${dec3(g1 / 1000)}`, ans: Math.pow(10, g1 / 1000), dec: true });
const logQ = g1 => ({ q: `log ${dec(g1 / 100, 2)}`, ans: Math.log10(g1 / 100), dec: true });

export const MODES = {
  add: {
    label: 'Optellen', hint: 'a + b', swappable: true,
    fields: [['a', 'Eerste getal', 2, 100], ['b', 'Tweede getal', 2, 100]],
    range: c => ({ lo1: c.a[0], hi1: c.a[1], lo2: c.b[0], hi2: c.b[1], base: null }),
    gen(c) {
      const a = rnd(...c.a), b = rnd(...c.b);
      const [x, y] = a <= b ? [a, b] : [b, a];
      return { q: `${a} + ${b}`, ans: a + b, key: `add:${x}+${y}`, g1: x, g2: y };
    },
    build: (g1, g2) => ({ q: `${g1} + ${g2}`, ans: g1 + g2 })
  },

  sub: {
    label: 'Aftrekken', hint: 'antwoord blijft positief', swappable: false,
    fields: [['a', 'Antwoord ligt tussen', 2, 100], ['b', 'Af te trekken', 2, 100]],
    range: c => ({ lo1: c.a[0], hi1: c.a[1], lo2: c.b[0], hi2: c.b[1], base: null }),
    gen(c) {
      const x = rnd(...c.a), y = rnd(...c.b);
      return { q: `${x + y} - ${y}`, ans: x, key: `sub:${x + y}-${y}`, g1: x, g2: y };
    },
    build: (g1, g2) => ({ q: `${g1 + g2} - ${g2}`, ans: g1 })
  },

  mul: {
    label: 'Vermenigvuldigen', hint: 'a x b', swappable: true,
    fields: [['a', 'Eerste getal', 2, 12], ['b', 'Tweede getal', 2, 100]],
    range: c => ({ lo1: c.a[0], hi1: c.a[1], lo2: c.b[0], hi2: c.b[1], base: null }),
    gen(c) {
      const a = rnd(...c.a), b = rnd(...c.b);
      const [x, y] = a <= b ? [a, b] : [b, a];
      return { q: `${a} x ${b}`, ans: a * b, key: `mul:${x}x${y}`, g1: x, g2: y };
    },
    build: (g1, g2) => ({ q: `${g1} x ${g2}`, ans: g1 * g2 })
  },

  div: {
    label: 'Delen', hint: 'gaat altijd op', swappable: false,
    fields: [['a', 'Antwoord ligt tussen', 2, 12], ['b', 'Deler', 2, 100]],
    range: c => ({ lo1: c.a[0], hi1: c.a[1], lo2: c.b[0], hi2: c.b[1], base: null }),
    gen(c) {
      const x = rnd(...c.a), y = rnd(...c.b);
      return { q: `${x * y} : ${y}`, ans: x, key: `div:${x * y}:${y}`, g1: x, g2: y };
    },
    build: (g1, g2) => ({ q: `${g1 * g2} : ${g2}`, ans: g1 })
  },

  sq: {
    label: 'Kwadraten', hint: 'n²', swappable: false,
    fields: [['n', 'Bereik', 2, 50]],
    range: c => ({ lo1: c.n[0], hi1: c.n[1], lo2: null, hi2: null, base: null }),
    gen(c) {
      const n = rnd(...c.n);
      return { q: `${n}²`, ans: n * n, key: `sq:${n}`, g1: n, g2: null };
    },
    build: g1 => ({ q: `${g1}²`, ans: g1 * g1 })
  },

  cube: {
    label: 'Derdemachten', hint: 'n³', swappable: false,
    fields: [['n', 'Bereik', 2, 20]],
    range: c => ({ lo1: c.n[0], hi1: c.n[1], lo2: null, hi2: null, base: null }),
    gen(c) {
      const n = rnd(...c.n);
      return { q: `${n}³`, ans: n * n * n, key: `cube:${n}`, g1: n, g2: null };
    },
    build: g1 => ({ q: `${g1}³`, ans: g1 * g1 * g1 })
  },

  compl: {
    label: 'Complementen', hint: 'aanvullen tot een rond getal', swappable: false,
    fields: [['n', 'Bereik', 2, 99]],
    selects: [['base', 'Basis', [100, 1000, 10000]]],
    // base 0 betekent "elke basis"; dat komt alleen uit het statistiekfilter,
    // een echte sessie heeft altijd 100, 1000 of 10000
    range: c => {
      const b = +c.base || 0;
      return {
        lo1: c.n[0], hi1: b ? Math.min(c.n[1], b - 1) : c.n[1],
        lo2: null, hi2: null, base: b || null
      };
    },
    gen(c) {
      const b = +c.base, n = rnd(c.n[0], Math.min(c.n[1], b - 1));
      return { q: `${b} - ${n}`, ans: b - n, key: `compl${b}:${n}`, g1: n, g2: null, base: b };
    },
    build: (g1, g2, base) => ({ q: `${base} - ${g1}`, ans: base - g1 })
  },

  pct: {
    label: 'Procenten', hint: 'x procent van y', swappable: false,
    fields: [['y', 'Bereik van y', 20, 900]],
    // het percentage komt uit een vaste lijst en is dus altijd trekbaar;
    // alleen y bepaalt of een som binnen de sessie viel
    range: c => ({ lo1: 0, hi1: 100, lo2: c.y[0], hi2: c.y[1], base: null }),
    gen(c) {
      const p = pick(PCTS), y = rnd(...c.y);
      return { q: `${p}% van ${y}`, ans: y * p / 100, dec: true, key: `pct:${p}of${y}`, g1: p, g2: y };
    },
    build: (g1, g2) => ({ q: `${g1}% van ${g2}`, ans: g2 * g1 / 100, dec: true })
  },

  recip: {
    label: 'Reciprocals', hint: '1 gedeeld door n, decimaal', swappable: false,
    fields: [['n', 'Bereik', 2, 30]],
    range: c => ({ lo1: c.n[0], hi1: c.n[1], lo2: null, hi2: null, base: null }),
    gen(c) {
      const n = rnd(...c.n);
      return { q: `1 : ${n}`, ans: 1 / n, dec: true, key: `recip:${n}`, g1: n, g2: null };
    },
    build: g1 => ({ q: `1 : ${g1}`, ans: 1 / g1, dec: true })
  },
  antilog: {
    label: 'Antilog interpolatie', hint: '10 tot de macht x', swappable: false,
    fields: [['x', 'Exponent in duizendsten', 1, 999]],
    tolHint: 'op drie significante cijfers, goed binnen 0,5 procent',
    range: c => ({ lo1: c.x[0], hi1: c.x[1], lo2: null, hi2: null, base: null }),
    gen(c) {
      const g1 = rnd(...c.x);
      return { ...antilogQ(g1), key: `antilog:${g1}`, g1, g2: null };
    },
    build: g1 => antilogQ(g1),
    fmt: sig3,
    grade: (num, q) => {
      const d = Math.abs(num - q.ans) / q.ans;
      return d <= 0.001 ? 'scherp' : d <= 0.005 ? 'goed' : false;
    },
    // drie significante cijfers getypt; pas dan is het antwoord af
    complete: t => t.replace(/\D/g, '').length >= 3,
    bias: (q, t) => anchorBias(anchorPos(q.g1 / 1000), t),
    feedback(q, given, res) {
      const x = q.g1 / 1000;
      const a = nearestAnchor(x);
      const d = x - a.log;
      const pct = d / 0.001 * PCT_PER_MILLI;
      const factor = 1 + pct / 100;
      const jij = getal(given);
      const uit = [`10^${dec3(x)} = ${dec(q.ans, 3)}`];
      if (jij != null) {
        uit.push(`jij ${komma(given)}, ${teken((jij - q.ans) / q.ans * 100, 2)} procent`
          + (res === 'scherp' ? ', scherp' : ''));
      }
      uit.push(`anker ${ankerZin(a)}`);
      uit.push(Math.abs(d) < 1e-9
        ? `${dec3(x)} is precies het anker, dus ${tal(a.num)}`
        : `${dec3(x)} ligt ${dec(Math.abs(d), 4)} ${d < 0 ? 'onder' : 'boven'} `
          + `${dec(a.log, a.named ? 4 : 2)} en 0,001 log is ${komma(PCT_PER_MILLI)} procent, `
          + `dus ${teken(pct, 2)} procent: ${tal(a.num)} × ${dec(factor, 4)} = ${dec(a.num * factor, 3)}`);
      return uit.join(' · ');
    }
  },

  log: {
    label: 'Log interpolatie', hint: 'log van een getal tussen 1 en 10', swappable: false,
    fields: [['m', 'Getal in honderdsten', 100, 999]],
    tolHint: 'op drie decimalen, goed binnen 0,005',
    range: c => ({ lo1: c.m[0], hi1: c.m[1], lo2: null, hi2: null, base: null }),
    gen(c) {
      const g1 = rnd(...c.m);
      return { ...logQ(g1), key: `log:${g1}`, g1, g2: null };
    },
    build: g1 => logQ(g1),
    fmt: n => dec(n, 3),
    grade: (num, q) => {
      const d = Math.abs(num - q.ans);
      return d <= 0.002 ? 'scherp' : d <= 0.005 ? 'goed' : false;
    },
    // drie decimalen getypt
    complete: t => (t.split(',')[1] || '').length >= 3,
    bias: (q, t) => anchorBias(anchorPos(Math.log10(q.g1 / 100)), t),
    feedback(q, given, res) {
      const n = q.g1 / 100;
      const a = nearestAnchor(q.ans);
      const pct = (n - a.num) / a.num * 100;
      const d = pct * LOG_PER_PCT;
      const jij = getal(given);
      const uit = [`log ${dec(n, 2)} = ${dec(q.ans, 4)}`];
      if (jij != null) {
        uit.push(`jij ${komma(given)}, ${teken(jij - q.ans, 4)}`
          + (res === 'scherp' ? ', scherp' : ''));
      }
      uit.push(`anker ${ankerZin(a)}`);
      uit.push(Math.abs(pct) < 0.005
        ? `${dec(n, 2)} is precies het anker, dus ${dec(a.log, 4)}`
        : `${dec(n, 2)} ligt ${dec(Math.abs(pct), 2)} procent ${pct < 0 ? 'onder' : 'boven'} `
          + `${tal(a.num)} en 1 procent is ${komma(LOG_PER_PCT)}, dus ${teken(d, 4)}: `
          + `${dec(a.log, 4)} ${d < 0 ? '−' : '+'} ${dec(Math.abs(d), 4)} = ${dec(a.log + d, 4)}`);
      return uit.join(' · ');
    }
  }
};

export const PRESETS = {
  zetamac: {
    label: 'Zetamac', dur: 120, cfg: {
      add: { on: 1, a: [2, 100], b: [2, 100] }, sub: { on: 1, a: [2, 100], b: [2, 100] },
      mul: { on: 1, a: [2, 12], b: [2, 100] }, div: { on: 1, a: [2, 12], b: [2, 100] }
    }
  },
  fundament: {
    label: 'Fundament', dur: 120, cfg: {
      sq: { on: 1, n: [2, 50] }, mul: { on: 1, a: [2, 19], b: [2, 19] },
      sub: { on: 1, a: [10, 99], b: [10, 99] }
    }
  },
  kwadraten: { label: 'Kwadraten 2-50', dur: 120, cfg: { sq: { on: 1, n: [2, 50] } } },
  tafels: { label: 'Tafels 2-19', dur: 120, cfg: { mul: { on: 1, a: [2, 19], b: [2, 19] } } },
  eencijferig: { label: '2-cijferig x 1', dur: 120, cfg: { mul: { on: 1, a: [2, 9], b: [10, 99] } } },
  aftrekken: { label: 'Aftrekken 2-cijferig', dur: 120, cfg: { sub: { on: 1, a: [10, 99], b: [10, 99] } } },
  logaritmen: {
    label: 'Logaritmen', dur: 120, cfg: {
      antilog: { on: 1, x: [1, 999] }, log: { on: 1, m: [100, 999] }
    }
  },
  vier: {
    label: '4-cijferig', dur: 180, cfg: {
      add: { on: 1, a: [1000, 9999], b: [1000, 9999] },
      sub: { on: 1, a: [1000, 9999], b: [1000, 9999] }
    }
  }
};

/* Past een opgeslagen som binnen de nu ingestelde bereiken? Dezelfde regel als
   de kansen-klok in de database, zodat de stampmodus en de klok het eens zijn. */
export function eligible(row, cfg) {
  const m = MODES[row.mode];
  const c = cfg[row.mode];
  if (!m || !c || !c.on) return false;
  const r = m.range(c);
  if (r.base != null && row.base !== r.base) return false;
  const inFirst = row.g1 >= r.lo1 && row.g1 <= r.hi1;
  const inSecond = r.lo2 == null || row.g2 == null || (row.g2 >= r.lo2 && row.g2 <= r.hi2);
  if (inFirst && inSecond) return true;
  if (m.swappable && row.g2 != null && r.lo2 != null) {
    return row.g2 >= r.lo1 && row.g2 <= r.hi1 && row.g1 >= r.lo2 && row.g1 <= r.hi2;
  }
  return false;
}

/* Oude localStorage-sleutels terugvertalen naar mode + operanden, zodat je
   bestaande historie mee kan naar de database. */
export function parseLegacyKey(key) {
  let m;
  if ((m = key.match(/^add:(\d+)\+(\d+)$/)))
    return { mode: 'add', g1: +m[1], g2: +m[2], base: null, display: `${m[1]} + ${m[2]}` };
  if ((m = key.match(/^sub:(\d+)-(\d+)$/)))
    return { mode: 'sub', g1: +m[1] - +m[2], g2: +m[2], base: null, display: `${m[1]} - ${m[2]}` };
  if ((m = key.match(/^mul:(\d+)x(\d+)$/)))
    return { mode: 'mul', g1: +m[1], g2: +m[2], base: null, display: `${m[1]} x ${m[2]}` };
  if ((m = key.match(/^div:(\d+):(\d+)$/)))
    return { mode: 'div', g1: +m[1] / +m[2], g2: +m[2], base: null, display: `${m[1]} : ${m[2]}` };
  if ((m = key.match(/^sq:(\d+)$/)))
    return { mode: 'sq', g1: +m[1], g2: null, base: null, display: `${m[1]}²` };
  if ((m = key.match(/^cube:(\d+)$/)))
    return { mode: 'cube', g1: +m[1], g2: null, base: null, display: `${m[1]}³` };
  if ((m = key.match(/^compl(\d+):(\d+)$/)))
    return { mode: 'compl', g1: +m[2], g2: null, base: +m[1], display: `${m[1]} - ${m[2]}` };
  if ((m = key.match(/^pct:(\d+)of(\d+)$/)))
    return { mode: 'pct', g1: +m[1], g2: +m[2], base: null, display: `${m[1]}% van ${m[2]}` };
  if ((m = key.match(/^recip:(\d+)$/)))
    return { mode: 'recip', g1: +m[1], g2: null, base: null, display: `1 : ${m[1]}` };
  if ((m = key.match(/^antilog:(\d+)$/)))
    return { mode: 'antilog', g1: +m[1], g2: null, base: null, display: antilogQ(+m[1]).q };
  if ((m = key.match(/^log:(\d+)$/)))
    return { mode: 'log', g1: +m[1], g2: null, base: null, display: logQ(+m[1]).q };
  return null;
}
