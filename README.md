# cook (Sunday Prep)

Weekly meal-plan app for Kara and Tomas. Next.js App Router on Vercel, Supabase project `cook`, surface served at `/` from `public/cook/index.html`.

- `public/cook/index.html` — the app, one file (Material 3, green seed). Signs in against Supabase GoTrue with the anon key and talks to `/api/*` with the bearer token.
- `src/app/api/week` — GET the current week (seeds `src/data/seed-week.json` on first run), PATCH per-week state.
- `src/app/api/rate` — meal ratings per user.
- `src/app/api/pantry-photo` — Gemini 2.5 Flash reads a fridge/pantry photo into a tick list (needs `GEMINI_API_KEY`).
- `src/data/seed-week.json` — the planner's output shape. A new week = a new row in `cook_weeks` with `is_current = true`.
- `supabase/migrations/` — schema. RLS on, no policies; service-role key from routes only.
- `scripts/check_page.py` — asset + inline-script check. `scripts/e2e-mock.mjs` — Playwright run against a mock API.

Env (Vercel, Production + Preview): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SITE_URL`, `GEMINI_API_KEY` (pantry photo).
