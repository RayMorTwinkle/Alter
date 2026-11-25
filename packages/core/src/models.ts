import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir } from "node:fs/promises";
import type { Api, AssistantMessage, AssistantMessageEvent, Message, Model, ProviderStreams, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { withClientIdentity } from "@earendil-works/pi-ai/utils/identity";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { clampThinkingLevel, getSupportedThinkingLevels, createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
import type { DebugTraces } from "./debug-traces.ts";
import { gatewayCompat, openModelCapabilities } from "./model-capabilities.ts";
import type { gatewayConfig } from "./config.ts";
import { appendUsage, budgetExhausted, splitUsage, type ProactiveBudget, type UsageLine } from "./usage.ts";

type Config = ReturnType<typeof gatewayConfig>;
type Conversation = "main" | "task";
export const gatewayCapabilities = new WeakMap<Models, ReturnType<typeof openModelCapabilities>>();
const completions = openAICompletionsApi();

// The gateway reports each fallback attempt. Other providers expose one terminal usage record.
const attemptContext = new AsyncLocalStorage<{ record(line: UsageLine, message?: AssistantMessage): Promise<void>; now(): number }>();
type Attribution = Pick<UsageLine, "watchWakeId" | "wakeId" | "wakeAt" | "wakeSource" | "taskId" | "role"> & { conversation: Conversation; conversationId: string; entryId?: number; entryKind?: string; thinking?: "low" | "medium" | "high" | "max" };
const requests = new WeakMap<Message, Attribution>();

// pi-durable copies the message array before streamSimple. Give this request a private identity
// without changing its contents, the provider session/cache key, or provider-facing metadata.
export function tagRequest(messages: readonly Message[], attribution: Attribution) {
  const last = messages.at(-1);
  if (!last) return { messages: [] };
  const tagged = { ...last };
  requests.set(tagged, attribution);
  return { messages: [...messages.slice(0, -1), tagged] };
}

function reported(message: AssistantMessage) {
  const usage = message.usage;
  return usage.totalTokens > 0 || usage.reasoning !== undefined ? splitUsage(usage) : {};
}

function calledTools(message: AssistantMessage) {
  return message.content.flatMap(part => part.type === "toolCall" ? [part.name] : []);
}

export function withUsage(models: Models, budget: ProactiveBudget, dir: string | undefined, now: () => number, debug?: () => DebugTraces): Models {
  const streamSimple: Models["streamSimple"] = (model, context, options) => {
    const traces = debug?.();
    const last = context.messages.at(-1);
    const attribution = last && requests.get(last);
    const heartbeat = attribution?.wakeSource === "heartbeat" || options?.sessionId?.startsWith("heartbeat-");
    const scheduled = attribution?.role === "schedule" || attribution?.wakeSource === "schedule";
    const proactiveRole = attribution?.role === "watch" ? "watch" : scheduled ? "schedule" : heartbeat ? "heartbeat"
      : attribution?.wakeSource === "report-due" || options?.sessionId === "proactive-report-digest" ? "report-due" : options?.sessionId === "proactive-memory" ? "memory" : options?.sessionId?.startsWith("proactive-") ? "goal" : undefined;
    const proactive = proactiveRole !== undefined;
    if (scheduled && attribution?.thinking) {
      const level = clampThinkingLevel(model, attribution.thinking);
      options = { ...options, reasoning: level === "off" ? undefined : level };
    }
    if (!proactive && !(attribution && (dir || traces))) return models.streamSimple(model, context, options);
    async function* run() {
      const permit = proactive ? await budget.acquire(options?.signal) : undefined;
      if (proactive && !permit) throw new Error(budgetExhausted);
      try {
        options?.signal?.throwIfAborted();
        const at = new Date(permit?.at ?? now()).toISOString();
        const conversation = attribution?.conversation ?? "task";
        let recorded = false;
        const started = performance.now();
        const elapsed = () => Math.round(performance.now() - started);
        const { conversationId, entryId, entryKind, ...owner }: Partial<Attribution> = attribution ?? {};
        const trace = conversationId && traces ? traces.request({ conversation, conversationId, entryKind, entryId, taskId: owner.taskId,
          wakeId: owner.wakeId, wakeAt: owner.wakeAt, trigger: owner.wakeSource ?? proactiveRole ?? entryKind?.replace(/^alter\./, "") ?? conversation },
          context, options?.reasoning) : undefined;
        if (trace && gatewayCapabilities.has(models)) {
          const onPayload = options?.onPayload;
          options = { ...options, onPayload: async (body, target) => {
            const replaced = await onPayload?.(body, target);
            trace.capture(target.id, replaced ?? body);
            return replaced;
          } };
        } else trace?.capture(model.id);
        async function record(line: UsageLine, message?: AssistantMessage) {
          recorded = true;
          trace?.complete(line, message);
          const row = { ...owner, ...line, conversation, role: proactiveRole ?? line.role ?? conversation,
            thinking: options?.reasoning ?? "off", ...(proactive && { proactive: true as const }) };
          if (permit) await permit.record(row);
          else if (dir) await appendUsage(dir, row);
        }
        try {
          const stream = attemptContext.run({ record, now: permit ? () => permit.at : now }, () => models.streamSimple(model, context, options));
          let firstTokenMs: number | undefined;
          for await (const event of stream) {
            if (event.type === "done" || event.type === "error") {
              if (!recorded) {
                const msg = event.type === "done" ? event.message : event.error;
                await record({ at, model: msg.model, attempt: 1, outcome: event.type === "done" ? "ok" : "error",
                  ...(event.type === "error" && { errorKind: event.reason }), latencyMs: elapsed(), firstTokenMs,
                  ...reported(msg), tools: calledTools(msg), ...(!proactive && { statsOnly: true }) }, msg);
              }
            } else if (event.type !== "start") firstTokenMs ??= elapsed();
            yield event;
          }
        } catch (error) {
          if (!recorded) trace?.complete({ at, model: model.id, attempt: 1, outcome: "error", latencyMs: elapsed() },
            undefined, error instanceof Error ? error.message : String(error));
          throw error;
        }
      } finally { permit?.release(); }
    }
    return lazyStream(model, async () => run(), undefined, options?.signal);
  };
  return { ...withClientIdentity(models, {}), streamSimple,
    completeSimple: (model, context, options) => options?.sessionId?.startsWith("proactive-") || requests.has(context.messages.at(-1)!)
      ? streamSimple(model, context, options).result() : models.completeSimple(model, context, options) };
}

export function auxiliaryModels(models: Models, dir: string | undefined, now: () => number, role: "judge" | "feedback", owner: Pick<UsageLine, "taskId" | "wakeId"> = {}): Pick<Models, "getModel" | "completeSimple"> {
  if (!dir) return models;
  return {
    getModel: (provider, id) => models.getModel(provider, id),
    async completeSimple(model, context, options) {
      if (gatewayCapabilities.has(models)) {
        return attemptContext.run({ now, record: line => appendUsage(dir, { ...line, ...owner }) },
          () => models.completeSimple(model, context, options));
      }
      const started = performance.now();
      const line: UsageLine = { at: new Date(now()).toISOString(), conversation: role, role, ...owner, thinking: options?.reasoning ?? "off", model: model.id,
        attempt: 1, latencyMs: 0, outcome: "error" };
      try {
        const message = await models.completeSimple(model, context, options);
        line.model = message.model;
        Object.assign(line, reported(message));
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

function chainStreams(config: Config, conversation: Conversation, catalog: Map<string, Model<"openai-completions">>, uncapped: Set<string>): ProviderStreams {
  async function* attempts(
    send: ProviderStreams["stream"], route: Model<Api>, ctx: TranscriptContext, options: SimpleStreamOptions = {},
  ) {
    const candidates = route.id === "chain" ? config[conversation] : [route.id];
    const triage = options.metadata?.alterConversation === "triage";
    const role = options.metadata?.alterRole ?? options.metadata?.alterConversation;
    const accounting = attemptContext.getStore();
    const chain = triage || role === "feedback" || options.sessionId === "proactive-report-digest" ? candidates.slice(0, 1) : candidates;
    for (const [index, id] of chain.entries()) {
      options.signal?.throwIfAborted();
      const model = { ...catalog.get(id)!, input: catalog.get(route.id)!.input };
      const at = new Date(accounting?.now() ?? Date.now()).toISOString();
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
          // streamSimple synthesizes a cap even when none was requested. Let the gateway
          // allocate the thinking + answer budget unless the caller or user set a limit.
          onPayload: async (payload, target) => {
            if (uncapped.has(id) && options.maxTokens === undefined && payload && typeof payload === "object" && "max_tokens" in payload) {
              delete payload.max_tokens;
            }
            return options.onPayload?.(payload, target);
          },
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
          // Triage records its own terminal message.
          if (!triage) {
            const record = accounting?.record ?? ((line: UsageLine) => appendUsage(config.dataDir, line));
            await record({
              at, conversation: role === "judge" || role === "feedback" ? role : conversation, role: typeof role === "string" ? role : undefined, thinking: options.reasoning ?? "off",
              model: id, attempt: index + 1, fallbackFrom: chain[index - 1],
              fallback: index > 0 && id !== chain[index - 1], retry: index > 0 && id === chain[index - 1] ? 1 : 0,
              outcome: kind ? "error" : "ok", errorKind: kind, latencyMs: elapsed(), firstTokenMs,
              ...reported(message), tools: calledTools(message),
            }, message);
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
  const capabilities = openModelCapabilities(config.dataDir, [...config.main, ...config.task], () => {
    register("main");
    register("task");
  });
  gatewayCapabilities.set(models, capabilities);
  function register(conversation: Conversation) {
    const provider = `alter-${conversation}`;
    const catalog = new Map<string, Model<"openai-completions">>();
    const uncapped = new Set<string>();
    for (const id of new Set(config[conversation])) {
      const { sources, thinkingLevelMap, ...caps } = capabilities.get(id);
      catalog.set(id, { ...caps, name: id, provider, api: "openai-completions", baseUrl: config.baseUrl,
        thinkingLevelMap: thinkingLevelMap ?? undefined, compat: gatewayCompat(id),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
      if (caps.reasoning && sources.maxTokens !== "manual") uncapped.add(id);
    }
    const choices = [...catalog.values()];
    const first = choices[0]!;
    const commonLevels = getSupportedThinkingLevels(first).filter(level => choices.every(m => getSupportedThinkingLevels(m).includes(level)));
    const chain: Model<"openai-completions"> = { ...first, id: "chain", name: "chain",
      input: first.input.filter(input => choices.every(m => m.input.includes(input))),
      contextWindow: Math.min(...choices.map(m => m.contextWindow)), maxTokens: Math.min(...choices.map(m => m.maxTokens)),
      reasoning: commonLevels.some(level => level !== "off"),
      thinkingLevelMap: Object.fromEntries((["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)
        .map(level => [level, commonLevels.includes(level) ? level : null])),
    };
    catalog.set("chain", chain);
    models.setProvider(createProvider({
      id: provider, baseUrl: config.baseUrl, models: [chain, ...choices], api: chainStreams(config, conversation, catalog, uncapped),
      auth: { apiKey: { name: "Alter gateway", resolve: async () => ({ auth: { apiKey: config.apiKey } }) } },
    }));
    return { provider, modelId: "chain" };
  }
  return { models, mainModel: register("main"), taskModel: register("task"), thinking: config.thinking };
}
