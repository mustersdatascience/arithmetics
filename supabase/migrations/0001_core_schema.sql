-- Rekentrainer: kernschema
--
-- Vier tabellen:
--   sessions       één rij per oefensessie
--   session_modes  per sessie per categorie: welke bereiken actief waren en hoeveel
--                  sommen je erin beantwoordde. Dit is de "kansen"-klok waarop de
--                  spaced repetition draait.
--   attempts       ruwe log, één rij per beantwoorde som. Bron van waarheid.
--   problem_stats  aggregaat per som, incl. de SRS-trede. Wat de app leest.
--
-- Alles hangt aan auth.users en staat achter RLS.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- sessions

create table public.sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  client_id   text not null,          -- door de client gezet, maakt hersync idempotent
  kind        text not null default 'practice' check (kind in ('practice', 'drill')),
  preset      text,
  started_at  timestamptz not null,
  ended_at    timestamptz not null,
  limit_s     integer not null default 0,        -- ingestelde sessieduur, 0 = geen limiet
  elapsed_s   numeric(9,2) not null default 0,   -- werkelijk verstreken
  n_correct   integer not null default 0,
  n_wrong     integer not null default 0,
  config      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (user_id, client_id)
);

create index sessions_user_started_idx on public.sessions (user_id, started_at desc);

-- ----------------------------------------------------------- session_modes

-- lo1/hi1 en lo2/hi2 zijn de bereiken van het eerste en tweede invoerveld van de
-- generator, niet van de getoonde som. Bij aftrekken is veld 1 dus het antwoord.
-- swappable=true voor optellen en vermenigvuldigen: daar mogen de velden verwisseld
-- worden bij het bepalen of een som getrokken had kunnen worden.
create table public.session_modes (
  session_id  uuid not null references public.sessions (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  mode        text not null,
  lo1         integer not null,
  hi1         integer not null,
  lo2         integer,
  hi2         integer,
  base        integer,
  swappable   boolean not null default false,
  answered    integer not null default 0,
  started_at  timestamptz not null,
  primary key (session_id, mode)
);

-- de hete query voor de kansen-teller
create index session_modes_clock_idx
  on public.session_modes (user_id, mode, started_at desc);

-- ---------------------------------------------------------------- attempts

create table public.attempts (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  session_id  uuid references public.sessions (id) on delete set null,
  problem_key text not null,           -- 'mul:7x13'
  mode        text not null,
  g1          integer,                 -- generator-invoer 1
  g2          integer,                 -- generator-invoer 2
  base        integer,                 -- alleen bij complementen
  display     text not null,           -- '7 x 13'
  answer      double precision,
  ms          integer not null,
  ok          boolean not null,
  outlier     boolean not null default false,  -- pauze/onderbreking, telt niet mee
  asked_at    timestamptz not null,
  created_at  timestamptz not null default now()
);

create index attempts_problem_idx on public.attempts (user_id, problem_key, asked_at desc);
create index attempts_mode_idx    on public.attempts (user_id, mode, asked_at desc);
create index attempts_session_idx on public.attempts (session_id);

-- ----------------------------------------------------------- problem_stats

create table public.problem_stats (
  user_id       uuid not null references auth.users (id) on delete cascade,
  problem_key   text not null,
  mode          text not null,
  g1            integer,
  g2            integer,
  base          integer,
  swappable     boolean not null default false,
  display       text not null,
  n             integer not null default 0,
  n_ok          integer not null default 0,
  sum_ms        bigint  not null default 0,
  recent_ms     integer[] not null default '{}',  -- laatste 5 goede tijden, nieuwste eerst
  best_ms       integer,
  last_ms       integer,
  srs_step      integer not null default 0,
  first_seen_at timestamptz,
  last_seen_at  timestamptz,
  legacy        boolean not null default false,   -- overgenomen uit localStorage
  primary key (user_id, problem_key)
);

create index problem_stats_mode_idx on public.problem_stats (user_id, mode);

-- ------------------------------------------------------------------- RLS

alter table public.sessions      enable row level security;
alter table public.session_modes enable row level security;
alter table public.attempts      enable row level security;
alter table public.problem_stats enable row level security;

create policy "eigen sessies" on public.sessions
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "eigen sessiemodi" on public.session_modes
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "eigen pogingen" on public.attempts
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "eigen somstatistiek" on public.problem_stats
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
