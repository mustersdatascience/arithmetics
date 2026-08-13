-- Rekentrainer: sessie wegschrijven in één transactie
--
-- De client stuurt aan het eind van een sessie één jsonb-payload. Deze functie
-- schrijft de sessie, de actieve bereiken per categorie en alle pogingen weg, en
-- werkt het aggregaat per som bij inclusief de SRS-trede.
--
-- Idempotent op (user_id, client_id): een sessie die al binnen is wordt niet
-- nog eens verwerkt. Daardoor mag de wachtrij in de app gerust opnieuw sturen
-- als hij niet zeker weet of een eerdere poging is aangekomen.

create or replace function public.sync_session(payload jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  sid uuid;
begin
  if uid is null then
    raise exception 'niet ingelogd';
  end if;

  insert into public.sessions (
    user_id, client_id, kind, preset, started_at, ended_at,
    limit_s, elapsed_s, n_correct, n_wrong, config)
  values (
    uid,
    payload ->> 'client_id',
    coalesce(payload ->> 'kind', 'practice'),
    nullif(payload ->> 'preset', ''),
    (payload ->> 'started_at')::timestamptz,
    (payload ->> 'ended_at')::timestamptz,
    coalesce((payload ->> 'limit_s')::integer, 0),
    coalesce((payload ->> 'elapsed_s')::numeric, 0),
    coalesce((payload ->> 'n_correct')::integer, 0),
    coalesce((payload ->> 'n_wrong')::integer, 0),
    coalesce(payload -> 'config', '{}'::jsonb))
  on conflict (user_id, client_id) do nothing
  returning id into sid;

  -- Al eerder binnengekomen: niets dubbel verwerken.
  if sid is null then
    select id into sid
    from public.sessions
    where user_id = uid and client_id = payload ->> 'client_id';
    return sid;
  end if;

  -- De kansen-klok: welke bereiken stonden aan en hoeveel sommen deed je erin.
  insert into public.session_modes (
    session_id, user_id, mode, lo1, hi1, lo2, hi2, base, swappable, answered, started_at)
  select
    sid, uid, m.mode, m.lo1, m.hi1, m.lo2, m.hi2, m.base,
    coalesce(m.swappable, false), coalesce(m.answered, 0),
    (payload ->> 'started_at')::timestamptz
  from jsonb_to_recordset(coalesce(payload -> 'modes', '[]'::jsonb))
    as m(mode text, lo1 integer, hi1 integer, lo2 integer, hi2 integer,
         base integer, swappable boolean, answered integer);

  -- De ruwe log.
  insert into public.attempts (
    user_id, session_id, problem_key, mode, g1, g2, base,
    display, answer, ms, ok, outlier, asked_at)
  select
    uid, sid, a.problem_key, a.mode, a.g1, a.g2, a.base,
    a.display, a.answer, a.ms, a.ok, coalesce(a.outlier, false), a.asked_at
  from jsonb_to_recordset(coalesce(payload -> 'attempts', '[]'::jsonb))
    as a(problem_key text, mode text, g1 integer, g2 integer, base integer,
         display text, answer double precision, ms integer, ok boolean,
         outlier boolean, asked_at timestamptz);

  -- Het aggregaat per som. Uitschieters (onderbroken sommen) tellen niet mee.
  with src as (
    select
      a.problem_key, a.mode, a.g1, a.g2, a.base, a.display,
      coalesce(a.swappable, false) as swappable,
      a.ms, a.ok, a.asked_at
    from jsonb_to_recordset(coalesce(payload -> 'attempts', '[]'::jsonb))
      as a(problem_key text, mode text, g1 integer, g2 integer, base integer,
           display text, swappable boolean, ms integer, ok boolean,
           outlier boolean, asked_at timestamptz)
    where not coalesce(a.outlier, false)
  ),
  agg as (
    select
      problem_key,
      min(mode) as mode,
      min(g1) as g1,
      min(g2) as g2,
      min(base) as base,
      min(display) as display,
      bool_or(swappable) as swappable,
      count(*)::integer as n,
      count(*) filter (where ok)::integer as n_ok,
      sum(ms)::bigint as sum_ms,
      bool_or(not ok) as had_wrong,
      min(ms) filter (where ok) as best_ms,
      (array_agg(ms order by asked_at desc))[1] as last_ms,
      (array_agg(ms order by asked_at desc) filter (where ok))[1:5] as recent_new,
      min(asked_at) as first_at,
      max(asked_at) as last_at
    from src
    group by problem_key
  )
  insert into public.problem_stats (
    user_id, problem_key, mode, g1, g2, base, swappable, display,
    n, n_ok, sum_ms, recent_ms, best_ms, last_ms, srs_step,
    first_seen_at, last_seen_at)
  select
    uid, g.problem_key, g.mode, g.g1, g.g2, g.base, g.swappable, g.display,
    g.n, g.n_ok, g.sum_ms,
    coalesce(g.recent_new, '{}'),
    g.best_ms, g.last_ms,
    -- nieuwe som: fout gedaan start op trede 0, goed gedaan op trede 1
    case when g.had_wrong then 0 else 1 end,
    g.first_at, g.last_at
  from agg g
  on conflict (user_id, problem_key) do update set
    n         = problem_stats.n + excluded.n,
    n_ok      = problem_stats.n_ok + excluded.n_ok,
    sum_ms    = problem_stats.sum_ms + excluded.sum_ms,
    recent_ms = (excluded.recent_ms || problem_stats.recent_ms)[1:5],
    best_ms   = least(coalesce(problem_stats.best_ms, excluded.best_ms), excluded.best_ms),
    last_ms   = excluded.last_ms,
    display   = excluded.display,
    legacy    = false,
    last_seen_at = greatest(problem_stats.last_seen_at, excluded.last_seen_at),
    srs_step  = case
      -- excluded.srs_step is 0 als er een fout tussen zat: terug naar het begin
      when excluded.srs_step = 0 then 0
      -- goed maar duidelijk trager dan je eigen gemiddelde: blijf staan
      when problem_stats.n > 0
       and excluded.best_ms > (problem_stats.sum_ms::numeric / problem_stats.n) * 1.5
        then problem_stats.srs_step
      else least(problem_stats.srs_step + 1, 5)
    end;

  return sid;
end
$$;

grant execute on function public.sync_session(jsonb) to authenticated;

-- ------------------------------------------------------------------------
-- Eén view voor de app: statistiek en due-status per som in één query.
create view public.problem_board
with (security_invoker = true) as
select
  r.*,
  d.opps_since,
  d.target_opps,
  d.is_due
from public.problem_ranked r
join public.problem_due d
  on d.user_id = r.user_id and d.problem_key = r.problem_key;

grant select on public.problem_board to authenticated;
