import type { IncomingMessage, ServerResponse } from "node:http";

export type PluginRouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  origin(): string;
  body(): Promise<Record<string, unknown>>;
  mutation(status: number, data?: unknown): Promise<void>;
  json(status: number, data: unknown): void;
};
export type PluginRoute = {
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  path: string | RegExp;
  /** Cookie-free GET callback on an administrator instance. Gateway authentication still applies. */
  publicCallback?: true;
  handle(ctx: PluginRouteContext): void | Promise<void>;
};
export type PluginSseFeed = {
  event: string;
  snapshot(): unknown;
  subscribe(changed: () => void): () => void;
  /** Defaults to true. Set false for clients that bootstrap the feed via HTTP. */
  onConnect?: boolean;
  /** Payload sent to existing clients when the feed disappears. Defaults to null. */
  cleared?: unknown;
};
export type PluginWebExtensions = { routes?: PluginRoute[]; sse?: PluginSseFeed[]; externalDelivery?: boolean };

export class PluginHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
