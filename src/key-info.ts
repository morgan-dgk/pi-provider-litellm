import type { PluginConfig } from './types.js'

const FETCH_TIMEOUT = 10_000

export interface KeyUsageInfo {
  spend: number
  maxBudget: number | null
  budgetResetAt: string | null
}

interface KeyInfoResponse {
  info?: {
    spend?: unknown
    max_budget?: unknown
    budget_reset_at?: unknown
  }
}

/**
 * Fetch the current key's spend/budget info from the LiteLLM proxy.
 * Returns null on any network error, non-OK response, or if spend data is absent.
 */
export async function fetchKeyInfo(config: PluginConfig, token: string): Promise<KeyUsageInfo | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)

    const res = await fetch(`${config.url}/key/info`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!res.ok) return null

    const body = (await res.json()) as KeyInfoResponse
    const info = body?.info
    if (!info || typeof info.spend !== 'number') return null

    return {
      spend: info.spend,
      maxBudget: typeof info.max_budget === 'number' ? info.max_budget : null,
      budgetResetAt: typeof info.budget_reset_at === 'string' ? info.budget_reset_at : null,
    }
  } catch {
    return null
  }
}

/**
 * Format a KeyUsageInfo into a compact footer string.
 *
 * Examples:
 *   "$31.21 / $200.00 · resets 2026/08/01"
 *   "$31.21 / $200.00"
 *   "$31.21"
 */
export function formatUsageStatus(info: KeyUsageInfo): string {
  const spend = `$${info.spend.toFixed(2)}`

  const budget = info.maxBudget !== null ? ` / $${info.maxBudget.toFixed(2)}` : ''

  let reset = ''
  if (info.budgetResetAt !== null) {
    const date = new Date(info.budgetResetAt)
    if (!isNaN(date.getTime())) {
      const yyyy = date.getUTCFullYear()
      const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
      const dd = String(date.getUTCDate()).padStart(2, '0')
      reset = ` · resets ${yyyy}/${mm}/${dd}`
    }
  }

  return `💰 ${spend}${budget}${reset}`
}
