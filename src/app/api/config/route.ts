// GET /api/config -> the two values the browser needs to sign in against GoTrue. Anon key only; never the service role.
export const dynamic = 'force-dynamic'
export async function GET() {
  return Response.json({
    supabaseUrl: (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim(),
    anonKey: (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim(),
  })
}
