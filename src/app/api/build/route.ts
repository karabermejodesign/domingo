// POST /api/build { weekId, pantry: {key: bool}, extraPantry: string[], deals: {key: bool}, hash }
//   -> { menu, build: { skip, adjust, note, hash, at } }
// "Build menu": Gemini 2.5 Flash re-plans the week's 7-day menu from the plan's own meal pool and
// trims the grocery list for what the household already has, the deals they kept, their budget and
// their ratings. Everything the model returns is checked against the plan before it is saved: menu
// indices must exist in the pool, skipped or adjusted lines must be real grocery lines, adjusted
// prices can only go down. Protein, calories and prices stay the plan's numbers. The result is
// written to cook_weeks.state (menu + build) so both household members see it.

import { requireUser, signInRequired } from '../_lib/auth'
import { rest } from '../_lib/supabase-rest'
import { readSettings } from '../_lib/settings'
import { geminiFetch, isBusyStatus } from '../_lib/gemini-fetch'
import { logGeminiUsage } from '../_lib/gemini-usage'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

const MODEL = 'gemini-2.5-flash'
const MAX_BODY = 32 * 1024

type Meal = [string, number, number, number, number]
type Grocery = { t: string; q?: string; p: number; pk?: string; deal?: boolean; est?: boolean; url?: string }
type Plan = {
  week: { id: string; budget?: number; budgetMin?: number }
  targets: { kMin: number; tMin: number }
  staples: string[]
  pantry: { k: string; t: string; s?: string }[]
  deals: { key: string; label: string; items: { t: string; s?: string }[] }[]
  meals: { b: Meal[]; l: Meal[]; d: Meal[] }
  days: string[]
  menu: { b: number; l: number; d: number }[]
  stores: { key: string; label: string }[]
  groceries: Record<string, Grocery[]>
}
type Rating = { day: number; slot: 'b' | 'l' | 'd'; meal: string; rating: number }
type Build = { skip: string[]; adjust: { t: string; q: string; p: number }[]; note: string; hash: string; at: string }

const PROMPT = (ctx: string) => `You plan the weekly food for a two-adult household in Santiago, Chile (Kara, marathon training, needs 85-100 g protein/day; Tomas, strength training, 120-130 g/day). Priorities in order: cheap (CLP, cost per gram of protein), high protein, batch-cookable on Sunday with reuse of base ingredients. Style: simple Asian and Mediterranean. Lunches are packed for the office.

You are given this week's plan as JSON: a pool of meals per slot (b = breakfast, l = lunch, d = dinner; each meal is [name, Kara protein g, Kara kcal, Tomas protein g, Tomas kcal]), the current 7-day menu as indices into those pools (Mon..Sun), what the household still has (pantry items switched on, plus free-text items they typed or photographed), the deals they chose to use, their weekly budget in CLP, their ratings of this week's meals (1 = again, 2 = fine, 3 = not again), and the grocery list by store (t = product line, q = quantity, p = price in CLP, pk = the pantry key that this line covers, if any).

Rebuild the menu and trim the list:
1. MENU: choose indices only from the given pools. Keep the current menu where nothing argues against it; change meals that use ingredients the household already has plenty of (so the week eats through them), that match a deal they kept, or that were rated "not again" (3). Favour meals rated "again" (1). No meal name more than 3 times in the week. Daily protein from meals should stay at or above 85 g for Kara and 120 g for Tomas; if a change would drop a day below that, prefer a different change.
2. LIST: "skip" a grocery line only when the pantry (switched-on items, free-text items, or staples) already covers what the week needs of it. "adjust" a line when the pantry covers part of it or the new menu needs less of it: give the new quantity as a short string and a new price that is lower than the original and proportional. Never add lines, never raise a price, never touch a line for a store deal they kept unless the menu no longer uses it. Lines with a "pk" whose pantry item is switched on are already skipped by the app; do not list them.
3. NOTE: one plain English sentence, under 160 characters, saying what you changed and why (name the meals or items). No em dashes.

If the budget is lower than the list total after your changes, say so in the note; do not invent cheaper products.

Answer with JSON only, in exactly this shape:
{"menu":[{"b":0,"l":0,"d":1},{"b":1,"l":1,"d":6},{"b":0,"l":2,"d":0},{"b":1,"l":3,"d":3},{"b":0,"l":4,"d":7},{"b":2,"l":5,"d":5},{"b":2,"l":2,"d":0}],"skip":["<grocery t>"],"adjust":[{"t":"<grocery t>","q":"1","p":4000}],"note":"..."}

Plan and household data:
${ctx}`

