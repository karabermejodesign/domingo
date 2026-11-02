-- cook: household settings that outlive any one week (weekly budget first).
-- One row per key, value is jsonb. RLS on, no policies: service-role only, like cook_weeks.

create table if not exists public.cook_settings (
  key         text primary key,                  -- 'budget'
  value       jsonb not null,                    -- budget: { "max": 125000 }  (CLP per week)
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);
alter table public.cook_settings enable row level security;

create trigger cook_settings_touch before update on public.cook_settings
  for each row execute function public.cook_touch_updated_at();
