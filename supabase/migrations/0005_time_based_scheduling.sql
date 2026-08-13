-- Rekentrainer: van tredeladder naar een continue schatting op reactietijd
--
-- De oude opzet stuurde op goed/fout en verplaatste een som over zes tredes.
-- Bij hoofdrekenen is bijna alles goed, dus dat signaal stond meestal stil,
-- terwijl bij elke poging de reactietijd in milliseconden werd gemeten en
-- alleen voor één drempel gebruikt.
--
-- Nu draait alles op één continue grootheid: hoe lang je er naar verwachting
-- op dit moment over zou doen, uitgedrukt in verhouding tot je eigen normtijd
-- voor dat soort som. De planningsregel is daarmee één zin: laat een som zien
-- zodra je voorspeld boven je doeltijd uitkomt.
--
-- Drie dingen die het model overeind houden:
--
--  1. Een fout antwoord is geen snelle ophaling maar een mislukte. Het telt
--     daarom als een strafwaarde aan de trage kant, niet als de gemeten tijd.
--     Anders zou een som die je snel en zeker fout hebt als sterk gelden.
--  2. De mediaan over je laatste vijf pogingen, niet het gemiddelde, zodat één
--     uitschieter of typefout de schatting nauwelijks verschuift.
--  3. Shrinkage naar de familie: hoe minder metingen, hoe zwaarder het
--     familiegemiddelde meeweegt. Dat is tegelijk de mean reversion en de
--     oplossing voor sommen die je nog nauwelijks gezien hebt.

-- ------------------------------------------------------------- constanten
-- Als functie zodat ze op één plek staan en later te ijken zijn op echte data.

-- Hoe zwaar een fout antwoord telt, in veelvouden van je normtijd.
create or replace function public.rt_penalty()
returns numeric language sql immutable parallel safe set search_path = ''
as $$ select 3.0::numeric $$;

-- Gewicht van het familiegemiddelde, uitgedrukt in "aantal metingen".
create or replace function public.rt_prior()
returns numeric language sql immutable parallel safe set search_path = ''
as $$ select 3.0::numeric $$;

-- Boven deze verhouding tot je normtijd wil je de som terugzien.
create or replace function public.rt_target()
returns numeric language sql immutable parallel safe set search_path = ''
as $$ select 1.5::numeric $$;

-- Hoe snel je verwachte tijd oploopt naarmate je een som niet ziet.
-- verwacht = basis * (1 + g * ln(1 + dagen))
create or replace function public.rt_decay()
returns numeric language sql immutable parallel safe set search_path = ''
as $$ select 0.35::numeric $$;

-- ----------------------------------------------------- oude views opruimen

drop view if exists public.problem_board    cascade;
drop view if exists public.problem_due      cascade;
drop view if exists public.family_stats     cascade;
drop view if exists public.problem_families cascade;
drop view if exists public.problem_ranked   cascade;
drop view if exists public.shape_norm       cascade;
drop view if exists public.problem_view     cascade;

-- ------------------------------------------------------------ basislagen

-- Elke bruikbare poging met de vorm van de som erbij. Onderbroken pogingen
-- doen niet mee: die meten een telefoongesprek, geen geheugen.
create view public.attempt_scored
with (security_invoker = true) as
select
  a.user_id, a.problem_key, a.mode, a.g1, a.g2, a.base,
  a.display, a.ms, a.ok, a.asked_at,
  a.mode || ':' || public.digits(a.g1) || 'x' || public.digits(a.g2) as shape
from public.attempts a
where not a.outlier;

-- Jouw normtijd per vorm: de mediaan over goed beantwoorde pogingen. Hierdoor
-- is traagheid relatief, en niet gewoon "grote getallen duren lang".
create view public.shape_norm
with (security_invoker = true) as
select
  user_id, shape,
  (percentile_cont(0.5) within group (order by ms))::numeric as norm_ms,
  count(*)::integer as n_attempts
from public.attempt_scored
where ok
group by user_id, shape;

-- De laatste vijf pogingen per som, omgerekend naar een verhouding tot de norm.
-- Een fout antwoord krijgt de strafwaarde in plaats van zijn gemeten tijd.
create view public.problem_recent
with (security_invoker = true) as
with ranked as (
  select
    s.user_id, s.problem_key, s.shape, s.ms, s.ok, s.asked_at,
    case when s.ok and n.norm_ms > 0 then s.ms::numeric / n.norm_ms
         else public.rt_penalty() end as eff,
    row_number() over (partition by s.user_id, s.problem_key
                       order by s.asked_at desc) as rn
  from public.attempt_scored s
  left join public.shape_norm n
    on n.user_id = s.user_id and n.shape = s.shape
)
select
  user_id, problem_key,
  count(*)::integer as n_recent,
  (percentile_cont(0.5) within group (order by eff))::numeric as median_rel,
  max(asked_at) as last_seen_at
