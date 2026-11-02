// Household settings in cook_settings (key/value jsonb). Server only.
import { rest } from './supabase-rest'

export type Settings = { budget?: { max: number } }

export async function readSettings(): Promise<Settings> {
  const res = await rest('cook_settings?select=key,value')
  const rows = (await res.json()) as { key: string; value: unknown }[]
  const out: Settings = {}
  for (const r of rows) {
    if (r.key === 'budget' && r.value && typeof r.value === 'object') {
      const max = Number((r.value as { max?: unknown }).max)
      if (Number.isFinite(max) && max > 0) out.budget = { max: Math.round(max) }
    }
  }
  return out
}
