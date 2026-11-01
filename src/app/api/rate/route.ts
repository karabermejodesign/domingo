// POST /api/rate { weekId, day, slot, meal, rating }  -> upsert this user's rating for one meal
// GET  /api/rate?weekId=...                          -> all ratings for the week (both users)

import { requireUser, signInRequired } from '../_lib/auth'
import { rest } from '../_lib/supabase-rest'

export const maxDuration = 15
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const user = await requireUser(request)
  if (!user) return signInRequired()
  const weekId = new URL(request.url).searchParams.get('weekId') ?? ''
  if (!weekId) return Response.json({ error: 'weekId required' }, { status: 400 })
  try {
    const res = await rest(`cook_ratings?select=day,slot,meal,rating,user_id&week_id=eq.${encodeURIComponent(weekId)}`)
    return Response.json({ ratings: await res.json() })
  } catch (err) {
    console.error('rate GET', err instanceof Error ? err.message : err)
    return Response.json({ error: 'could not load ratings' }, { status: 502 })
  }
}

export async function POST(request: Request) {
  const user = await requireUser(request)
  if (!user) return signInRequired()
  let b: { weekId?: string; day?: number; slot?: string; meal?: string; rating?: number }
  try { b = await request.json() } catch { return Response.json({ error: 'bad json' }, { status: 400 }) }
  const ok =
    typeof b.weekId === 'string' && b.weekId.length < 20 &&
    Number.isInteger(b.day) && (b.day as number) >= 0 && (b.day as number) <= 6 &&
    (b.slot === 'b' || b.slot === 'l' || b.slot === 'd') &&
    typeof b.meal === 'string' && b.meal.length > 0 && b.meal.length < 120 &&
    (b.rating === 1 || b.rating === 2 || b.rating === 3)
  if (!ok) return Response.json({ error: 'invalid rating' }, { status: 400 })
  try {
    await rest('cook_ratings?on_conflict=week_id,day,slot,user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ week_id: b.weekId, day: b.day, slot: b.slot, meal: b.meal, rating: b.rating, user_id: user.id }),
    })
    return Response.json({ ok: true })
  } catch (err) {
    console.error('rate POST', err instanceof Error ? err.message : err)
    return Response.json({ error: 'could not save rating' }, { status: 502 })
  }
}
