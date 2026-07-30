import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchKeyInfo, formatUsageStatus } from '../src/key-info.js'
import type { KeyUsageInfo } from '../src/key-info.js'
import type { PluginConfig } from '../src/types.js'

const config: PluginConfig = { url: 'http://localhost:4000', apiKey: 'sk-test', providerId: 'litellm' }
const token = 'sk-test'

describe('fetchKeyInfo', () => {
  let origFetch: typeof globalThis.fetch

  beforeEach(() => {
    origFetch = globalThis.fetch
    globalThis.fetch = vi.fn() as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = origFetch
    vi.restoreAllMocks()
  })

  it('returns spend, maxBudget, and budgetResetAt on success', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        info: {
          spend: 31.21,
          max_budget: 200.0,
          budget_reset_at: '2026-08-01T00:00:00+00:00',
        },
      }),
    } as Response)

    const result = await fetchKeyInfo(config, token)
    expect(result).toEqual({
      spend: 31.21,
      maxBudget: 200.0,
      budgetResetAt: '2026-08-01T00:00:00+00:00',
    })
  })

  it('returns null maxBudget when max_budget is absent', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        info: { spend: 5.5 },
      }),
    } as Response)

    const result = await fetchKeyInfo(config, token)
    expect(result).not.toBeNull()
    expect(result!.maxBudget).toBeNull()
    expect(result!.budgetResetAt).toBeNull()
  })

  it('returns null when spend is missing', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        info: { max_budget: 200.0 },
      }),
    } as Response)

    const result = await fetchKeyInfo(config, token)
    expect(result).toBeNull()
  })

  it('returns null on HTTP error response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: false,
      status: 403,
    } as Response)

    const result = await fetchKeyInfo(config, token)
    expect(result).toBeNull()
  })

  it('returns null on network error', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('network failure'))

    const result = await fetchKeyInfo(config, token)
    expect(result).toBeNull()
  })

  it('returns null when info is absent from response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    } as Response)

    const result = await fetchKeyInfo(config, token)
    expect(result).toBeNull()
  })
})

describe('formatUsageStatus', () => {
  it('formats spend, budget, and reset date', () => {
    const info: KeyUsageInfo = {
      spend: 31.21146955,
      maxBudget: 200.0,
      budgetResetAt: '2026-08-01T00:00:00+00:00',
    }
    expect(formatUsageStatus(info)).toBe('💰 $31.21 / $200.00 · resets 2026/08/01')
  })

  it('omits budget and reset when both are null', () => {
    const info: KeyUsageInfo = { spend: 5.5, maxBudget: null, budgetResetAt: null }
    expect(formatUsageStatus(info)).toBe('💰 $5.50')
  })

  it('includes budget but omits reset when budgetResetAt is null', () => {
    const info: KeyUsageInfo = { spend: 10.0, maxBudget: 100.0, budgetResetAt: null }
    expect(formatUsageStatus(info)).toBe('💰 $10.00 / $100.00')
  })

  it('omits reset when budgetResetAt is an invalid date string', () => {
    const info: KeyUsageInfo = { spend: 1.0, maxBudget: 50.0, budgetResetAt: 'not-a-date' }
    expect(formatUsageStatus(info)).toBe('💰 $1.00 / $50.00')
  })

  it('pads spend and budget to 2 decimal places', () => {
    const info: KeyUsageInfo = { spend: 1, maxBudget: 10, budgetResetAt: null }
    expect(formatUsageStatus(info)).toBe('💰 $1.00 / $10.00')
  })

  it('uses UTC date components for the reset date', () => {
    // Midnight UTC on 2026/08/01 — should not bleed into 2026/07/31
    const info: KeyUsageInfo = {
      spend: 0,
      maxBudget: null,
      budgetResetAt: '2026-08-01T00:00:00+00:00',
    }
    expect(formatUsageStatus(info)).toBe('💰 $0.00 · resets 2026/08/01')
  })
})
