// POST /api/receipt { weekId, store, images: ["<base64 jpeg>", ...], mime?, lines?: string[] }
//   -> { store: "lider" | ..., date: "YYYY-MM-DD" | null, total: CLP | null, confidence: "high" | "low",
//        items: [{ name, price, match: string | null }] | null }
// Gemini 2.5 Flash reads screenshots of a Lider / Jumbo / Aquality / Juan Esparraguito order confirmation
// (or a photo of a paper boleta): the store, the order date, the grand total and every line with its price.
// `lines` are this order's grocery lines from the plan so items can be matched to them; anything unmatched is
// what the household bought outside the plan (kids' food, fruit, diapers). Nothing is written here: the client
// saves the result into the week's state (`actuals`) through PATCH /api/week.

import { requireUser, signInRequired } from '../_lib/auth'
import { geminiFetch, isBusyStatus } from '../_lib/gemini-fetch'
import { logGeminiUsage } from '../_lib/gemini-usage'
import { rest } from '../_lib/supabase-rest'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

const MODEL = 'gemini-2.5-flash'
const MAX_IMAGES = 6
const MAX_BODY_BYTES = 4 * 1024 * 1024   // Vercel's request cap is 4.5 MB; the client downscales to 1600px first
const MAX_LINES = 80
const MAX_ITEMS = 120

type Store = { key: string; label: string }
type Item = { name: string; price: number; match: string | null }

const PROMPT = (stores: Store[], expected: string, lines: string[]) => `You are reading one or more screenshots (or photos) of a grocery order confirmation from an online supermarket in Santiago, Chile. Several images may be pages of the same order.
Stores to recognise: ${stores.map((s) => `"${s.key}" = ${s.label}`).join(', ')}. The user says this is the ${expected} order; if the images clearly show a different store, say which.
Read:
- "store": one of the keys above, or null if you cannot tell.
- "date": the order or delivery date as YYYY-MM-DD, or null.
- "total": the grand total actually charged, in Chilean pesos as a whole number (no decimals; "$88.170" means 88170). Prefer "Total" over subtotals; include delivery fees if they are part of the total. null if no total is visible.
- "items": every product line you can read, with its line price in pesos (quantity times unit price, as printed). Keep product names as written, abbreviations included.
- "confidence": "high" if the total is clearly readable, otherwise "low".
This order's planned grocery lines are: ${JSON.stringify(lines)}. When a receipt item is the same product as one of those (same product and brand, pack size may differ), put that exact string in "match"; otherwise "match" is null. Match each planned line at most once.
Answer with JSON only, no prose:
{"store":"lider","date":"2026-10-31","total":88170,"confidence":"high","items":[{"name":"POLLO ENTERO SEARA 2,2 KG","price":6990,"match":"Pollo Entero Seara 2,2 kg"},{"name":"PANALES HUGGIES XG 44 UN","price":12990,"match":null}]}`

const toInt = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v)
  if (typeof v === 'string') { const d = v.replace(/[^\d]/g, ''); if (d) return parseInt(d, 10) }
  return null
}

