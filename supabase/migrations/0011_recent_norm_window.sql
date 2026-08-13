-- Je normtijd meet je tegen de recente jij, niet tegen de jij van vroeger
--
-- shape_norm nam de mediaan over alle pogingen ooit. Word je sneller, dan blijft
-- die lat bij een tragere versie van jezelf hangen: je lijkt dan steeds beter
-- ten opzichte van een maatstaf die niet meebeweegt, en sommen komen minder
-- vaak terug dan zou moeten.
--
-- De lat is nu je laatste vier maanden, zolang daar genoeg metingen in zitten.
-- Anders valt hij terug op je hele historie, en anders op de gemiddelden uit je
-- overgenomen data.

create or replace view public.shape_norm
with (security_invoker = true) as
with recent as (
  select
    user_id, shape,
    (percentile_cont(0.5) within group (order by ms))::numeric as norm_ms,
    count(*)::integer as n_attempts
  from public.attempt_scored
  where ok and asked_at > now() - interval '120 days'
  group by user_id, shape
),
alltime as (
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
),
keys as (
  select user_id, shape from alltime
  union
  select user_id, shape from carried
)
select
  k.user_id,
  k.shape,
  case
    when coalesce(r.n_attempts, 0) >= 20 then r.norm_ms   -- recent genoeg gemeten
    when coalesce(a.n_attempts, 0) >= 5  then a.norm_ms   -- anders je hele historie
    else coalesce(c.norm_ms, a.norm_ms, r.norm_ms)        -- anders de overgenomen data
  end as norm_ms,
  coalesce(a.n_attempts, 0) as n_attempts
from keys k
left join recent  r on r.user_id = k.user_id and r.shape = k.shape
left join alltime a on a.user_id = k.user_id and a.shape = k.shape
left join carried c on c.user_id = k.user_id and c.shape = k.shape;
