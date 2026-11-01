// GET  /api/week            -> the current week's plan + saved state (seeds the first week if the table is empty)
// PATCH /api/week           -> merge a partial state object into the current week's state
// Both require a signed-in household member (requireUser at the top, never inside a branch).

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { requireUser, signInRequired } from '../_lib/auth'
import { rest } from '../_lib/supabase-rest'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

type WeekRow = { week_id: string; label: string; plan: unknown; state: Record<string, unknown>; is_current: boolean; updated_at: string }

const STATE_KEYS = new Set(['pantry', 'extraPantry', 'deals', 'menu', 'bought', 'sent', 'step'])
const MAX_STATE_BYTES = 64 * 1024

async function currentWeek(): Promise<WeekRow | null> {
  const res = await rest('cook_weeks?select=week_id,label,plan,state,is_current,updated_at&is_current=eq.true&limit=1')
  const rows = (await res.json()) as WeekRow[]
  return rows[0] ?? null
}

async function seedFirstWeek(): Promise<WeekRow> {
  const file = path.join(process.cwd(), 'src', 'data', 'seed-week.json')
  const plan = JSON.parse(await readFile(file, 'utf8')) as { week: { id: string; label: string } }
  const res = await rest('cook_weeks', {
    method: 'POST',
    body: JSON.stringify({ week_id: plan.week.id, label: plan.week.label, plan, state: {}, is_current: true }),
  })
  const rows = (await res.json()) as WeekRow[]
  return rows[0]
}

export async function GET(request: Request) {
  const user = await requireUser(request)
  if (!user) return signInRequired()
  try {
    let week = await currentWeek()
    if (!week) week = await seedFirstWeek()
    return Response.json({ weekId: week.week_id, label: week.label, plan: week.plan, state: week.state ?? {}, updatedAt: week.updated_at })
  } catch (err) {
    console.error('week GET', err instanceof Error ? err.message : err)
    return Response.json({ error: 'could not load the week' }, { status: 502 })
  }
}

export async function PATCH(request: Request) {
  const user = await requireUser(request)
  if (!user) return signInRequired()
  let body: { weekId?: string; state?: Record<string, unknown> }
  try {
    const raw = await request.text()
    if (raw.length > MAX_STATE_BYTES) return Response.json({ error: 'state too large' }, { status: 413 })
    body = JSON.parse(raw)
  } catch {
    return Response.json({ error: 'bad json' }, { status: 400 })
  }
  const weekId = typeof body.weekId === 'string' ? body.weekId : ''
  const patch = body.state && typeof body.state === 'object' ? body.state : null
  if (!weekId || !patch) return Response.json({ error: 'weekId and state required' }, { status: 400 })
  const clean: Record<string, unknown> = {}
  for (const k of Object.keys(patch)) if (STATE_KEYS.has(k)) clean[k] = patch[k]
  if (!Object.keys(clean).length) return Response.json({ error: 'nothing to save' }, { status: 400 })
  try {
    const res = await rest(`cook_weeks?select=state&week_id=eq.${encodeURIComponent(weekId)}&limit=1`)
    const rows = (await res.json()) as { state: Record<string, unknown> }[]
    if (!rows[0]) return Response.json({ error: 'week not found' }, { status: 404 })
    const merged = { ...(rows[0].state ?? {}), ...clean, savedBy: user.id, savedAt: new Date().toISOString() }
    const up = await rest(`cook_weeks?week_id=eq.${encodeURIComponent(weekId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: merged }),
    })
    const out = (await up.json()) as { updated_at: string }[]
    return Response.json({ ok: true, updatedAt: out[0]?.updated_at ?? null })
  } catch (err) {
    console.error('week PATCH', err instanceof Error ? err.message : err)
    return Response.json({ error: 'could not save' }, { status: 502 })
  }
}
