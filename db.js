/* Supabase-laag: inloggen, sessies wegschrijven, statistiek ophalen.

   De publishable key hoort publiek te zijn; alle tabellen staan achter row level
   security die aan auth.uid() hangt, dus je ziet en schrijft alleen je eigen rijen.

   Tijdens het rekenen praat de app nooit met de database. Aan het eind van een
   sessie gaat er één payload de wachtrij in; die wordt geleegd zodra het lukt.
   sync_session is idempotent op client_id, dus opnieuw sturen is altijd veilig. */

// supabase-js staat als gebundeld bestand in de repo, niet op een CDN. Zo laadt
// de app zonder derde partij en blijft hij werken als je geen bereik hebt.
// Opnieuw bouwen: zie het vendor-script in package.json.
import { createClient } from './vendor/supabase.js';
import { parseLegacyKey } from './modes.js';

const SUPABASE_URL = 'https://yglxjsnzhcgoxkqcvbdx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_4YEM6640g92Q6fNhrItYDA_kla9PjwB';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'rt_auth' }
});

const OUTBOX = 'rt_outbox';
const PAGE = 1000;   // PostgREST levert maximaal 1000 rijen per verzoek

/* ------------------------------------------------------------- inloggen */

export async function currentUser() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user ?? null;
}

export function onAuthChange(fn) {
  supabase.auth.onAuthStateChange((_e, session) => fn(session?.user ?? null));
}

export async function signIn(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signUp(email, password) {
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
}

export async function signOut() {
  await supabase.auth.signOut();
}

/* -------------------------------------------------------------- wachtrij */

function readOutbox() {
  try { return JSON.parse(localStorage.getItem(OUTBOX) || '[]'); } catch { return []; }
}

function writeOutbox(box) {
  try { localStorage.setItem(OUTBOX, JSON.stringify(box)); } catch { /* vol, jammer */ }
}

export function outboxSize() {
  return readOutbox().length;
}

/* Zet een afgeronde sessie in de wachtrij en probeer hem meteen te versturen. */
export async function queueSession(payload) {
  const box = readOutbox();
  box.push(payload);
  writeOutbox(box);
  return flushOutbox();
}

/* Verstuur alles wat nog openstaat. Stopt bij de eerste fout zodat de volgorde
   bewaard blijft; de rest blijft staan tot een volgende poging. */
export async function flushOutbox() {
  const box = readOutbox();
  if (!box.length) return { sent: 0, left: 0 };
  if (!(await currentUser())) return { sent: 0, left: box.length };

  let sent = 0;
  while (sent < box.length) {
    const { error } = await supabase.rpc('sync_session', { payload: box[sent] });
    if (error) break;
    sent++;
  }
  const left = box.slice(sent);
  writeOutbox(left);
  return { sent, left: left.length };
}

/* --------------------------------------------------------------- lezen */

async function selectAll(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) return out;
  }
}

/* Alles wat de app per som moet weten: gemiddelde, recente tijd, relatieve
   traagheid, foutratio, SRS-trede en of hij volgens de kansen-klok terug moet. */
export async function loadBoard(modes) {
  return selectAll(() => {
    let q = supabase.from('problem_board').select(
      'problem_key,mode,g1,g2,base,display,n,n_ok,avg_ms,recent_ms,acc,' +
      'norm_ms,relative,struggle,srs_step,opps_since,target_opps,is_due,last_seen_at,legacy'
    );
    if (modes && modes.length) q = q.in('mode', modes);
    return q;
  });
}

export async function loadFamilies() {
  return selectAll(() => supabase.from('family_stats').select('*'));
}

export async function loadSessions(limit = 60) {
  const { data, error } = await supabase
    .from('sessions')
    .select('id,started_at,elapsed_s,limit_s,n_correct,n_wrong,preset,kind')
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

/* ------------------------------------------------- eenmalige overname */

/* Neemt rt_stats en rt_hist uit localStorage over. Bestaande rijen blijven
   staan, dus nog eens draaien verandert niets.

   Van de oude data weten we alleen totalen: hoe vaak, hoe vaak goed, en de
   opgetelde tijd. Losse tijden per poging zijn er niet, dus recent_ms krijgt
   het gemiddelde als beste benadering en de rij wordt als legacy gemarkeerd. */
export async function importLegacy(stats, hist) {
  const user = await currentUser();
  if (!user) throw new Error('niet ingelogd');

  const rows = [];
  for (const [key, v] of Object.entries(stats || {})) {
    if (!v || !v.n) continue;
    const p = parseLegacyKey(key);
    if (!p) continue;
    const avg = Math.round(v.ms / v.n);
    const acc = v.ok / v.n;
    rows.push({
      user_id: user.id, problem_key: key, mode: p.mode,
      g1: p.g1, g2: p.g2, base: p.base, display: p.display,
      swappable: p.mode === 'add' || p.mode === 'mul',
      n: v.n, n_ok: v.ok, sum_ms: v.ms,
      recent_ms: [avg], best_ms: avg, last_ms: avg,
      srs_step: acc < 0.9 ? 0 : Math.min(2, Math.floor(v.n / 3)),
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      legacy: true
    });
  }

  const sessions = (hist || []).map(h => ({
    user_id: user.id,
    client_id: 'legacy-' + h.d,
    kind: 'practice',
    preset: h.label || null,
    started_at: new Date(h.d - (h.secs || 0) * 1000).toISOString(),
    ended_at: new Date(h.d).toISOString(),
    limit_s: h.secs || 0,
    elapsed_s: h.secs || 0,
    n_correct: h.goed || 0,
    n_wrong: Math.max(0, Math.round((h.goed || 0) * (100 - (h.acc ?? 100)) / Math.max(1, h.acc || 100))),
    config: {}
  }));

  let imported = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('problem_stats')
      .upsert(rows.slice(i, i + 500), { onConflict: 'user_id,problem_key', ignoreDuplicates: true });
    if (error) throw error;
    imported += Math.min(500, rows.length - i);
  }
  for (let i = 0; i < sessions.length; i += 500) {
    const { error } = await supabase.from('sessions')
      .upsert(sessions.slice(i, i + 500), { onConflict: 'user_id,client_id', ignoreDuplicates: true });
    if (error) throw error;
  }
  return { problems: imported, sessions: sessions.length };
}
