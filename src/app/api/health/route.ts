// GET /api/health -> { ok, hasEnv } with no secrets. Used by the login screen to show a clear message when env is missing.
export const dynamic = 'force-dynamic'
export async function GET() {
  const hasEnv = !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY)
  return Response.json({ ok: true, hasEnv })
}
