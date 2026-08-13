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
    range: c => ({
      lo1: c.n[0], hi1: Math.min(c.n[1], +c.base - 1),
      lo2: null, hi2: null, base: +c.base
    }),
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
  return null;
}
