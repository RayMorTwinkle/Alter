import type { Conversation, JsonObject } from "./runtime.ts";

export type UserChannel = { id: string; label?: string };
const builtins = new Map([["web", "网页"], ["cli", "命令行"]]);
// Older submitMessage callers and SQLite entries predate surface registration.
const legacyLabel = (id: string) => id === "feishu" ? "飞书" : builtins.get(id);

export function isUserChannel(data?: JsonObject) {
  return data?.userChannel === true || (data?.userChannel === undefined &&
    typeof data?.source === "string" && legacyLabel(data.source) !== undefined);
}

// Conversation IDs are local to a database. Never share registrations between hosts.
const registrations = new WeakMap<Conversation, Map<string, UserChannel>>();
export function registerUserChannel(main: Conversation, channel: UserChannel) {
  let channels = registrations.get(main);
  if (!channels) registrations.set(main, channels = new Map());
  if (channels.has(channel.id)) throw new Error(`User channel already registered: ${channel.id}`);
  const registration = { ...channel };
  channels.set(registration.id, registration);
  return () => { if (channels.get(registration.id) === registration) channels.delete(registration.id); };
}

export function userChannelLabel(main: Conversation, id: string) {
  const channel = registrations.get(main)?.get(id);
  return channel ? channel.label ?? id : legacyLabel(id);
}
