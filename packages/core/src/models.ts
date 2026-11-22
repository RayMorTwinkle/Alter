import { mkdir } from "node:fs/promises";
import type { Api, AssistantMessageEvent, Model, ProviderStreams, StreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
import type { gatewayConfig } from "./config.ts";
import { appendUsage, type UsageLine } from "./usage.ts";

type Config = ReturnType<typeof gatewayConfig>;
type Conversation = Exclude<UsageLine["conversation"], "triage">;
export const gatewayDataDirectories = new WeakMap<Models, string>();
const completions = openAICompletionsApi();

function errorKind(status: number | undefined, networkError: boolean, message = "") {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status && status >= 500 && status < 600) return "server";
  if (status && status >= 400) return "http";
  // A socket can also close after fetch resolved, while the SDK reads the SSE body.
  if (networkError || /terminated|ECONNRESET|socket hang up|Stream ended without finish_reason/i.test(message)) return "network";
  return "provider";
}

const retryable = new Set(["timeout", "auth", "rate_limit", "server", "network"]);

function chainStreams(config: Config, conversation: Conversation): ProviderStreams {
  async function* attempts(
    send: ProviderStreams["stream"], route: Model<Api>, ctx: TranscriptContext, options: StreamOptions = {},
  ) {
    const candidates = route.id === "chain" ? config[conversation] : [route.id];
    const triage = options.metadata?.alterConversation === "triage";
    const chain = triage ? candidates.slice(0, 1) : candidates;
    for (const [index, id] of chain.entries()) {
      options.signal?.throwIfAborted();
      const model = { ...route, id, name: id };
      const at = new Date().toISOString();
      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);
      const deadline = new AbortController();
      const signal = options.signal ? AbortSignal.any([deadline.signal, options.signal]) : deadline.signal;
      const timer = setTimeout(() => deadline.abort(), config.firstTokenMs);
      let firstTokenMs: number | undefined;
      let status: number | undefined;
      let networkError = false;
      let start: Extract<AssistantMessageEvent, { type: "start" }> | undefined;
      try {
        const stream = send(model, ctx, {
          ...options, signal, maxRetries: 0,
          fetch: async (input, init) => {
            try {
              const response = await (options.fetch ?? fetch)(input, init);
              status = response.status;
              return response;
            } catch (error) {
              networkError = true;
              throw error;
            }
          },
        });
        for await (const event of stream) {
          if (event.type === "start") {
            start = event;
            continue;
          }
          if (event.type !== "done" && event.type !== "error") {
            if (firstTokenMs === undefined) {
              firstTokenMs = elapsed();
              clearTimeout(timer);
              if (start) yield start;
            }
            yield event;
            continue;
          }
          clearTimeout(timer);
          const message = event.type === "done" ? event.message : event.error;
          let kind: string | undefined;
          if (event.type === "error") {
            if (options.signal?.aborted) kind = "aborted";
            else if (deadline.signal.aborted) {
              kind = "timeout";
              event.reason = message.stopReason = "error";
              message.errorMessage = `No model output within ${config.firstTokenMs} ms`;
            } else kind = errorKind(status, networkError, message.errorMessage);
          }
          // The adapter replaces its zero-initialized usage object (adding reasoning,
          // even when zero) only when the gateway supplies a usage chunk.
          const { usage } = message;
          const reportedUsage = usage.totalTokens > 0 || usage.reasoning !== undefined;
          // The tool-free caller accounts for triage across gateway and local providers alike.
          if (!triage) await appendUsage(config.dataDir, {
            at, conversation, model: id, attempt: index + 1, fallbackFrom: chain[index - 1],
            outcome: kind ? "error" : "ok", errorKind: kind, latencyMs: elapsed(), firstTokenMs,
            ...(reportedUsage ? {
              inputTokens: usage.input + usage.cacheRead + usage.cacheWrite, outputTokens: usage.output,
            } : {}),
          });
          if (kind && retryable.has(kind) && firstTokenMs === undefined && index + 1 < chain.length) break;
          if (event.type === "done" && firstTokenMs === undefined && start) yield start;
          yield event;
          return;
        }
      } finally {
        clearTimeout(timer);
      }
    }
  }
  function wrap(send: ProviderStreams["stream"]): ProviderStreams["stream"] {
    return (model, ctx, options) => lazyStream(model, async () => attempts(send, model, ctx, options), undefined, options?.signal);
  }
  return { stream: wrap(completions.stream), streamSimple: wrap(completions.streamSimple) };
}

export async function createGatewayModels(config: Config) {
  await mkdir(config.dataDir, { recursive: true });
  const models = createModels();
  gatewayDataDirectories.set(models, config.dataDir);
  function register(conversation: Conversation) {
    const provider = `alter-${conversation}`;
    const catalog = Array.from(new Set(["chain", ...config[conversation]]), (id): Model<"openai-completions"> => ({
      id, name: id, provider, api: "openai-completions", baseUrl: config.baseUrl,
      input: ["text"], reasoning: true, contextWindow: 65536, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: "max_tokens" },
    }));
    models.setProvider(createProvider({
      id: provider, baseUrl: config.baseUrl, models: catalog, api: chainStreams(config, conversation),
      auth: { apiKey: { name: "Alter gateway", resolve: async () => ({ auth: { apiKey: config.apiKey } }) } },
    }));
    return { provider, modelId: "chain" };
  }
  return { models, mainModel: register("main"), taskModel: register("task"), thinking: config.thinking };
}
