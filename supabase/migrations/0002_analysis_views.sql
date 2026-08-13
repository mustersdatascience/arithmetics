-- Rekentrainer: reken- en analyselaag
--
-- Alle views draaien met security_invoker, zodat RLS van de onderliggende
-- tabellen gewoon geldt en je nooit meer ziet dan je eigen rijen.

-- ------------------------------------------------------------- hulpjes

create or replace function public.digits(n integer)
returns integer
language sql immutable parallel safe
as $$ select case when n is null then 0 else length(abs(n)::text) end $$;

-- De spaced-repetition ladder, uitgedrukt in KANSEN: het aantal sommen dat je
-- in die categorie beantwoordt terwijl deze som getrokken had kunnen worden.
-- Trede 0 (~12 kansen) landt nog binnen dezelfde sessie, trede 5 komt neer op
-- eens per ~30 sessies.
create or replace function public.srs_interval(step integer)
returns integer
language sql immutable parallel safe
as $$
  select case least(greatest(step, 0), 5)
           when 0 then 12
           when 1 then 30
           when 2 then 80
           when 3 then 200
           when 4 then 500
           else 1200
         end
$$;

-- ------------------------------------------------------- basis per som

create view public.problem_view
with (security_invoker = true) as
select
  ps.user_id,
  ps.problem_key,
  ps.mode,
  ps.g1,
  ps.g2,
  ps.base,
  ps.swappable,
  ps.display,
  ps.n,
  ps.n_ok,
  ps.srs_step,
  ps.first_seen_at,
  ps.last_seen_at,
  ps.legacy,
  ps.best_ms,
  ps.last_ms,
  round(ps.sum_ms::numeric / nullif(ps.n, 0)) as avg_ms,
  (select round(avg(x)) from unnest(ps.recent_ms) as x) as recent_ms,
  case when ps.n > 0 then ps.n_ok::numeric / ps.n end as acc,
  -- "vorm": de categorie plus het aantal cijfers van beide operanden. Sommen van
  -- dezelfde vorm zijn onderling vergelijkbaar; 4-cijferig optellen hoort niet in
  -- dezelfde vergelijking als 6 x 7.
  ps.mode || ':' || public.digits(ps.g1) || 'x' || public.digits(ps.g2) as shape
from public.problem_stats ps;

-- Jouw eigen normtijd per vorm: de mediaan over alle sommen van die vorm.
-- Hierdoor wordt traagheid relatief gemeten in plaats van in kale seconden.
create view public.shape_norm
with (security_invoker = true) as
select
  user_id,
  shape,
  (percentile_cont(0.5) within group (order by recent_ms))::numeric as norm_ms,
  count(*) as n_problems
from public.problem_view
where recent_ms is not null and n >= 2
group by user_id, shape;

-- Per som: hoeveel trager dan jouw eigen norm, en een struggle-score die
-- traagheid combineert met foutratio.
create view public.problem_ranked
with (security_invoker = true) as
select
  p.*,
  sn.norm_ms,
  case when sn.norm_ms > 0 then round(p.recent_ms / sn.norm_ms, 2) end as relative,
  case when sn.norm_ms > 0
       then round((p.recent_ms / sn.norm_ms) * (1 + 2 * (1 - coalesce(p.acc, 1))), 2)
  end as struggle
from public.problem_view p
left join public.shape_norm sn
  on sn.user_id = p.user_id and sn.shape = p.shape;

-- --------------------------------------------------- de kansen-klok / SRS

-- Voor elke som: hoeveel kansen zijn er voorbijgekomen sinds je hem laatst zag,
-- en hoeveel had hij er nodig gehad. Een sessie telt alleen mee als de som er
-- daadwerkelijk in getrokken had kunnen worden, dus met de juiste bereiken.
create view public.problem_due
with (security_invoker = true) as
select
  ps.user_id,
  ps.problem_key,
  ps.mode,
  ps.g1,
  ps.g2,
  ps.base,
  ps.display,
  ps.srs_step,
  ps.last_seen_at,
  coalesce(cl.opps, 0) as opps_since,
  public.srs_interval(
    -- vangnet: na een lange pauze zakt alles één trede, want speeltellers kennen
    -- geen vergeten. Zet de interval hoger of haal deze case weg om dat uit te zetten.
    case when ps.last_seen_at < now() - interval '60 days'
         then greatest(ps.srs_step - 1, 0)
         else ps.srs_step end
  ) as target_opps,
  coalesce(cl.opps, 0) >= public.srs_interval(
    case when ps.last_seen_at < now() - interval '60 days'
         then greatest(ps.srs_step - 1, 0)
         else ps.srs_step end
  ) as is_due
