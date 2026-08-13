-- Parameters die zichzelf ijken op je eigen historie
--
-- De vier constanten uit 0005 stonden op een beredeneerde schatting. Drie ervan
-- zijn geen keuze maar een meting, en die kun je uit je eigen pogingen halen.
-- Elk heeft een directe schatter, dus er is geen zoektocht over een rooster
-- nodig en elke waarde blijft uit te leggen:
--
--   rt_decay    regressie van hoeveel trager je werd op ln(1 + dagen ertussen)
--   rt_penalty  wat er werkelijk gebeurde bij de eerstvolgende keer na een fout
--   rt_prior    variantie binnen een som gedeeld door variantie tussen sommen
--               (de standaard empirische-Bayes-schatter voor shrinkage)
--
-- rt_target is bewust niet meegefit. Hoe snel je wil zijn voordat iets als
-- beheerst geldt is een voorkeur, geen eigenschap van je geheugen. Die staat
-- als instelling in dezelfde tabel.
--
-- Drie beveiligingen, want een model dat zichzelf bijstelt kan ook wegdrijven:
--   * niets fitten onder een minimum aan bruikbare metingen
--   * elke uitkomst klemmen op een verdedigbaar bereik
--   * elke fit loggen met de gebruikte aantallen, zodat je terug kunt kijken

create table public.model_params (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  penalty     numeric not null default 3.0,
  prior       numeric not null default 3.0,
  decay       numeric not null default 0.35,
  target      numeric not null default 1.5,   -- jouw keuze, wordt niet gefit
  fitted_at   timestamptz,
  n_attempts  integer not null default 0,
  updated_at  timestamptz not null default now()
);

create table public.model_fits (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  fitted_at   timestamptz not null default now(),
  penalty     numeric, prior numeric, decay numeric,
  n_attempts  integer, n_pairs integer, n_after_wrong integer, n_problems integer,
  note        text
);

create index model_fits_user_idx on public.model_fits (user_id, fitted_at desc);

alter table public.model_params enable row level security;
alter table public.model_fits   enable row level security;

create policy "eigen parameters" on public.model_params
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "eigen fits" on public.model_fits
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ------------------------------------------------- constanten worden lookups

-- Niet meer immutable: ze lezen nu je eigen gefitte waarde, met de oude
-- schatting als terugval zolang er te weinig data is.
create or replace function public.rt_penalty()
returns numeric language sql stable security invoker set search_path = ''
as $$ select coalesce((select penalty from public.model_params
                       where user_id = auth.uid()), 3.0::numeric) $$;

create or replace function public.rt_prior()
returns numeric language sql stable security invoker set search_path = ''
as $$ select coalesce((select prior from public.model_params
                       where user_id = auth.uid()), 3.0::numeric) $$;

create or replace function public.rt_decay()
returns numeric language sql stable security invoker set search_path = ''
as $$ select coalesce((select decay from public.model_params
                       where user_id = auth.uid()), 0.35::numeric) $$;

create or replace function public.rt_target()
returns numeric language sql stable security invoker set search_path = ''
as $$ select coalesce((select target from public.model_params
                       where user_id = auth.uid()), 1.5::numeric) $$;

-- ------------------------------------------------------------------ fitten

create or replace function public.fit_model_params()
returns public.model_params
language plpgsql security invoker set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  n_att integer;
  v_decay numeric; n_pairs integer;
  v_penalty numeric; n_wrong integer;
  v_prior numeric; n_probs integer;
  within_var numeric; between_var numeric;
  note text := '';
  out public.model_params;
begin
  if uid is null then raise exception 'niet ingelogd'; end if;

  select count(*) into n_att from public.attempt_scored where user_id = uid;

  -- Elke poging omgerekend naar een verhouding tot je normtijd voor die vorm.
  create temp table _rel on commit drop as
  select
    a.problem_key, a.ok, a.asked_at,
    a.ms::numeric / nullif(n.norm_ms, 0) as rel
  from public.attempt_scored a
  join public.shape_norm n on n.user_id = a.user_id and n.shape = a.shape
  where a.user_id = uid and n.norm_ms > 0;

  -- ---- decay: hoeveel trager word je per ln(1 + dagen) ertussen?
  -- Helling door de oorsprong, want bij nul dagen hoort nul vertraging.
  with paired as (
    select
      rel as rel_after,
      lag(rel)      over w as rel_before,
      extract(epoch from (asked_at - lag(asked_at) over w)) / 86400.0 as gap_days
    from _rel
    where ok
    window w as (partition by problem_key order by asked_at)
  ),
  usable as (
    select ln(1 + gap_days) as x, (rel_after / rel_before) - 1 as y
    from paired
    where rel_before > 0 and gap_days > 0.04          -- niet binnen dezelfde sessie
      and rel_after / rel_before between 0.2 and 5.0  -- uitschieters eruit
  )
  select case when sum(x * x) > 0 then sum(x * y) / sum(x * x) end, count(*)
  into v_decay, n_pairs
  from usable;

  -- ---- penalty: hoe zwak blijkt een som na een fout antwoord?
  -- De tijd van de eerstvolgende keer is precies wat die fout voorspelde.
  with seq as (
    select ok, lead(rel) over (partition by problem_key order by asked_at) as next_rel
    from _rel
  )
  select percentile_cont(0.5) within group (order by next_rel), count(*)
  into v_penalty, n_wrong
  from seq
  where not ok and next_rel is not null and next_rel between 0.1 and 20;

  -- ---- prior: variantie binnen een som tegen variantie tussen sommen
  with per_problem as (
    select problem_key, avg(rel) as m, var_samp(rel) as v, count(*) as n
    from _rel where ok group by problem_key having count(*) >= 3
  )
  select sum(v * (n - 1)) / nullif(sum(n - 1), 0), var_samp(m), count(*)
  into within_var, between_var, n_probs
  from per_problem;

  if between_var > 0 and within_var is not null then
    v_prior := within_var / between_var;
  end if;

  -- ---- alleen overnemen wat op genoeg metingen rust, en altijd geklemd
  insert into public.model_params (user_id) values (uid)
  on conflict (user_id) do nothing;

  if n_pairs >= 60 and v_decay is not null then
    update public.model_params
      set decay = least(greatest(v_decay, 0.05), 1.5) where user_id = uid;
  else
    note := note || 'decay overgeslagen (' || coalesce(n_pairs, 0) || ' paren); ';
  end if;

  if n_wrong >= 25 and v_penalty is not null then
    update public.model_params
      set penalty = least(greatest(v_penalty, 1.5), 6.0) where user_id = uid;
  else
    note := note || 'penalty overgeslagen (' || coalesce(n_wrong, 0) || ' fouten); ';
  end if;

  if n_probs >= 40 and v_prior is not null then
    update public.model_params
      set prior = least(greatest(v_prior, 1.0), 15.0) where user_id = uid;
  else
    note := note || 'prior overgeslagen (' || coalesce(n_probs, 0) || ' sommen); ';
  end if;

  update public.model_params
    set fitted_at = now(), n_attempts = n_att, updated_at = now()
  where user_id = uid
  returning * into out;

  insert into public.model_fits (
    user_id, penalty, prior, decay, n_attempts, n_pairs, n_after_wrong, n_problems, note)
  values (uid, out.penalty, out.prior, out.decay, n_att, n_pairs, n_wrong, n_probs,
          nullif(note, ''));

  return out;
end
$$;

grant execute on function public.fit_model_params() to authenticated;
grant select, insert, update on public.model_params to authenticated;
grant select on public.model_fits to authenticated;
