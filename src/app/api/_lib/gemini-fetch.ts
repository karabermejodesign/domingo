/**
 * fetch() for Gemini with a small retry on transient failures.
 *
 * gemini-2.5-flash regularly answers 503 "The model is overloaded" for a second
 * or two, and Google's own guidance is to retry with backoff. Without this, one
 * busy moment at Google became a red error under "Make our story". We retry on
 * 503, 429 and network throws only: a 400 (bad request), 403 (key/quota) or
 * anything else fails immediately so real bugs still surface in the logs.
 */

const RETRY_STATUSES = new Set([503, 429])
const BACKOFF_MS = [1000, 3000]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** True when the upstream status is a "busy, try again" rather than a real error. */
export const isBusyStatus = (status: number) => RETRY_STATUSES.has(status)

/**
 * Same signature as fetch. Retries up to BACKOFF_MS.length times on a retryable
 * status or a thrown network error; the final response (or throw) is returned
 * to the caller unchanged so existing error handling keeps working.
 */
export async function geminiFetch(input: string, init: RequestInit, tag = 'gemini'): Promise<Response> {
  let lastError: unknown
  for (let i = 0; i <= BACKOFF_MS.length; i++) {
    try {
      const res = await fetch(input, init)
      if (!RETRY_STATUSES.has(res.status) || i === BACKOFF_MS.length) return res
      console.warn(`[${tag}] upstream ${res.status}, retrying in ${BACKOFF_MS[i]}ms (attempt ${i + 1})`)
      // Drain the body so the connection can be reused.
      await res.text().catch(() => {})
    } catch (e) {
      lastError = e
      if (i === BACKOFF_MS.length) throw e
      console.warn(`[${tag}] upstream fetch threw, retrying in ${BACKOFF_MS[i]}ms (attempt ${i + 1})`, e)
    }
    await sleep(BACKOFF_MS[i])
  }
  throw lastError
}
