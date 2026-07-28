import type { ExtensionAPI, BeforeAgentStartEvent, BeforeAgentStartEventResult } from '@earendil-works/pi-coding-agent'
import { resolvePluginConfig, discoverModels, discoverMcpTools, buildProviderConfig, readSkillsSetting, writeSkillsSetting } from './litellm-api.js'
import { createMcpToolDefinitions } from './tools.js'
import { loadModelCache, saveModelCache } from './model-cache.js'
import { createGcloudStreamSimple, setSessionId } from './stream-simple.js'
import type { LiteLLMModelInfo, McpTool, PluginConfig, StreamSimpleFn } from './types.js'
import { syncRemoteSkills, clearSkillsCache, getCachedSkillNames, getCacheAgeMinutes } from './skills-cache.js'

const LOG = '[pi-provider-litellm]'
// Re-register the provider every 45 minutes to pick up a fresh gcloud OAuth token
// (Google OAuth tokens expire after ~60 minutes)
const TOKEN_REFRESH_INTERVAL_MS = 45 * 60 * 1000

export default async function (pi: ExtensionAPI): Promise<void> {
  const config = resolvePluginConfig()
  if (!config) {
    console.warn(`${LOG} No config found — set LITELLM_URL and LITELLM_KEY (or LITELLM_GCLOUD_TOKEN_AUTH=1)`)
    return
  }

  const token = config.apiKey

  // Re-register the provider with a fresh token (used by the streamSimple 401 handler)
  // Wrapped in try-catch to silently ignore stale ctx errors after session reload.
  const reregister = (token: string): void => {
    try {
      const models = loadModelCache(config.providerId)
      if (models) {
        pi.registerProvider(config.providerId, buildProviderConfig(config.url, token, models, streamSimple))
      }
    } catch (err) {
      // Ignore stale context errors — nothing to do if the session was replaced
      const msg = String(err)
      if (!msg.includes('stale')) {
        console.warn(`${LOG} Provider re-registration failed: ${err}`)
      }
    }
  }

  // Register a lightweight streamSimple so the x-litellm-session-id header
  // is injected on every request, keeping completions grouped by pi session
  // in the LiteLLM logs.
  const streamSimple: StreamSimpleFn | undefined = createSessionHeaderStreamSimple(config.providerId)

   // Track which tools have been registered to avoid duplicates across session restarts.
  const registeredTools = new Set<string>()

  // Token refresh timer — cleared on session_shutdown to avoid stale context errors.
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  
  // Await discovery so PI blocks until models are registered before resolving
  // model patterns. Cache is loaded at the top of discoverAndRegister so the
  // first call returns quickly on subsequent startups.
  await discoverAndRegister(pi, config, token, registeredTools, streamSimple)

  pi.on('session_start', async (_event, ctx) => {
    // Assign a stable session ID so all requests in this pi session are grouped
    // under one conversation in the LiteLLM logs — mirroring Claude Code behaviour.
    // getSessionId() returns the UUID from the session header directly.
    setSessionId(ctx.sessionManager.getSessionId() ?? crypto.randomUUID())

    await discoverAndRegister(pi, config, token, registeredTools, streamSimple)
  })

  pi.on('session_shutdown', async (_event, _ctx) => {
    setSessionId(undefined)
    // Stop the token refresh timer — the captured pi context will be stale
    // after session replacement/reload, so continuing to fire would throw.
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = undefined
    }
  })

}

export async function discoverAndRegister(
  pi: ExtensionAPI,
  config: PluginConfig,
  token: string,
  registeredTools?: Set<string>,
  streamSimple?: StreamSimpleFn,
): Promise<void> {

  // Register from cache before live discovery so models are visible immediately.
  const cached = loadModelCache(config.providerId)
  if (cached) {
    pi.registerProvider(config.providerId, buildProviderConfig(config.url, token, cached, streamSimple))
  }

  const DISCOVERY_TIMEOUT_MS = 30_000

  let modelsResult: PromiseSettledResult<Record<string, LiteLLMModelInfo>>
  let mcpResult: PromiseSettledResult<McpTool[]>

  const controller = new AbortController()
  const timeoutTimer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)

  try {
    const results = await Promise.allSettled([
      discoverModels(config, token),
      discoverMcpTools(config, token),
    ])

    const settledResults = results as [
      PromiseSettledResult<Record<string, LiteLLMModelInfo>>,
      PromiseSettledResult<McpTool[]>,
    ]
    modelsResult = settledResults[0]
    mcpResult = settledResults[1]
  } catch (error) {
    modelsResult = { status: 'rejected', reason: error as Error }
    mcpResult = { status: 'rejected', reason: error as Error }
  } finally {
    clearTimeout(timeoutTimer)
  }

  if (modelsResult.status === 'fulfilled') {
    const modelCount = Object.keys(modelsResult.value).length
    if (modelCount > 0) {
      saveModelCache(config.providerId, modelsResult.value)
      const providerConfig = buildProviderConfig(config.url, token, modelsResult.value, streamSimple)
      pi.registerProvider(config.providerId, providerConfig)
    } else {
      console.warn(`${LOG} No models discovered — check LiteLLM /v1/model/info endpoint (URL: ${config.url})`)
    }
  } else {
    console.error(`${LOG} Model discovery error: ${modelsResult.reason}`)
  }

  if (mcpResult.status === 'fulfilled') {
    const mcpTools = createMcpToolDefinitions(config, token, mcpResult.value)
    for (const tool of mcpTools) {
      if (!registeredTools || !registeredTools.has(tool.name)) {
        pi.registerTool(tool)
        registeredTools?.add(tool.name)
      }
    }
  } else {
    console.warn(`${LOG} MCP tool discovery failed: ${mcpResult.reason}`)
  }
}
