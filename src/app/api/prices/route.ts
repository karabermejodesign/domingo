// POST /api/prices { weekId } -> { plan, checked, matched, changed: [{ t, from, to }] }
// Re-prices the current week's grocery lines from the stores' own pages. For each line with a
// Lider, Jumbo or Aquality link, the route fetches the page server-side, strips it to text, and
// asks Gemini 2.5 Flash to pick the matching product and read its price, was-price and promo
// label. Matched lines get the new total (unit x quantity), a product link when the page has one,
// and lose their "estimate" flag; unmatched lines keep their old price and are marked estimate.
// Juan Esparraguito lines are bundles with no product page, so they are left alone. The updated
// plan is written back to cook_weeks.plan and returned so the page can re-render at once.

import { requireUser, signInRequired } from '../_lib/auth'
import { geminiFetch, isBusyStatus } from '../_lib/gemini-fetch'
import { logGeminiUsage } from '../_lib/gemini-usage'
import { rest } from '../_lib/supabase-rest'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

const MODEL = 'gemini-2.5-flash'
const STORE_HOSTS: Record<string, RegExp> = {
  lider: /^https:\/\/super\.lider\.cl\//,
  jumbo: /^https:\/\/www\.jumbo\.cl\//,
  aqua: /^https:\/\/www\.aqualitysoluciones\.cl\//,
}
const PAGE_TIMEOUT_MS = 9000
const MAX_HTML_BYTES = 2 * 1024 * 1024
const MAX_TEXT_CHARS = 24000
const CONCURRENCY = 5
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'

type Line = {
  t: string; q?: string; p: number; url?: string; pk?: string; deal?: boolean; est?: boolean
  unit?: number; was?: number | null; promo?: string | null; pUrl?: string | null; prev?: number | null; checked?: string; note?: string
}
type Plan = {
  week: { id: string; label: string; pricesChecked?: string; pricesCheckedAt?: string | null }
  stores: { key: string; label: string }[]
  groceries: Record<string, Line[]>
}
type Pick = { found: boolean; name?: string; unitPrice?: number; wasPrice?: number | null; promo?: string | null; url?: string | null; confidence?: 'high' | 'low' }

/** Quantity as a plain count ("4" -> 4); weights and blanks are 1 (the line price is then the unit price). */
function count(q?: string): number {
  const m = /^\s*(\d{1,2})\s*$/.exec(q ?? '')
  return m ? Math.max(1, +m[1]) : 1
}

/** Visible text plus anchor hrefs, scripts and styles gone, collapsed, capped. Enough for a model to read a results page. */
function toText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>/gi, (_m, href: string) => ` [link:${href}] `)
    .replace(/<\/(p|div|li|tr|h\d|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n')
    .slice(0, MAX_TEXT_CHARS)
}

async function fetchPage(url: string): Promise<string | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), PAGE_TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'es-CL,es;q=0.9,en;q=0.5' }, redirect: 'follow', signal: ctl.signal, cache: 'no-store' })
    if (!res.ok) return null
    const len = +(res.headers.get('content-length') ?? 0)
    if (len > MAX_HTML_BYTES) return null
    const html = await res.text()
    return html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const PROMPT = (line: Line, host: string, text: string) => `This is the text of a Chilean online grocery page (${host}). Prices are in Chilean pesos written like $7.190 (that is 7190 pesos). Some products show a per-kilo price next to the pack price; use the pack price.
Find the product that best matches this shopping-list line: "${line.t}" (quantity on the list: ${line.q ?? '1'}; last known unit price ${line.p} pesos for the whole line).
Rules: prefer the exact brand and pack size named in the line; if several match, pick the cheapest regular (non-sponsored) one. If no listed product is the same thing, answer found:false. Never invent a price.
"promo" is the store's own label when the product is on offer (for example Rebaja, Combina, Oferta, Cyber Lider, Lleva 2 por $X, Ahorra), else null. "wasPrice" is the struck-through old price if shown, else null. "url" is the product's own page link if one appears near it as [link:...], else null. "confidence" is "high" only when brand and pack size match the line.
Answer with JSON only:
{"found":true,"name":"<product name as written>","unitPrice":7190,"wasPrice":8690,"promo":"Rebaja","url":"https://...","confidence":"high"}

PAGE TEXT:
${text}`

