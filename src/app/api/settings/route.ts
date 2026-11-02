// GET   /api/settings                               -> household settings (also returned by GET /api/week)
// PATCH /api/settings { budget: 125000 }            -> set the weekly budget in CLP; { budget: null } clears it (plan default applies)
// PATCH /api/settings { household: 800000 }         -> set the household budget per month in CLP; { household: null } clears it
// Either key may be sent alone or together. Requires a signed-in household member.

import { requireUser, signInRequired } from '../_lib/auth'
import { rest } from '../_lib/supabase-rest'
import { readSettings } from '../_lib/settings'

export const maxDuration = 15
export const dynamic = 'force-dynamic'

const MIN_BUDGET = 20_000
const MAX_BUDGET = 2_000_000
const MIN_HOUSEHOLD = 100_000
const MAX_HOUSEHOLD = 20_000_000

export async function GET(request: Request) {
  const user = await requireUser(request)
  if (!user) return signInRequired()
  try {
    return Response.json({ settings: await readSettings() })
  } catch (err) {
    console.error('settings GET', err instanceof Error ? err.message : err)
    return Response.json({ error: 'could not load settings' }, { status: 502 })
  }
}

async function put(key: string, value: Record<string, number>, userId: string) {
  await rest('cook_settings?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ key, value, updated_by: userId }),
  })
}

export async function PATCH(request: Request) {
  const user = await requireUser(request)
  if (!user) return signInRequired()
  let body: { budget?: unknown; household?: unknown }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'bad json' }, { status: 400 })
  }
  const hasBudget = 'budget' in body && body.budget !== undefined
  const hasHousehold = 'household' in body && body.household !== undefined
  if (!hasBudget && !hasHousehold) return Response.json({ error: 'nothing to save' }, { status: 400 })

  // validate everything before writing anything
  let budget: number | null | undefined
  if (hasBudget) {
    if (body.budget === null) budget = null
    else {
      const max = Number(body.budget)
      if (!Number.isInteger(max) || max < MIN_BUDGET || max > MAX_BUDGET) {
        return Response.json({ error: `budget must be a whole number between ${MIN_BUDGET} and ${MAX_BUDGET} CLP` }, { status: 400 })
      }
      budget = max
    }
  }
  let household: number | null | undefined
  if (hasHousehold) {
    if (body.household === null) household = null
    else {
      const month = Number(body.household)
      if (!Number.isInteger(month) || month < MIN_HOUSEHOLD || month > MAX_HOUSEHOLD) {
        return Response.json({ error: `household budget must be a whole number between ${MIN_HOUSEHOLD} and ${MAX_HOUSEHOLD} CLP per month` }, { status: 400 })
      }
      household = month
    }
  }

  try {
    if (budget === null) await rest('cook_settings?key=eq.budget', { method: 'DELETE' })
    else if (typeof budget === 'number') await put('budget', { max: budget }, user.id)
    if (household === null) await rest('cook_settings?key=eq.household', { method: 'DELETE' })
    else if (typeof household === 'number') await put('household', { month: household }, user.id)
    return Response.json({ ok: true, settings: await readSettings() })
  } catch (err) {
    console.error('settings PATCH', err instanceof Error ? err.message : err)
    return Response.json({ error: 'could not save' }, { status: 502 })
  }
}
