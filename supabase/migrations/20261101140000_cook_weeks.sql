-- cook: weekly plans and per-week UI state. One household (Kara + Tomas) for now.
-- RLS on, no policies: only the service-role key from API routes can read or write.

create table if not exists public.cook_weeks (
  id          uuid primary key default gen_random_uuid(),
  week_id     text not null unique,              -- ISO week, e.g. 2026-W45
  label       text not null,                     -- "Week of 2–8 Nov"
  plan        jsonb not null,                    -- the planner's output (seed-week.json shape)
  state       jsonb not null default '{}'::jsonb,-- pantry/deals/menu/bought/sent/step, written by the app
  is_current  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists cook_weeks_one_current on public.cook_weeks (is_current) where is_current;
alter table public.cook_weeks enable row level security;

create table if not exists public.cook_ratings (
  id          uuid primary key default gen_random_uuid(),
  week_id     text not null references public.cook_weeks(week_id) on delete cascade,
  day         smallint not null check (day between 0 and 6),
  slot        text not null check (slot in ('b','l','d')),
  meal        text not null,
  rating      smallint not null check (rating between 1 and 3),  -- 1 again, 2 fine, 3 not again
  user_id     uuid,
  created_at  timestamptz not null default now(),
  unique (week_id, day, slot, user_id)
);
alter table public.cook_ratings enable row level security;

create or replace function public.cook_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger cook_weeks_touch before update on public.cook_weeks
  for each row execute function public.cook_touch_updated_at();