const isIdx = (v: unknown, n: number) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < n

export async function POST(request: Request) {
  const user = await requireUser(request)
  if (!user) return signInRequired()

  const key = (process.env.GEMINI_API_KEY ?? '').trim()
  if (!key) return Response.json({ error: 'menu building is not set up yet' }, { status: 503 })

  let body: { weekId?: unknown; pantry?: unknown; extraPantry?: unknown; deals?: unknown; hash?: unknown }
  try {
    const raw = await request.text()
    if (raw.length > MAX_BODY) return Response.json({ error: 'request too large' }, { status: 413 })
    body = JSON.parse(raw)
  } catch {
    return Response.json({ error: 'bad json' }, { status: 400 })
  }
  const weekId = typeof body.weekId === 'string' && body.weekId.length < 20 ? body.weekId : ''
  if (!weekId) return Response.json({ error: 'weekId required' }, { status: 400 })
  const hash = typeof body.hash === 'string' ? body.hash.slice(0, 32) : ''

  // Load the plan and the saved state from the server, never from the client.
  let plan: Plan, state: Record<string, unknown>
  try {
    const res = await rest(`cook_weeks?select=plan,state&week_id=eq.${encodeURIComponent(weekId)}&limit=1`)
    const rows = (await res.json()) as { plan: Plan; state: Record<string, unknown> }[]
    if (!rows[0]) return Response.json({ error: 'week not found' }, { status: 404 })
    plan = rows[0].plan
    state = rows[0].state ?? {}
  } catch (err) {
    console.error('build load', err instanceof Error ? err.message : err)
    return Response.json({ error: 'could not load the week' }, { status: 502 })
  }

  // Inputs the client sends win over the saved state (it may not have flushed yet), but only known keys.
  const pantryKeys = new Set(plan.pantry.map((p) => p.k))
  const pantryIn = body.pantry && typeof body.pantry === 'object' ? (body.pantry as Record<string, unknown>) : (state.pantry as Record<string, unknown>) ?? {}
  const pantryOn = plan.pantry.filter((p) => pantryKeys.has(p.k) && !!pantryIn[p.k])
  const extraPantry = (Array.isArray(body.extraPantry) ? body.extraPantry : Array.isArray(state.extraPantry) ? state.extraPantry : [])
    .filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, 80)).filter(Boolean).slice(0, 40)
  const dealsIn = body.deals && typeof body.deals === 'object' ? (body.deals as Record<string, unknown>) : (state.deals as Record<string, unknown>) ?? {}
  const dealsOn = plan.deals.flatMap((g) => g.items.map((d, i) => (dealsIn[g.key + ':' + i] ? `${g.label}: ${d.t}` : '')).filter(Boolean))

  let budget = Number(plan.week.budget) || 130000
  let ratings: Rating[] = []
  try {
    const settings = await readSettings()
    if (settings.budget) budget = settings.budget.max
    const rr = await rest(`cook_ratings?select=day,slot,meal,rating&week_id=eq.${encodeURIComponent(weekId)}`)
    ratings = (await rr.json()) as Rating[]
  } catch (err) {
    console.warn('build settings/ratings', err instanceof Error ? err.message : err)
  }

  const skippedByApp = new Set(pantryOn.map((p) => p.k))
  const groceries = Object.fromEntries(
    plan.stores.map((s) => [s.label, (plan.groceries[s.key] ?? []).filter((g) => !(g.pk && skippedByApp.has(g.pk))).map((g) => ({ t: g.t, q: g.q ?? '', p: g.p, pk: g.pk }))]),
  )
  const lineTitles = new Map<string, Grocery>()
  for (const s of plan.stores) for (const g of plan.groceries[s.key] ?? []) lineTitles.set(g.t, g)

  const currentMenu = (Array.isArray(state.menu) && (state.menu as unknown[]).length === 7 ? state.menu : plan.menu) as { b: number; l: number; d: number }[]
  const ctx = JSON.stringify({
    days: plan.days,
    meals: plan.meals,
    currentMenu,
    staples: plan.staples,
    pantryStillHave: pantryOn.map((p) => (p.s ? `${p.t} (${p.s})` : p.t)),
    pantryFreeText: extraPantry,
    dealsKept: dealsOn,
    weeklyBudgetCLP: budget,
    ratings: ratings.map((r) => ({ day: plan.days[r.day] ?? r.day, slot: r.slot, meal: r.meal, rating: r.rating })),
    groceries,
  })

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`
  let res: Response
  try {
    res = await geminiFetch(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: PROMPT(ctx) }] }],
          generationConfig: { temperature: 0.3, responseMimeType: 'application/json', maxOutputTokens: 2048 },
        }),
      },
      'build',
    )
  } catch (err) {
    console.error('build fetch', err instanceof Error ? err.message : err)
    return Response.json({ error: 'could not reach the planner' }, { status: 502 })
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    console.error('build upstream', res.status, txt.slice(0, 300))
    const busy = isBusyStatus(res.status)
    return Response.json({ error: busy ? 'the planner is busy, try again in a moment' : 'could not build the menu' }, { status: busy ? 503 : 502 })
  }

  // Validate everything against the plan.
  let menu: { b: number; l: number; d: number }[] = []
  const build: Build = { skip: [], adjust: [], note: '', hash, at: new Date().toISOString() }
  try {
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: Record<string, number> }
    logGeminiUsage('build', MODEL, data.usageMetadata)
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
    const out = JSON.parse(text) as { menu?: unknown; skip?: unknown; adjust?: unknown; note?: unknown }

    const m = Array.isArray(out.menu) ? out.menu : []
    if (m.length !== 7) throw new Error('menu length ' + m.length)
    menu = m.map((d, i) => {
      const o = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>
      const cur = currentMenu[i] ?? plan.menu[i]
      return {
        b: isIdx(o.b, plan.meals.b.length) ? (o.b as number) : cur.b,
        l: isIdx(o.l, plan.meals.l.length) ? (o.l as number) : cur.l,
        d: isIdx(o.d, plan.meals.d.length) ? (o.d as number) : cur.d,
      }
    })
    for (const t of Array.isArray(out.skip) ? out.skip : []) {
      const g = typeof t === 'string' ? lineTitles.get(t) : undefined
      if (g && !(g.pk && skippedByApp.has(g.pk)) && !build.skip.includes(g.t)) build.skip.push(g.t)
    }
    for (const a of Array.isArray(out.adjust) ? out.adjust : []) {
      if (!a || typeof a !== 'object') continue
      const o = a as Record<string, unknown>
      const g = typeof o.t === 'string' ? lineTitles.get(o.t) : undefined
      const p = Math.round(Number(o.p))
      if (!g || build.skip.includes(g.t) || !Number.isFinite(p) || p < 0 || p >= g.p) continue
      const q = typeof o.q === 'string' ? o.q.trim().slice(0, 40) : (g.q ?? '')
      if (!build.adjust.some((x) => x.t === g.t)) build.adjust.push({ t: g.t, q, p })
    }
    build.note = typeof out.note === 'string' ? out.note.replace(/—/g, ',').trim().slice(0, 200) : ''
  } catch (err) {
    console.error('build parse', err instanceof Error ? err.message : err)
    return Response.json({ error: 'could not build the menu' }, { status: 502 })
  }

  // Save for the household.
  try {
    const merged = { ...state, menu, build, savedBy: user.id, savedAt: new Date().toISOString() }
    await rest(`cook_weeks?week_id=eq.${encodeURIComponent(weekId)}`, { method: 'PATCH', body: JSON.stringify({ state: merged }) })
  } catch (err) {
    console.error('build save', err instanceof Error ? err.message : err)
    return Response.json({ error: 'built the menu but could not save it' }, { status: 502 })
  }
  return Response.json({ menu, build })
}
