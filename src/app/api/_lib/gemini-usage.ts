/**
 * Gemini usage logging. Every Gemini response carries a usageMetadata block;
 * logging it per call makes Vercel function logs show tokens + estimated cost
 * per request (search the logs for "gemini-usage"). Authoritative spend still
 * lives in Google Cloud Billing — these estimates are for day-to-day feel.
 */

export type GeminiUsage = {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
}

// USD per 1M tokens, paid tier, as of Aug 2026 — see ai.google.dev/gemini-api/docs/pricing.
// Image output is billed as tokens too (~1290 tokens ≈ $0.039 per image at $30/1M).
const PRICES: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-image': { input: 0.3, output: 30 },
}

export function logGeminiUsage(label: string, model: string, usage?: GeminiUsage): void {
  if (!usage) return
  const inTok = usage.promptTokenCount ?? 0
  // Thinking tokens are billed at the output rate.
  const outTok = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0)
  const price = PRICES[model]
  const cost = price ? (inTok * price.input + outTok * price.output) / 1_000_000 : null
  console.log(
    `[gemini-usage] ${label} model=${model} in=${inTok} out=${outTok} total=${usage.totalTokenCount ?? inTok + outTok}` +
      (cost != null ? ` est_cost=$${cost.toFixed(5)}` : ''),
  )
}
