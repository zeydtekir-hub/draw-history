create table if not exists public.maps (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  year integer not null check (year between -10000 and 3000),
  geojson jsonb not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null
);

alter table public.maps enable row level security;

drop policy if exists "Maps are publicly readable" on public.maps;
create policy "Maps are publicly readable"
  on public.maps for select
  using (true);

drop policy if exists "Authenticated users can publish maps" on public.maps;
create policy "Authenticated users can publish maps"
  on public.maps for insert to authenticated
  with check (created_by = (select auth.uid()));

drop policy if exists "Owners can delete their maps" on public.maps;
create policy "Owners can delete their maps"
  on public.maps for delete to authenticated
  using (created_by = (select auth.uid()));

create index if not exists maps_created_at_idx on public.maps (created_at desc);
create index if not exists maps_year_idx on public.maps (year);
