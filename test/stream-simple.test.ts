import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSessionHeaderStreamSimple, setSessionId } from '../src/stream-simple';

// --- helpers ----------------------------------------------------------------

/** Minimal EventStream that supports push/end and async iteration. */
function createFakeStream() {
  const queue: Array<{ value: unknown; done: boolean }> = []
  let waiting: Array<(v: { value: unknown; done: boolean }) => void> = []
  let ended = false

  return {
    push(event: Record<string, unknown>) {
      if (ended) return
      const waiter = waiting.shift()
      if (waiter) {
        waiter({ value: event, done: false })
      } else {
        queue.push({ value: event, done: false })
      }
    },
    end() {
      ended = true
      while (waiting.length) {
        waiting.shift()!({ value: undefined, done: true })
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<{ value: unknown; done: boolean }> {
          if (queue.length) return Promise.resolve(queue.shift()!)
          if (ended) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => waiting.push(resolve))
        },
      }
    },
    result() {
      return Promise.resolve(undefined)
    },
  }
}

// --- mocks ------------------------------------------------------------------

const mockStreamSimpleOpenAICompletions = vi.hoisted(() => vi.fn())

vi.mock('@earendil-works/pi-ai', () => ({
  createAssistantMessageEventStream: () => createFakeStream(),
  openAICompletionsApi: () => ({ streamSimple: mockStreamSimpleOpenAICompletions }),
}))

// --- helpers for consuming the outer stream ---------------------------------

async function collectEvents(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

// --- tests ------------------------------------------------------------------

describe('createSessionHeaderStreamSimple', () => {
  // Use 'test' as the providerId to match fakeModel.provider
  const PROVIDER_ID = 'test'
  const fakeModel = { api: 'openai-completions', provider: PROVIDER_ID, id: 'test-model' } as any
  const fakeContext = { systemPrompt: '', messages: [], tools: [] } as any

  beforeEach(() => {
    mockStreamSimpleOpenAICompletions.mockReset()
  })

  it('forwards events from the inner stream to the outer stream', async () => {
    const inner = createFakeStream()
    mockStreamSimpleOpenAICompletions.mockReturnValue(inner)

    const streamSimple = createSessionHeaderStreamSimple(PROVIDER_ID)
    const outer = streamSimple(fakeModel, fakeContext)

    // Push events through the inner stream
    inner.push({ type: 'start', partial: {} })
    inner.push({ type: 'text_delta', delta: 'hello' })
    inner.push({ type: 'done', reason: 'stop', message: {} })
    inner.end()

    const events = await collectEvents(outer as any)
    expect(events).toHaveLength(3)
    expect((events[0] as any).type).toBe('start')
    expect((events[1] as any).type).toBe('text_delta')
    expect((events[2] as any).type).toBe('done')
  })

  it('injects x-litellm-session-id into the options headers', () => {
    const SESSION_ID = 'test-session-abc-123'
    setSessionId(SESSION_ID)

    const inner = createFakeStream()
    mockStreamSimpleOpenAICompletions.mockReturnValue(inner)

    const streamSimple = createSessionHeaderStreamSimple(PROVIDER_ID)
    streamSimple(fakeModel, fakeContext)

    // Verify streamSimpleOpenAICompletions was called with the session header
    expect(mockStreamSimpleOpenAICompletions).toHaveBeenCalledOnce()
    expect(mockStreamSimpleOpenAICompletions).toHaveBeenCalledWith(
      fakeModel,
      fakeContext,
      expect.objectContaining({ headers: expect.objectContaining({ 'x-litellm-session-id': SESSION_ID }) }),
    )

    // Cleanup
    setSessionId(undefined)
  })

  it('merges x-litellm-session-id with pre-existing caller headers', () => {
    const SESSION_ID = 'test-session-merged-456'
    setSessionId(SESSION_ID)

    const inner = createFakeStream()
    mockStreamSimpleOpenAICompletions.mockReturnValue(inner)

    const callerOptions = { headers: { 'x-custom-header': 'my-value' } }
    const streamSimple = createSessionHeaderStreamSimple(PROVIDER_ID)
    streamSimple(fakeModel, fakeContext, callerOptions as any)

    expect(mockStreamSimpleOpenAICompletions).toHaveBeenCalledWith(
      fakeModel,
      fakeContext,
      expect.objectContaining({ headers: expect.objectContaining({
        'x-litellm-session-id': SESSION_ID,
        'x-custom-header': 'my-value',
      })}),
    )

    // Cleanup
    setSessionId(undefined)
  })

  it('does not inject x-litellm-session-id when no session ID is set', () => {
    setSessionId(undefined) // explicitly clear

    const inner = createFakeStream()
    mockStreamSimpleOpenAICompletions.mockReturnValue(inner)

    const streamSimple = createSessionHeaderStreamSimple(PROVIDER_ID)
    streamSimple(fakeModel, fakeContext)

    expect(mockStreamSimpleOpenAICompletions).toHaveBeenCalledWith(
      fakeModel,
      fakeContext,
      expect.not.objectContaining({ headers: expect.objectContaining({ 'x-litellm-session-id': expect.anything() }) }),
    )
  })

  it('does not inject headers for a different provider', () => {
    const SESSION_ID = 'test-session-other-789'
    setSessionId(SESSION_ID)

    const inner = createFakeStream()
    mockStreamSimpleOpenAICompletions.mockReturnValue(inner)

    // A model whose provider does NOT match the registered PROVIDER_ID
    const otherModel = { api: 'openai-completions', provider: 'other-provider', id: 'other-model' } as any
    const streamSimple = createSessionHeaderStreamSimple(PROVIDER_ID)
    streamSimple(otherModel, fakeContext)

    // streamSimpleOpenAICompletions is called with the original (unmodified) options
    expect(mockStreamSimpleOpenAICompletions).toHaveBeenCalledWith(otherModel, fakeContext, undefined)

    // Cleanup
    setSessionId(undefined)
  })

  it('forwards non-auth errors without retrying', async () => {
    const inner = createFakeStream()
    mockStreamSimpleOpenAICompletions.mockReturnValue(inner)

    const streamSimple = createSessionHeaderStreamSimple(PROVIDER_ID)
    const outer = streamSimple(fakeModel, fakeContext)

    inner.push({ type: 'error', reason: 'error', error: { errorMessage: 'rate limit exceeded' } })
    inner.end()

    const events = await collectEvents(outer as any)
    expect(events).toHaveLength(1)
    expect((events[0] as any).type).toBe('error')
    expect((events[0] as any).error.errorMessage).toBe('rate limit exceeded')

    // No retry
    expect(mockStreamSimpleOpenAICompletions).toHaveBeenCalledTimes(1)
  })

})
