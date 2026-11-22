import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir } from "node:fs/promises";
import type { Api, AssistantMessageEvent, Model, ProviderStreams, StreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { withClientIdentity } from "@earendil-works/pi-ai/utils/identity";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
import type { gatewayConfig } from "./config.ts";
import { appendUsage, budgetExhausted, type ProactiveBudget, type UsageLine } from "./usage.ts";

type Config = ReturnType<typeof gatewayConfig>;
type Conversation = Exclude<UsageLine["conversation"], "triage" | "judge">;
export const gatewayDataDirectories = new WeakMap<Models, string>();
const completions = openAICompletionsApi();

// The gateway reports each fallback attempt. Other providers expose one terminal usage record.
const proactiveAttempt = new AsyncLocalStorage<(line: UsageLine) => Promise<void>>();

export function withProactiveUsage(models: Models, budget: ProactiveBudget): Models {
  const streamSimple: Models["streamSimple"] = (model, context, options) => {
    if (!options?.sessionId?.startsWith("proactive-")) return models.streamSimple(model, context, options);
    async function* run() {
      const permit = await budget.acquire(options?.signal);
      if (!permit) throw new Error(budgetExhausted);
      try {
        options?.signal?.throwIfAborted();
        const at = new Date(permit.at).toISOString();
        let recorded = false;
        const started = performance.now();
        const stream = proactiveAttempt.run(async line => {
          recorded = true;
          await permit.record({ ...line, at, conversation: "task", proactive: true });
        }, () => models.streamSimple(model, context, options));
        for await (const event of stream) {
          if (!recorded && (event.type === "done" || event.type === "error")) {
            const msg = event.type === "done" ? event.message : event.error;
            const { input, cacheRead, cacheWrite, output } = msg.usage;
            await permit.record({ at, conversation: "task", proactive: true, model: msg.model, attempt: 1,
              outcome: event.type === "done" ? "ok" : "error", ...(event.type === "error" && { errorKind: event.reason }),
              latencyMs: Math.round(performance.now() - started), inputTokens: input + cacheRead + cacheWrite, outputTokens: output });
          }
          yield event;
        }
      } finally { permit.release(); }
    }
    return lazyStream(model, async () => run(), undefined, options.signal);
  };
  return { ...withClientIdentity(models, {}), streamSimple, completeSimple: (model, context, options) => options?.sessionId?.startsWith("proactive-")
    ? streamSimple(model, context, options).result() : models.completeSimple(model, context, options) };
}

export function judgeModels(models: Models, dir: string | undefined, now: () => number): Pick<Models, "getModel" | "completeSimple"> {
  if (!dir || gatewayDataDirectories.has(models)) return models;
  return {
    getModel: (provider, id) => models.getModel(provider, id),
    async completeSimple(model, context, options) {
      const started = performance.now();
      const line: UsageLine = { at: new Date(now()).toISOString(), conversation: "judge", model: model.id,
        attempt: 1, latencyMs: 0, outcome: "error" };
      try {
        const message = await models.completeSimple(model, context, options);
        line.model = message.model;
        const { input, cacheRead, cacheWrite, output } = message.usage;
        line.inputTokens = input + cacheRead + cacheWrite;
        line.outputTokens = output;
        if (message.stopReason === "error" || message.stopReason === "aborted") line.errorKind = message.stopReason;
        else line.outcome = "ok";
        return message;
      } finally {
        line.latencyMs = Math.round(performance.now() - started);
        await appendUsage(dir, line);
      }
    },
  };
}

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
          // Triage records its own terminal message.
          if (!triage) {
            const record = proactiveAttempt.getStore() ?? ((line: UsageLine) => appendUsage(config.dataDir, line));
            await record({
              at, conversation: options.metadata?.alterConversation === "judge" ? "judge" : conversation, model: id, attempt: index + 1, fallbackFrom: chain[index - 1],
              outcome: kind ? "error" : "ok", errorKind: kind, latencyMs: elapsed(), firstTokenMs,
              ...(reportedUsage ? {
                inputTokens: usage.input + usage.cacheRead + usage.cacheWrite, outputTokens: usage.output,
              } : {}),
            });
          }
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
