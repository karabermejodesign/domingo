// Service-role REST wrapper. Server only. Never import from anything that ships to the browser.
const base = () => (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
const svc = () => (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()

export async function rest(path: string, init: RequestInit = {}) {
  if (!base() || !svc()) throw new Error('supabase env missing')
  const res = await fetch(`${base()}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: svc(),
      Authorization: `Bearer ${svc()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers || {}),
    },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`supabase ${res.status} ${await res.text()}`)
  return res
}
