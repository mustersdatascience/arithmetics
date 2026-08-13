-- Eigen presets. Bewust in de database en niet in localStorage, zodat een
-- preset die je op je laptop maakt ook op je telefoon staat.

create table public.presets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  name       text not null,
  config     jsonb not null,
  limit_s    integer not null default 120,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create index presets_user_idx on public.presets (user_id, name);

alter table public.presets enable row level security;

create policy "eigen presets" on public.presets
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
