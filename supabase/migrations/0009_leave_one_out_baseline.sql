-- Correctie op de decay-schatter: basislijn zonder de meting zelf
--
-- 0008 deelde elke meting door de mediaan van diezelfde som, inclusief die
-- meting. Daardoor zit de ruis van een meting ook in zijn eigen noemer, wat de
-- helling systematisch naar nul trekt. Bij een validatie tegen gesimuleerde
-- data met een bekende waarde van 0,60 kwam er 0,45 uit.
--
-- Opgelost door de basislijn per meting te berekenen zonder die meting zelf:
-- (som van de som - deze meting) / (aantal - 1). De noemer is dan onafhankelijk
-- van de teller en de afvlakking verdwijnt.

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

  create temp table _rel on commit drop as
  select
    a.problem_key, a.ok, a.asked_at,
    a.ms::numeric / nullif(n.norm_ms, 0) as rel
  from public.attempt_scored a
  join public.shape_norm n on n.user_id = a.user_id and n.shape = a.shape
  where a.user_id = uid and n.norm_ms > 0;

  -- ---- decay
  -- Voor rel = b · (1 + g·x) met x = ln(1 + dagen sinds de vorige keer) geldt na
  -- deling door de basislijn van die som: helling gedeeld door intercept is g,
  -- ongeacht hoe lang de tussenpozen in de data gemiddeld waren.
  with tot as (
    select problem_key, sum(rel) as srel, count(*)::numeric as cnt
    from _rel where ok
    group by problem_key having count(*) >= 4
  ),
  gaps as (
    select
      -- basislijn zonder deze meting zelf
      r.rel / nullif((t.srel - r.rel) / (t.cnt - 1), 0) as y,
      ln(1 + extract(epoch from (r.asked_at - lag(r.asked_at)
            over (partition by r.problem_key order by r.asked_at))) / 86400.0) as x
    from _rel r
    join tot t on t.problem_key = r.problem_key
    where r.ok
  ),
  usable as (
    select x, y from gaps
    where x is not null and x > 0 and y between 0.2 and 5.0
  )
  select
    case when regr_intercept(y, x) > 0.2
         then regr_slope(y, x) / regr_intercept(y, x) end,
    count(*)
  into v_decay, n_pairs
  from usable;

  -- ---- penalty: hoe zwak blijkt een som na een fout antwoord?
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

  insert into public.model_params (user_id) values (uid)
  on conflict (user_id) do nothing;

  if n_pairs >= 60 and v_decay is not null then
    update public.model_params
      set decay = least(greatest(v_decay, 0.05), 1.5) where user_id = uid;
  else
    note := note || 'decay overgeslagen (' || coalesce(n_pairs, 0) || ' metingen); ';
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
