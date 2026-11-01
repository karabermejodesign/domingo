<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# cook — standing rules

Sunday Prep: the weekly meal-plan app for Kara and Tomas. Built the Wild Ordinary way (see the build-app skill).

- Surface: one self-contained SPA at `public/cook/index.html`, served at `/cook`. Absolute asset paths only (`/cook/img/...`).
- Every server route calls `requireUser` at the top of the handler and sets `maxDuration`.
- Data is in Supabase project `cook`, tables prefixed `cook_`, RLS on, no policies: the service-role key from API routes is the only access path. Never put a non-anon key in `public/`.
- Never forward an upstream 401/403; map to 502. A 401 from our routes means exactly one thing: not signed in.
- Never echo a vendor's error message to the client. Every Gemini call goes through `geminiFetch`.
- The week's plan lives in `cook_weeks.plan` (jsonb, same shape as `src/data/seed-week.json`); per-week UI state in `cook_weeks.state`.
- Copy: no em dashes; English UI; store and product names stay in Spanish as the stores write them; cups and ounces, never grams or ml; Lider first, then Jumbo; LATAM Pass benefits (Juan Esparraguito 30% Wednesdays, Aquality 40% Tuesdays) always factored in; product links on every grocery line; tahini in the hummus.
- Before wrapping up: `python3 scripts/check_page.py public/cook/index.html --root public --base /cook`, `npx tsc --noEmit`, latest production deployment READY, `get_runtime_errors` clean.
- Commit author email must be karabermejodesign@gmail.com (Vercel Hobby blocks other authors). Default branch `main`.
