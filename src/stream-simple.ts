// @earendil-works/pi-ai is available at runtime inside pi's process.
// It is also installed as a devDependency (file: reference) for local type-checking.
import {
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Api,
  type SimpleStreamOptions,
  type ProviderHeaders,
} from "@earendil-works/pi-ai";
// Use the concrete streamer from its API module — the generic `streamSimple`
// resolves via the global registry which our plugin replaces, causing infinite
// recursion. `streamSimpleOpenAICompletions` does not exist on the main entry
// point; the canonical export is `streamSimple` from the API subpath.

import { openAICompletionsApi } from "@earendil-works/pi-ai";

import type { StreamSimpleFn } from "./types.js";

const LOG = "[pi-provider-litellm]";

/** Stable session ID injected into every request as x-litellm-session-id. */
let currentSessionId: string | undefined;

export function setSessionId(id: string | undefined): void {
  currentSessionId = id;
}

export function getSessionId(): string | undefined {
  return currentSessionId;
}

/** Build the session grouping headers for a request, merged with any caller headers. */
function buildSessionHeaders(callerHeaders?: ProviderHeaders): ProviderHeaders {
  const sessionHeaders: ProviderHeaders = currentSessionId
    ? { "x-litellm-session-id": currentSessionId }
    : {};
  return { ...sessionHeaders, ...callerHeaders };
}

/**
 * Creates a streamSimple handler that injects the x-litellm-session-id header so
 * LiteLLM groups all turns of this pi session into a single conversation in the
 * logs/UI.
 *
 * For non-litellm providers it delegates directly without touching headers, so it
 * never interferes with other plugins that also use `api: 'openai-completions'`.
 *
 * @param providerId  The litellm provider ID (default 'litellm') — used to scope the header injection
 */
export function createSessionHeaderStreamSimple(
  providerId: string = "litellm",
): StreamSimpleFn {
  return function sessionHeaderStreamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const { streamSimple } = openAICompletionsApi();

    if (model.provider !== providerId) {
      return streamSimple(
        model as Model<"openai-completions">,
        context,
        options,
      );
    }

    const mergedOptions: SimpleStreamOptions = {
      ...options,
      headers: buildSessionHeaders(options?.headers),
    };

    return streamSimple(
      model as Model<"openai-completions">,
      context,
      mergedOptions,
    );
  } as unknown as StreamSimpleFn;
}
