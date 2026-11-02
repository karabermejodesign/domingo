// Household settings in cook_settings (key/value jsonb). Server only.
//   budget    -> { max: CLP }    weekly target for the adults' plan (replaces the plan default)
//   household -> { month: CLP }  what the whole trolley may cost per month, kids and diapers included;
//                                cart totals from the store confirmations are compared to it
import { rest } from './supabase-rest'

export type Settings = { budget?: { max: number }; household?: { month: number } }

export async function readSettings(): Promise<Settings> {
  const res = await rest('cook_settings?select=key,value')
  const rows = (await res.json()) as { key: string; value: unknown }[]
  const out: Settings = {}
  for (const r of rows) {
    if (!r.value || typeof r.value !== 'object') continue
    if (r.key === 'budget') {
      const max = Number((r.value as { max?: unknown }).max)
      if (Number.isFinite(max) && max > 0) out.budget = { max: Math.round(max) }
    } else if (r.key === 'household') {
      const month = Number((r.value as { month?: unknown }).month)
      if (Number.isFinite(month) && month > 0) out.household = { month: Math.round(month) }
    }
  }
  return out
}