export async function POST(request: Request) {
  const user = await requireUser(request)
  if (!user) return signInRequired()

  const key = (process.env.GEMINI_API_KEY ?? '').trim()
  if (!key) return Response.json({ error: 'receipt reading is not set up yet' }, { status: 503 })

  let body: { weekId?: unknown; store?: unknown; images?: unknown; image?: unknown; mime?: unknown; lines?: unknown }
  try {
    const raw = await request.text()
    if (raw.length > MAX_BODY_BYTES) return Response.json({ error: 'too many or too large screenshots; try fewer at a time' }, { status: 413 })
    body = JSON.parse(raw)
  } catch {
    return Response.json({ error: 'bad json' }, { status: 400 })
  }
  const weekId = typeof body.weekId === 'string' ? body.weekId : ''
  const storeKey = typeof body.store === 'string' ? body.store.slice(0, 40) : ''
  const rawImages = Array.isArray(body.images) ? body.images : typeof body.image === 'string' ? [body.image] : []
  const images = rawImages
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.replace(/^data:[^;]+;base64,/, ''))
    .filter((x) => x.length >= 100)
    .slice(0, MAX_IMAGES)
  const mime = ['image/jpeg', 'image/png', 'image/webp'].includes(body.mime as string) ? (body.mime as string) : 'image/jpeg'
  if (!weekId || !storeKey) return Response.json({ error: 'weekId and store required' }, { status: 400 })
  if (!images.length) return Response.json({ error: 'at least one screenshot required' }, { status: 400 })
  const lines = Array.isArray(body.lines)
    ? (body.lines as unknown[]).filter((l): l is string => typeof l === 'string' && l.length <= 160).slice(0, MAX_LINES)
    : []

  // the plan's store list, so the model can name the store and we can validate the answer
  let stores: Store[] = []
  try {
    const res = await rest(`cook_weeks?select=plan&week_id=eq.${encodeURIComponent(weekId)}&limit=1`)
    const rows = (await res.json()) as { plan: { stores?: unknown } }[]
    const raw = rows[0]?.plan?.stores
    if (Array.isArray(raw)) {
      stores = (raw as unknown[])
        .map((s) => (s && typeof s === 'object' ? (s as Record<string, unknown>) : null))
        .filter((s): s is Record<string, unknown> => !!s && typeof s.key === 'string' && typeof s.label === 'string')
        .map((s) => ({ key: s.key as string, label: s.label as string }))
    }
  } catch (err) {
    console.error('receipt plan', err instanceof Error ? err.message : err)
    return Response.json({ error: 'could not load the week' }, { status: 502 })
  }
  const expected = stores.find((s) => s.key === storeKey)
  if (!expected) return Response.json({ error: 'unknown store' }, { status: 400 })

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`
  let res: Response
  try {
    res = await geminiFetch(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: PROMPT(stores, expected.label, lines) }, ...images.map((data) => ({ inline_data: { mime_type: mime, data } }))] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json', maxOutputTokens: 6144 },
        }),
      },
      'receipt',
    )
  } catch (err) {
    console.error('receipt fetch', err instanceof Error ? err.message : err)
    return Response.json({ error: 'could not reach the receipt reader' }, { status: 502 })
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    console.error('receipt upstream', res.status, txt.slice(0, 300))
    const busy = isBusyStatus(res.status)
    return Response.json({ error: busy ? 'the receipt reader is busy, try again in a moment' : 'could not read the receipt' }, { status: busy ? 503 : 502 })
  }

  try {
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: Record<string, number> }
    logGeminiUsage('receipt', MODEL, data.usageMetadata)
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
    const parsed = JSON.parse(text) as Record<string, unknown>
    const store = typeof parsed.store === 'string' && stores.some((s) => s.key === parsed.store) ? (parsed.store as string) : null
    const date = typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : null
    let total = toInt(parsed.total)
    if (total !== null && (total < 1000 || total > 5_000_000)) total = null
    let items: Item[] | null = null
    if (Array.isArray(parsed.items)) {
      items = []
      const used = new Set<string>()
      for (const it of (parsed.items as unknown[]).slice(0, MAX_ITEMS)) {
        if (!it || typeof it !== 'object') continue
        const o = it as Record<string, unknown>
        const name = typeof o.name === 'string' ? o.name.trim().slice(0, 80) : ''
        const price = toInt(o.price)
        if (!name || price === null || price < 0 || price > 5_000_000) continue
        let match: string | null = typeof o.match === 'string' && lines.includes(o.match) && !used.has(o.match) ? o.match : null
        if (match) used.add(match)
        else match = null
        items.push({ name, price, match })
      }
    }
    const confidence: 'high' | 'low' = total !== null && parsed.confidence !== 'low' ? 'high' : 'low'
    return Response.json({ store, date, total, confidence, items })
  } catch (err) {
    console.error('receipt parse', err instanceof Error ? err.message : err)
    return Response.json({ error: 'could not read the receipt' }, { status: 502 })
  }
}
