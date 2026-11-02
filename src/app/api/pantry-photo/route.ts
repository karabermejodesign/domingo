// POST /api/pantry-photo { image: "<base64 jpeg/png/webp>", mime?: string, known?: string[] }
//   -> { items: [{ name, match: string | null, note?: string }] }
// Gemini 2.5 Flash looks at a fridge/pantry photo and lists the food it can see. `known` is the
// week's pantry item names so the model can map what it sees onto them; unmatched items come back
// with match: null and the client adds them as free-text pantry entries. Nothing is written here.

import { requireUser, signInRequired } from '../_lib/auth'
import { geminiFetch, isBusyStatus } from '../_lib/gemini-fetch'
import { logGeminiUsage } from '../_lib/gemini-usage'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

const MODEL = 'gemini-2.5-flash'
const MAX_IMAGE_BYTES = 4 * 1024 * 1024 // base64 length cap; the client downscales to 1200px first
const MAX_ITEMS = 40

type Item = { name: string; match: string | null; note?: string }

const PROMPT = (known: string[]) => `You are looking at a photo of a home fridge, freezer or pantry shelf in Santiago, Chile.
List the food and drink items you can actually see. For each item give a short English name (keep Spanish product or brand names as written on the packaging, e.g. "Atun lomitos", "Yoghurt griego Quillayes").
Estimate how much is left when it is obvious ("half a jar", "about 6 eggs", "1 bag"); otherwise leave note empty.
Do not guess items you cannot see. Skip non-food objects. Maximum ${MAX_ITEMS} items.
This household's current pantry list is: ${JSON.stringify(known)}. When an item you see is the same thing as one of those, put that exact string in "match"; otherwise "match" is null.
Answer with JSON only, no prose, in this shape:
{"items":[{"name":"Eggs","match":"Eggs","note":"about 6"},{"name":"Pan pita integral","match":null,"note":""}]}`

export async function POST(request: Request) {
  const user = await requireUser(request)
  if (!user) return signInRequired()

  const key = (process.env.GEMINI_API_KEY ?? '').trim()
  if (!key) return Response.json({ error: 'photo recognition is not set up yet' }, { status: 503 })

  let body: { image?: string; mime?: string; known?: unknown }
  try {
    const raw = await request.text()
    if (raw.length > MAX_IMAGE_BYTES + 4096) return Response.json({ error: 'photo too large' }, { status: 413 })
    body = JSON.parse(raw)
  } catch {
    return Response.json({ error: 'bad json' }, { status: 400 })
  }
  const image = typeof body.image === 'string' ? body.image.replace(/^data:[^;]+;base64,/, '') : ''
  const mime = ['image/jpeg', 'image/png', 'image/webp'].includes(body.mime ?? '') ? (body.mime as string) : 'image/jpeg'
  if (!image || image.length < 100) return Response.json({ error: 'image required' }, { status: 400 })
  const known = Array.isArray(body.known) ? (body.known as unknown[]).filter((k) => typeof k === 'string').slice(0, 60) as string[] : []

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`
  let res: Response
  try {
    res = await geminiFetch(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: PROMPT(known) }, { inline_data: { mime_type: mime, data: image } }] }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 2048 },
        }),
      },
      'pantry-photo',
    )
  } catch (err) {
    console.error('pantry-photo fetch', err instanceof Error ? err.message : err)
    return Response.json({ error: 'could not reach the photo service' }, { status: 502 })
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    console.error('pantry-photo upstream', res.status, txt.slice(0, 300))
    const busy = isBusyStatus(res.status)
    return Response.json({ error: busy ? 'the photo service is busy, try again in a moment' : 'could not read the photo' }, { status: busy ? 503 : 502 })
  }

  let items: Item[] = []
  try {
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: Record<string, number> }
    logGeminiUsage('pantry-photo', MODEL, data.usageMetadata)
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
    const parsed = JSON.parse(text) as { items?: unknown }
    const raw = Array.isArray(parsed.items) ? parsed.items : []
    for (const it of raw.slice(0, MAX_ITEMS)) {
      if (!it || typeof it !== 'object') continue
      const o = it as Record<string, unknown>
      const name = typeof o.name === 'string' ? o.name.trim().slice(0, 60) : ''
      if (!name) continue
      const match = typeof o.match === 'string' && known.includes(o.match) ? o.match : null
      const note = typeof o.note === 'string' ? o.note.trim().slice(0, 60) : ''
      items.push(note ? { name, match, note } : { name, match })
    }
  } catch (err) {
    console.error('pantry-photo parse', err instanceof Error ? err.message : err)
    return Response.json({ error: 'could not read the photo' }, { status: 502 })
  }
  // de-dupe by lowercase name
  const seen = new Set<string>()
  items = items.filter((i) => { const k = i.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true })
  return Response.json({ items })
}
