-- Een sessie weggooien, inclusief wat hij aan je statistiek heeft bijgedragen
--
-- Nodig voor sessies die je na drie seconden wegklikt: die staan vol met
-- gehaaste of half ingetypte antwoorden en vertekenen je gemiddelden.
--
-- Alleen de rij uit sessions verwijderen is niet genoeg. De pogingen hangen er
-- met `on delete set null` aan, dus die zouden achterblijven zonder sessie én
-- meegeteld blijven in problem_stats, dat als opgeteld aggregaat is opgebouwd.
--
-- Daarom wordt de bijdrage van de sessie afgetrokken in plaats van dat het
-- aggregaat opnieuw wordt berekend. Dat is belangrijk voor overgenomen
-- historie: die heeft geen losse pogingen, dus opnieuw berekenen zou jaren
-- oefening wegvagen. Aftrekken laat dat deel staan.

create or replace function public.delete_session(p_session_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'niet ingelogd';
  end if;

  if not exists (
    select 1 from public.sessions where id = p_session_id and user_id = uid
  ) then
    raise exception 'sessie niet gevonden';
  end if;

  -- welke sommen raakt dit, en met hoeveel?
  create temp table _weg on commit drop as
  select
    problem_key,
    count(*) filter (where not outlier)::integer          as n,
    count(*) filter (where not outlier and ok)::integer   as n_ok,
    coalesce(sum(ms) filter (where not outlier), 0)::bigint as sum_ms
  from public.attempts
  where user_id = uid and session_id = p_session_id
  group by problem_key;

  update public.problem_stats p
     set n      = greatest(0, p.n - w.n),
         n_ok   = greatest(0, p.n_ok - w.n_ok),
         sum_ms = greatest(0, p.sum_ms - w.sum_ms)
    from _weg w
   where p.user_id = uid and p.problem_key = w.problem_key;

  delete from public.attempts
   where user_id = uid and session_id = p_session_id;

  -- laatst gezien opnieuw bepalen uit wat er overblijft; zonder pogingen valt
  -- hij terug op eerst gezien, zodat de kansen-klok blijft lopen
  update public.problem_stats p
     set last_seen_at = coalesce(
           (select max(a.asked_at) from public.attempts a
             where a.user_id = uid and a.problem_key = p.problem_key),
           p.first_seen_at)
    from _weg w
   where p.user_id = uid and p.problem_key = w.problem_key;

  -- sommen die alleen door deze sessie bestonden verdwijnen weer
  delete from public.problem_stats p
   using _weg w
   where p.user_id = uid and p.problem_key = w.problem_key
     and p.n <= 0 and not p.legacy;

  delete from public.sessions where id = p_session_id and user_id = uid;
end
$$;

grant execute on function public.delete_session(uuid) to authenticated;
