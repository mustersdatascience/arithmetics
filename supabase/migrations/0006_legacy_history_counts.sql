-- Overgenomen historie liet meetellen in het nieuwe model
--
-- Migratie 0005 leidt de schatting per som af uit losse pogingen in attempts.
-- Historie die uit localStorage is overgenomen heeft die pogingen niet: daar is
-- alleen een totaal aantal keren en een opgetelde tijd van bewaard. Gevolg was
-- dat zulke sommen wel een eigen gemiddelde kregen, maar met gewicht nul, zodat
-- er in de praktijk alleen het familiegemiddelde overbleef. Jaren oefening
-- verdwenen daarmee uit de planning.
--
-- Twee reparaties:
--   1. shape_norm valt terug op de overgenomen gemiddelden voor vormen waar nog
--      te weinig losse pogingen van zijn.
--   2. Een overgenomen som telt mee met het aantal keren dat hij daadwerkelijk
--      is gemaakt, tot een maximum van vijf: evenveel gewicht als een som met
--      een volle recente reeks, niet meer.

-- ------------------------------------------------------------- shape_norm

create or replace view public.shape_norm
with (security_invoker = true) as
with live as (
  select
    user_id, shape,
    (percentile_cont(0.5) within group (order by ms))::numeric as norm_ms,
    count(*)::integer as n_attempts
  from public.attempt_scored
  where ok
  group by user_id, shape
),
carried as (
  select
    user_id,
    mode || ':' || public.digits(g1) || 'x' || public.digits(g2) as shape,
    (percentile_cont(0.5) within group (order by sum_ms::numeric / n))::numeric as norm_ms
  from public.problem_stats
  where legacy and n > 0
  group by 1, 2
)
select
  coalesce(l.user_id, c.user_id) as user_id,
  coalesce(l.shape, c.shape) as shape,
  -- eigen pogingen gaan voor zodra er genoeg van zijn; daaronder is het
  -- overgenomen gemiddelde een betere schatting dan een handvol metingen
  case when coalesce(l.n_attempts, 0) >= 5 then l.norm_ms
       else coalesce(c.norm_ms, l.norm_ms) end as norm_ms,
  coalesce(l.n_attempts, 0) as n_attempts
from live l
full join carried c on c.user_id = l.user_id and c.shape = l.shape;

-- ----------------------------------------------------------- problem_board

create or replace view public.problem_board
with (security_invoker = true) as
with base as (
  select
    p.user_id, p.problem_key, p.mode, p.g1, p.g2, p.base, p.swappable,
    p.display, p.n, p.n_ok, p.first_seen_at, p.legacy,
    coalesce(r.last_seen_at, p.last_seen_at) as last_seen_at,
    coalesce(r.n_recent, 0) as n_recent,
    -- gewicht van je eigen metingen tegenover het familiegemiddelde
    case
      when coalesce(r.n_recent, 0) > 0 then r.n_recent
      when p.legacy and p.n > 0 then least(p.n, 5)
      else 0
    end as obs_n,
    case when p.n > 0 then p.n_ok::numeric / p.n end as acc,
    coalesce(
      r.median_rel,
      -- overgenomen historie: het bewaarde gemiddelde is alles wat we hebben
      case when p.legacy and p.n > 0 and sn.norm_ms > 0
           then (p.sum_ms::numeric / p.n) / sn.norm_ms end
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
    round(
      ((coalesce(b.own_rel, b.prior_rel) * b.obs_n) + (b.prior_rel * public.rt_prior()))
      / (b.obs_n + public.rt_prior()), 3) as expected_rel
  from base b
)
select
  s.user_id, s.problem_key, s.mode, s.g1, s.g2, s.base, s.swappable, s.display,
  s.n, s.n_ok, s.acc, s.n_recent, s.norm_ms, s.first_seen_at, s.last_seen_at,
  s.legacy, s.prior_rel,
  s.expected_rel,
  round(s.expected_rel * (s.norm_ms / 1000.0), 2) as expected_s,
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
