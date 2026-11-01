/**
 * Shared auth for the famprototype API routes.
 *
 * The client (public/famprototype/index.html) signs a parent in against
 * Supabase GoTrue and sends the access token on every API call as
 * `Authorization: Bearer <jwt>` (see its `authFetch`). Each route verifies
 * that token server-side against GoTrue before doing anything — including
 * the Gemini-backed routes, which spend real money per call and must never
 * be callable by strangers.
 *
 * One implementation, imported everywhere. If token verification ever needs
 * to change (caching, audience checks, a different auth provider), it
 * changes here and nowhere else.
 */

import { NextResponse } from 'next/server'

/** Verify the caller's Supabase access token and return their user id. */
export async function requireUser(request: Request): Promise<{ id: string } | null> {
  const auth = request.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return null
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
  const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
  if (!url || !anon) return null
  try {
    const res = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
    if (!res.ok) return null
    const user = (await res.json()) as { id?: string }
    return user?.id ? { id: user.id } : null
  } catch {
    return null
  }
}

/** Standard 401 for routes that need a signed-in parent. */
export function signInRequired(message = 'Sign in to use this') {
  return NextResponse.json({ error: message }, { status: 401 })
}
