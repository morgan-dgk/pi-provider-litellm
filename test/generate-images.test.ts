import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateImages } from '../src/litellm-api.js'
import type { PluginConfig } from '../src/types.js'

const mockConfig: PluginConfig = { url: 'http://localhost:4000', apiKey: 'test-key', providerId: 'litellm' }
const mockModel = { id: 'gemini-3-pro-image', provider: 'litellm' }

let origFetch: typeof globalThis.fetch

beforeEach(() => {
  origFetch = globalThis.fetch
  globalThis.fetch = vi.fn() as unknown as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = origFetch
  vi.restoreAllMocks()
})

describe('generateImages', () => {
  it('returns image output on success', async () => {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: b64 }] }),
    } as Response)

    const result = await generateImages(mockConfig, 'test-key', mockModel, {
      input: [{ type: 'text', text: 'A red fox in the snow' }],
    })

    expect(result.stopReason).toBe('stop')
    expect(result.output).toHaveLength(1)
    expect(result.output[0]).toEqual({ type: 'image', data: b64, mimeType: 'image/png' })
    expect(result.api).toBe('litellm-images')
    expect(result.provider).toBe('litellm')
    expect(result.model).toBe('gemini-3-pro-image')
  })

  it('concatenates multiple text input blocks into prompt', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response)

    await generateImages(mockConfig, 'test-key', mockModel, {
      input: [
        { type: 'text', text: 'A red fox' },
        { type: 'text', text: 'in the snow' },
      ],
    })

    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string)
    expect(body.prompt).toBe('A red fox\nin the snow')
  })

  it('ignores non-text input blocks when building prompt', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response)

    await generateImages(mockConfig, 'test-key', mockModel, {
      input: [
        { type: 'image', data: 'abc', mimeType: 'image/png' } as any,
        { type: 'text', text: 'A red fox' },
      ],
    })

    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string)
    expect(body.prompt).toBe('A red fox')
  })

  it('returns error on non-OK HTTP response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => 'Invalid model',
    } as Response)

    const result = await generateImages(mockConfig, 'test-key', mockModel, {
      input: [{ type: 'text', text: 'A red fox' }],
    })

    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('400')
    expect(result.output).toHaveLength(0)
  })

  it('returns aborted when signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    vi.mocked(globalThis.fetch).mockRejectedValue(new DOMException('Aborted', 'AbortError'))

    const result = await generateImages(mockConfig, 'test-key', mockModel, {
      input: [{ type: 'text', text: 'A red fox' }],
    }, { signal: controller.signal })

    expect(result.stopReason).toBe('aborted')
    expect(result.output).toHaveLength(0)
  })

  it('returns error on fetch failure', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('Network error'))

    const result = await generateImages(mockConfig, 'test-key', mockModel, {
      input: [{ type: 'text', text: 'A red fox' }],
    })

    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('Network error')
    expect(result.output).toHaveLength(0)
  })

  it('returns stop with empty output when data array is empty', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response)

    const result = await generateImages(mockConfig, 'test-key', mockModel, {
      input: [{ type: 'text', text: 'A red fox' }],
    })

    expect(result.stopReason).toBe('stop')
    expect(result.output).toHaveLength(0)
  })

  it('sends correct request body', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response)

    await generateImages(mockConfig, 'test-key', mockModel, {
      input: [{ type: 'text', text: 'A red fox' }],
    })

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      'http://localhost:4000/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer test-key',
          'Content-Type': 'application/json',
        }),
      }),
    )
    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string)
    expect(body.model).toBe('gemini-3-pro-image')
    expect(body.n).toBe(1)
    expect(body.response_format).toBe('b64_json')
  })

  it('merges metadata into request body', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response)

    await generateImages(mockConfig, 'test-key', mockModel, {
      input: [{ type: 'text', text: 'A red fox' }],
    }, { metadata: { size: '1536x1024', quality: 'hd' } })

    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string)
    expect(body.size).toBe('1536x1024')
    expect(body.quality).toBe('hd')
  })

  it('metadata can override default n', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response)

    await generateImages(mockConfig, 'test-key', mockModel, {
      input: [{ type: 'text', text: 'A red fox' }],
    }, { metadata: { n: 3 } })

    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string)
    expect(body.n).toBe(3)
  })

  it('includes a timestamp in the result', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response)

    const before = Date.now()
    const result = await generateImages(mockConfig, 'test-key', mockModel, {
      input: [{ type: 'text', text: 'A red fox' }],
    })
    const after = Date.now()

    expect(result.timestamp).toBeGreaterThanOrEqual(before)
    expect(result.timestamp).toBeLessThanOrEqual(after)
  })
})