async function pickFromPage(key: string, line: Line, host: string, text: string): Promise<Pick> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`
  const res = await geminiFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: PROMPT(line, host, text) }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 512 },
      }),
    },
    'prices',
  )
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    console.error('prices upstream', res.status, txt.slice(0, 200))
    throw Object.assign(new Error('gemini ' + res.status), { busy: isBusyStatus(res.status) })
  }
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: Record<string, number> }
  logGeminiUsage('prices', MODEL, data.usageMetadata)
  const out = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
  const parsed = JSON.parse(out) as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1_000_000 ? Math.round(v) : null)
  return {
    found: parsed.found === true,
    name: typeof parsed.name === 'string' ? parsed.name.slice(0, 120) : undefined,
    unitPrice: num(parsed.unitPrice) ?? undefined,
    wasPrice: num(parsed.wasPrice),
    promo: typeof parsed.promo === 'string' && parsed.promo.trim() ? parsed.promo.trim().slice(0, 40) : null,
    url: typeof parsed.url === 'string' && /^https:\/\//.test(parsed.url) ? parsed.url.slice(0, 400) : null,
    confidence: parsed.confidence === 'high' ? 'high' : 'low',
  }
}

type Job = { store: string; line: Line }
type Result = { store: string; line: Line; ok: boolean; from: number; to: number }

async function priceLine(key: string, job: Job, now: string): Promise<Result> {
  const { store, line } = job
  const from = line.p
  const miss = (note: string): Result => {
    line.est = true; line.checked = now; line.note = note; line.prev = null
    return { store, line, ok: false, from, to: from }
  }
  const html = await fetchPage(line.url as string)
  if (!html) return miss('page did not load')
  const text = toText(html)
  if (text.length < 200) return miss('page had no content')
  let pick: Pick
  try {
    pick = await pickFromPage(key, line, new URL(line.url as string).host, text)
  } catch (err) {
    console.error('prices pick', line.t, err instanceof Error ? err.message : err)
    return miss('could not read the page')
  }
  if (!pick.found || !pick.unitPrice || pick.confidence !== 'high') return miss(pick.found ? 'match not certain' : 'not on the page')
  const n = count(line.q)
  const to = pick.unitPrice * n
  line.unit = pick.unitPrice
  line.was = pick.wasPrice && pick.wasPrice > pick.unitPrice ? pick.wasPrice : null
  line.promo = pick.promo
  line.deal = !!(line.promo || line.was)
  line.prev = to !== from ? from : null
  line.p = to
  line.checked = now
  delete line.est
  delete line.note
  const sameHost = pick.url && STORE_HOSTS[store] && STORE_HOSTS[store].test(pick.url)
  if (sameHost) line.pUrl = pick.url
  return { store, line, ok: true, from, to }
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]) }
  })
  await Promise.all(workers)
  return out
}

export async function POST(request: Request) {
  const user = await requireUser(request)
  if (!user) return signInRequired()

  const key = (process.env.GEMINI_API_KEY ?? '').trim()
  if (!key) return Response.json({ error: 'price check is not set up yet' }, { status: 503 })

  let body: { weekId?: string }
  try { body = JSON.parse(await request.text()) } catch { return Response.json({ error: 'bad json' }, { status: 400 }) }
  const weekId = typeof body.weekId === 'string' ? body.weekId : ''
  if (!weekId) return Response.json({ error: 'weekId required' }, { status: 400 })

  let plan: Plan
  try {
    const res = await rest(`cook_weeks?select=plan&week_id=eq.${encodeURIComponent(weekId)}&limit=1`)
    const rows = (await res.json()) as { plan: Plan }[]
    if (!rows[0]) return Response.json({ error: 'week not found' }, { status: 404 })
    plan = rows[0].plan
  } catch (err) {
    console.error('prices load', err instanceof Error ? err.message : err)
    return Response.json({ error: 'could not load the week' }, { status: 502 })
  }

  const jobs: Job[] = []
  for (const s of plan.stores ?? []) {
    const re = STORE_HOSTS[s.key]
    for (const line of plan.groceries?.[s.key] ?? []) {
      if (!re || typeof line.url !== 'string' || !re.test(line.url)) continue
      if (/^delivery\b/i.test(line.t)) continue
      jobs.push({ store: s.key, line })
    }
  }
  if (!jobs.length) return Response.json({ error: 'no lines with store links to check' }, { status: 400 })

  const now = new Date().toISOString()
  const results = await pool(jobs, CONCURRENCY, (j) => priceLine(key, j, now))
  const matched = results.filter((r) => r.ok).length
  const changed = results.filter((r) => r.ok && r.to !== r.from).map((r) => ({ t: r.line.t, from: r.from, to: r.to }))
  const skipped = (plan.stores ?? []).filter((s) => !STORE_HOSTS[s.key] && (plan.groceries?.[s.key] ?? []).length).map((s) => s.label)

  const day = new Date(now).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'America/Santiago' })
  plan.week.pricesCheckedAt = now
  plan.week.pricesChecked = `Prices re-checked ${day}: ${matched} of ${jobs.length} lines matched on the store pages` +
    (jobs.length - matched ? `, ${jobs.length - matched} kept at the old price and marked estimate` : '') +
    (skipped.length ? `. ${skipped.join(', ')} lines are not auto-checked.` : '.')

  try {
    await rest(`cook_weeks?week_id=eq.${encodeURIComponent(weekId)}`, { method: 'PATCH', body: JSON.stringify({ plan }) })
  } catch (err) {
    console.error('prices save', err instanceof Error ? err.message : err)
    return Response.json({ error: 'checked, but could not save' }, { status: 502 })
  }
  return Response.json({ plan, checked: jobs.length, matched, changed })
}
