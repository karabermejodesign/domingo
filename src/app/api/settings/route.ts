// GET   /api/settings                       -> household settings (also returned by GET /api/week)
// PATCH /api/settings { budget: 125000 }    -> set the weekly budget in CLP; { budget: null } clears it (plan default applies)
// Requires a signed-in household member.

import { requireUser, signInRequired } from '../_lib/auth'
import { rest } from '../_lib/supabase-rest'
import { readSettings } from '../_lib/settings'

export const maxDuration = 15
export const dynamic = 'force-dynamic'

const MIN_BUDGET = 20_000
const MAX_BUDGET = 2_000_000

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

export async function PATCH(request: Request) {
  const user = await requireUser(request)
  if (!user) return signInRequired()
  let body: { budget?: unknown }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'bad json' }, { status: 400 })
  }
  if (!('budget' in body)) return Response.json({ error: 'nothing to save' }, { status: 400 })
  try {
    if (body.budget === null) {
      await rest('cook_settings?key=eq.budget', { method: 'DELETE' })
    } else {
      const max = Number(body.budget)
      if (!Number.isInteger(max) || max < MIN_BUDGET || max > MAX_BUDGET) {
        return Response.json({ error: `budget must be a whole number between ${MIN_BUDGET} and ${MAX_BUDGET} CLP` }, { status: 400 })
      }
      await rest('cook_settings?on_conflict=key', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ key: 'budget', value: { max }, updated_by: user.id }),
      })
    }
    return Response.json({ ok: true, settings: await readSettings() })
  } catch (err) {
    console.error('settings PATCH', err instanceof Error ? err.message : err)
    return Response.json({ error: 'could not save' }, { status: 502 })
  }
}