from public.problem_stats ps
left join lateral (
  select sum(sm.answered)::integer as opps
  from public.session_modes sm
  where sm.user_id = ps.user_id
    and sm.mode = ps.mode
    and sm.started_at > ps.last_seen_at
    and (ps.base is null or sm.base is not distinct from ps.base)
    and (
      (ps.g1 between sm.lo1 and sm.hi1
        and (ps.g2 is null or sm.lo2 is null or ps.g2 between sm.lo2 and sm.hi2))
      or
      (ps.swappable and ps.g2 is not null and sm.lo2 is not null
        and ps.g2 between sm.lo1 and sm.hi1
        and ps.g1 between sm.lo2 and sm.hi2)
    )
) cl on true;

-- ------------------------------------------------------------- families

-- Losse sommen zijn dun bezet: er zijn er duizenden en je ziet ze zelden twee
-- keer. Families groeperen ze tot iets waar binnen een week signaal in zit.
-- Eén som kan in meerdere families vallen (7 x 13 zit in de tafel van 7 én van 13).
create view public.problem_families
with (security_invoker = true) as
select
  p.user_id,
  f.family,
  f.label,
  p.problem_key,
  p.n,
  p.n_ok,
  p.recent_ms,
  p.relative,
  p.struggle
from public.problem_ranked p
cross join lateral (
  select 'tafel:' || p.g1 as family, 'tafel van ' || p.g1 as label
  where p.mode = 'mul' and p.g1 between 2 and 25
  union all
  select 'tafel:' || p.g2, 'tafel van ' || p.g2
  where p.mode = 'mul' and p.g2 between 2 and 25
  union all
  select 'cijfers:' || p.mode || ':' || public.digits(p.g1) || 'x' || public.digits(p.g2),
         p.mode || ' ' || public.digits(p.g1) || ' bij ' || public.digits(p.g2) || ' cijfers'
  where p.mode in ('mul', 'add', 'sub', 'div')
  union all
  select case when (p.g1 % 10) + (p.g2 % 10) >= 10 then 'add:carry' else 'add:nocarry' end,
         case when (p.g1 % 10) + (p.g2 % 10) >= 10
              then 'optellen met tientaloverschrijding'
              else 'optellen zonder tientaloverschrijding' end
  where p.mode = 'add' and p.g1 is not null and p.g2 is not null
  union all
  select case when ((p.g1 + p.g2) % 10) < (p.g2 % 10) then 'sub:borrow' else 'sub:noborrow' end,
         case when ((p.g1 + p.g2) % 10) < (p.g2 % 10)
              then 'aftrekken met lenen'
              else 'aftrekken zonder lenen' end
  where p.mode = 'sub' and p.g1 is not null and p.g2 is not null
  union all
  select 'deler:' || p.g2, 'delen door ' || p.g2
  where p.mode = 'div' and p.g2 between 2 and 25
  union all
  select 'kwadraat:' || ((p.g1 / 10) * 10),
         'kwadraten ' || ((p.g1 / 10) * 10) || ' tot ' || ((p.g1 / 10) * 10 + 9)
  where p.mode = 'sq' and p.g1 is not null
  union all
  select 'compl:' || p.base, 'aanvullen tot ' || p.base
  where p.mode = 'compl' and p.base is not null
  union all
  select 'pct:' || p.g1, p.g1 || ' procent van'
  where p.mode = 'pct' and p.g1 is not null
) f;

create view public.family_stats
with (security_invoker = true) as
select
  user_id,
  family,
  min(label) as label,
  count(*) as n_problems,
  sum(n) as n_attempts,
  round(avg(relative), 2) as avg_relative,
  round((percentile_cont(0.5) within group (order by recent_ms))::numeric) as median_ms,
  round(sum(n_ok)::numeric / nullif(sum(n), 0), 3) as acc
from public.problem_families
group by user_id, family;

-- ------------------------------------------------------------- rechten

grant select on public.problem_view, public.shape_norm, public.problem_ranked,
                public.problem_due, public.problem_families, public.family_stats
  to authenticated;