from ranked
where rn <= 5
group by user_id, problem_key;

-- ---------------------------------------------------------------- families

-- Losse sommen zie je zelden twee keer; groepen wel. Families dienen hier twee
-- doelen: ze laten patronen zien, en ze leveren de basiswaarde waar de
-- schatting van een dun bezette som naartoe getrokken wordt.
create view public.problem_families
with (security_invoker = true) as
select
  p.user_id, f.family, f.label, p.problem_key,
  p.n, p.n_ok, r.median_rel, r.n_recent
from public.problem_stats p
left join public.problem_recent r
  on r.user_id = p.user_id and r.problem_key = p.problem_key
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
  user_id, family,
  min(label) as label,
  count(*)::integer as n_problems,
  sum(n)::integer as n_attempts,
  round(avg(median_rel), 2) as avg_relative,
  round(sum(n_ok)::numeric / nullif(sum(n), 0), 3) as acc
from public.problem_families
group by user_id, family;

-- De basiswaarde per som: het gemiddelde van de families waar hij in zit.
-- Een som die je nooit zag begint hier, in plaats van blanco.
create view public.problem_prior
with (security_invoker = true) as
select
  pf.user_id, pf.problem_key,
  round(avg(fs.avg_relative), 3) as prior_rel
from public.problem_families pf
join public.family_stats fs
  on fs.user_id = pf.user_id and fs.family = pf.family
where fs.n_attempts >= 5
group by pf.user_id, pf.problem_key;

-- ------------------------------------------------------------------ bord

-- Alles wat de app per som moet weten. expected_rel is je huidige schatting na
-- shrinkage; predicted_rel is die schatting opgehoogd voor de tijd die sinds
-- de laatste keer verstreken is. urgency boven 1 betekent: terugbrengen.
create view public.problem_board
with (security_invoker = true) as
with base as (
  select
    p.user_id, p.problem_key, p.mode, p.g1, p.g2, p.base, p.swappable,
    p.display, p.n, p.n_ok, p.first_seen_at, p.legacy,
    coalesce(r.last_seen_at, p.last_seen_at) as last_seen_at,
    coalesce(r.n_recent, 0) as n_recent,
    case when p.n > 0 then p.n_ok::numeric / p.n end as acc,
    -- Overgenomen historie heeft geen losse pogingen; daar is het bewaarde
    -- gemiddelde het enige wat we hebben.
    coalesce(
      r.median_rel,
      case when p.legacy and array_length(p.recent_ms, 1) > 0
           then (p.recent_ms[1])::numeric / nullif(sn.norm_ms, 0) end
    ) as own_rel,
    coalesce(pr.prior_rel, 1.0) as prior_rel,
    sn.norm_ms
  from public.problem_stats p
  left join public.problem_recent r
    on r.user_id = p.user_id and r.problem_key = p.problem_key
  left join public.problem_prior pr
    on pr.user_id = p.user_id and pr.problem_key = p.problem_key
  left join public.shape_norm sn
    on sn.user_id = p.user_id
   and sn.shape = p.mode || ':' || public.digits(p.g1) || 'x' || public.digits(p.g2)
),
shrunk as (
  select
    b.*,
    -- mean reversion: hoe minder eigen metingen, hoe zwaarder de familie weegt
    round(
      ((coalesce(b.own_rel, b.prior_rel) * b.n_recent) + (b.prior_rel * public.rt_prior()))
      / (b.n_recent + public.rt_prior()), 3) as expected_rel
  from base b
)
select
  s.user_id, s.problem_key, s.mode, s.g1, s.g2, s.base, s.swappable, s.display,
  s.n, s.n_ok, s.acc, s.n_recent, s.norm_ms, s.first_seen_at, s.last_seen_at,
  s.legacy, s.prior_rel,
  s.expected_rel,
  round(s.expected_rel * (s.norm_ms / 1000.0), 2) as expected_s,
  -- verwachte tijd loopt op naarmate je de som niet ziet
  round(s.expected_rel * (1 + public.rt_decay()
    * ln(1 + greatest(0, extract(epoch from (now() - s.last_seen_at)) / 86400.0))), 3
  ) as predicted_rel,
  round((s.expected_rel * (1 + public.rt_decay()
    * ln(1 + greatest(0, extract(epoch from (now() - s.last_seen_at)) / 86400.0))))
    / public.rt_target(), 3) as urgency,
  (s.expected_rel * (1 + public.rt_decay()
    * ln(1 + greatest(0, extract(epoch from (now() - s.last_seen_at)) / 86400.0))))
    >= public.rt_target() as is_due
from shrunk s;

grant select on
  public.attempt_scored, public.shape_norm, public.problem_recent,
  public.problem_families, public.family_stats, public.problem_prior,
  public.problem_board
to authenticated;
