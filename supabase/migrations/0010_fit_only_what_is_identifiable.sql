-- Alleen bijstellen wat werkelijk uit de data volgt
--
-- Bij validatie tegen gesimuleerde data met bekende waarden bleek:
--
--   penalty   goed te schatten (2,00 gevonden tegen 2,20 echt)
--   prior     goed te schatten, een gewone variantieverhouding
--   decay     NIET betrouwbaar te schatten
--
-- Reactietijden op één som variëren van keer tot keer met tientallen procenten
-- door afleiding, typsnelheid en welke rekentruc je toevallig pakt. Die ruis is
-- groter dan het effect van een paar weken niet oefenen. Bij 1400 metingen met
-- realistische ruis was de foutcurve over het hele bereik van 0,8 tot 1,2 vlak
-- tot in de vierde decimaal, en de mediaan per tussentijdgroep niet eens
-- monotoon. De helling laat zich dan niet vastpinnen.
--
-- Een parameter die je niet kunt identificeren moet je niet automatisch laten
-- meebewegen: dan stel je hem bij op ruis en verschuift je hele planning mee.
-- De decay wordt daarom wel geschat en vastgelegd als suggestie, maar niet
-- toegepast. Bij genoeg data over langere tussenpozen kan dat oordeel herzien
-- worden; de schatting staat er dan al.

create or replace function public.fit_model_params()
returns public.model_params
language plpgsql security invoker set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  n_att integer;
  v_decay numeric; n_pairs integer; decay_spread numeric;
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

  -- ---- penalty: hoe traag blijk je werkelijk te zijn ná een fout antwoord?
  -- De tijd van de eerstvolgende keer is precies wat die fout voorspelde.
  with seq as (
    select ok, lead(rel) over (partition by problem_key order by asked_at) as next_rel
    from _rel
  )
  select percentile_cont(0.5) within group (order by next_rel), count(*)
  into v_penalty, n_wrong
  from seq
  where not ok and next_rel is not null and next_rel between 0.1 and 20;

  -- ---- prior: variantie binnen een som gedeeld door variantie tussen sommen.
  -- Dit is het gewicht waarmee het familiegemiddelde meetelt; hoe meer ruis er
  -- binnen een som zit ten opzichte van de verschillen tussen sommen, hoe meer
  -- je op de familie moet leunen.
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

  -- ---- decay: wel schatten, niet toepassen. De spreiding tussen de
  -- tussentijdgroepen laat zien of er ooit genoeg signaal is om dat te wijzigen.
  with withx as (
    select problem_key, rel,
      ln(1 + extract(epoch from (asked_at - lag(asked_at)
          over (partition by problem_key order by asked_at))) / 86400.0)::numeric as x
    from _rel where ok
  ),
  tot as (
    select problem_key, sum(rel) srel, sum(x) sx, count(*)::numeric cnt
    from withx where x is not null and x > 0
    group by problem_key having count(*) >= 4
  ),
  obs as (
    select w.rel / ((t.srel - w.rel) / (t.cnt - 1)) as y,
           w.x, (t.sx - w.x) / (t.cnt - 1) as mx,
           ntile(6) over (order by w.x) as bucket
    from withx w join tot t on t.problem_key = w.problem_key
    where w.x is not null and w.x > 0 and (t.srel - w.rel) > 0
  ),
  buckets as (
    select bucket, count(*) as n,
           (percentile_cont(0.5) within group (order by x))::numeric as bx,
           (percentile_cont(0.5) within group (order by y))::numeric as by_,
           avg(mx)::numeric as bmx
    from obs group by bucket
  ),
  grid as (select (i * 0.05)::numeric as g from generate_series(1, 30) i),
  scored as (
    select g.g, sum(abs(ln(b.by_ / ((1 + g.g * b.bx) / (1 + g.g * b.bmx))))) as fout
    from grid g cross join buckets b group by g.g
  )
  select
    (select g from scored order by fout limit 1),
    (select sum(n)::integer from buckets),
    -- hoe grillig lopen de groepsmedianen? veel spreiding betekent geen signaal
    (select stddev_samp(by_) from buckets)
  into v_decay, n_pairs, decay_spread;

  insert into public.model_params (user_id) values (uid)
  on conflict (user_id) do nothing;

  if n_wrong >= 25 and v_penalty is not null then
    update public.model_params
      set penalty = least(greatest(v_penalty, 1.5), 6.0) where user_id = uid;
  else
    note := note || 'penalty niet bijgesteld, ' || coalesce(n_wrong, 0) || ' metingen na een fout; ';
  end if;

  if n_probs >= 40 and v_prior is not null then
    update public.model_params
      set prior = least(greatest(v_prior, 1.0), 15.0) where user_id = uid;
  else
    note := note || 'prior niet bijgesteld, ' || coalesce(n_probs, 0) || ' sommen met genoeg herhalingen; ';
  end if;

  note := note || 'decay geschat op ' || coalesce(round(v_decay, 2)::text, 'niets')
       || ' (spreiding ' || coalesce(round(decay_spread, 3)::text, '-')
       || ', ' || coalesce(n_pairs, 0) || ' metingen), niet toegepast';

  update public.model_params
    set fitted_at = now(), n_attempts = n_att, updated_at = now()
  where user_id = uid
  returning * into out;

  insert into public.model_fits (
    user_id, penalty, prior, decay, n_attempts, n_pairs, n_after_wrong, n_problems, note)
  values (uid, out.penalty, out.prior, v_decay, n_att, n_pairs, n_wrong, n_probs, note);

  return out;
end
$$;
