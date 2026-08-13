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

async function selectAll(build, maxPages = 40) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * PAGE;
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

/* Alles wat de app per som moet weten.

   expected_rel is de schatting van hoe lang je er nu over doet, in verhouding
   tot je eigen normtijd voor dat soort som: 1,0 is precies gemiddeld. Die
   schatting is naar het familiegemiddelde getrokken, zwaarder naarmate je
   minder metingen hebt. predicted_rel telt daar de tijd bij op die sinds de
   laatste keer verstreken is, en urgency zet dat af tegen je doeltijd. */
export async function loadBoard(modes) {
  return selectAll(() => {
    let q = supabase.from('problem_board').select(
      'problem_key,mode,g1,g2,base,display,n,n_ok,acc,n_recent,norm_ms,' +
      'prior_rel,expected_rel,expected_s,predicted_rel,urgency,is_due,last_seen_at,legacy'
    );
    if (modes && modes.length) q = q.in('mode', modes);
    return q;
  });
}

export async function loadFamilies() {
  return selectAll(() => supabase.from('family_stats').select('*'));
}

export async function loadSessions(limit = 300) {
  const { data, error } = await supabase
    .from('sessions')
    .select('id,started_at,elapsed_s,limit_s,n_correct,n_wrong,preset,kind,config')
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

/* Gooit een sessie weg inclusief wat hij aan je somstatistiek bijdroeg. Nodig
   voor sessies die je na een paar seconden wegklikt: die staan vol gehaaste
   antwoorden en vertekenen je gemiddelden. */
export async function deleteSession(id) {
  const { error } = await supabase.rpc('delete_session', { p_session_id: id });
  if (error) throw error;
}

/* Hetzelfde, maar met het id dat de app zelf aan de sessie gaf. Nodig op het
   resultaatscherm: daar is de sessie net weggestuurd en weet de app de sleutel
   uit de database nog niet.

   Staat hij nog in de wachtrij, dan wordt hij daar weggehaald en heeft de
   database hem nooit gezien. Is hij al verstuurd, dan gaat ook zijn bijdrage
   aan je somstatistiek er weer af. Allebei kan: verwijderen terwijl er nog
   oudere sessies voor hem in de rij staan. */
export async function dropSession(clientId) {
  const box = readOutbox();
  const left = box.filter(p => p.client_id !== clientId);
  const uitRij = left.length !== box.length;
  if (uitRij) writeOutbox(left);

  const { data, error } = await supabase
    .from('sessions').select('id').eq('client_id', clientId).maybeSingle();
  if (error) throw error;
  if (data) await deleteSession(data.id);
  return { uitRij, uitDatabase: !!data };
}

/* ------------------------------------------------------- modelparameters */

export async function loadModelParams() {
  const { data, error } = await supabase
    .from('model_params')
    .select('penalty,prior,decay,target,fitted_at,n_attempts')
    .maybeSingle();
  if (error) throw error;
  return data;
}

/* De doeltijd is geen meting maar jouw keuze: hoe snel wil je zijn voordat een
   som als beheerst geldt. Lager betekent vaker herhalen. */
export async function saveTarget(target) {
  const user = await currentUser();
  if (!user) throw new Error('niet ingelogd');
  const { error } = await supabase.from('model_params')
    .upsert({ user_id: user.id, target, updated_at: new Date().toISOString() },
            { onConflict: 'user_id' });
  if (error) throw error;
}

/* IJkt de parameters opnieuw op je eigen historie, maar alleen als er genoeg
   nieuwe pogingen bij zijn gekomen. Vaker heeft geen zin en kost alleen tijd. */
export async function maybeFitModel(minNew = 150) {
  const { count, error } = await supabase
    .from('attempts').select('id', { count: 'exact', head: true });
  if (error || count == null) return null;

  let params = null;
  try { params = await loadModelParams(); } catch { /* nog geen rij */ }
  if (params && count - (params.n_attempts || 0) < minNew) return null;

  const { data, error: fitError } = await supabase.rpc('fit_model_params');
  if (fitError) return null;
  return data;
}

/* ---------------------------------------------------------- eigen presets */

export async function loadPresets() {
  const { data, error } = await supabase
    .from('presets').select('id,name,config,limit_s').order('name');
  if (error) throw error;
  return data;
}

export async function savePreset(name, config, limit_s) {
  const user = await currentUser();
  if (!user) throw new Error('niet ingelogd');
  const { error } = await supabase.from('presets').upsert(
    { user_id: user.id, name, config, limit_s, updated_at: new Date().toISOString() },
    { onConflict: 'user_id,name' });
  if (error) throw error;
}

export async function deletePreset(id) {
  const { error } = await supabase.from('presets').delete().eq('id', id);
  if (error) throw error;
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
