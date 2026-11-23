import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, expanded, permissions, PluginError, type Manifest } from "./manifest.ts";
import { inspect, installPackage, verify } from "./packages.ts";

export type Status = "enabled" | "disabled" | "paused" | "quarantined";
export type Progress = { seen?: string[]; invalid: number; paused: boolean; next: number };
export type Version = { manifest: Manifest; sha: string; kv: Record<string, unknown>; sources: Record<string, Progress>; status: Status; failures: number };
type Proposal = { manifest: Manifest; sha: string; path: string };
type Entry = { pending?: Proposal; versions: Version[] };
export function openStore(data: string) {
  const root = join(data, "plugins"), packages = join(root, "packages"), file = join(root, "registry.json");
  mkdirSync(root, { mode: 0o700, recursive: true });
  let entries: Record<string, Entry> = {};
  try { entries = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  function get(id: string) {
    if (!Object.hasOwn(entries, id)) throw new PluginError("Unknown external plugin", 404);
    return entries[id]!;
  }
  const active = (id: string) => get(id).versions.at(-1);
  function save(next: Record<string, Entry>) {
    const tmp = file + "." + randomUUID();
    try { writeFileSync(tmp, JSON.stringify(next), { flag: "wx", mode: 0o600 }); renameSync(tmp, file); }
    finally { rmSync(tmp, { force: true }); }
    entries = next;
  }
  function change(id: string, fn: (e: Entry) => void) {
    const e = structuredClone(get(id));
    fn(e); save({ ...entries, [id]: e });
  }
  function view(id: string) {
    const e = get(id), v = active(id), p = e.pending;
    const previous = v ? permissions(v.manifest) : [];
    const requested = p ? permissions(p.manifest) : [];
    return { id, status: v?.status ?? "pending", active: v?.sha ?? null, manifest: v?.manifest ?? p!.manifest,
      failures: v?.failures ?? 0, sources: Object.entries(v?.sources ?? {}).map(([name, s]) => ({ name, paused: s.paused, invalid: s.invalid, next: s.next })),
      versions: e.versions.map(x => ({ sha: x.sha, version: x.manifest.version })),
      pending: p ? { manifest: p.manifest, sha: p.sha, directory: p.path, permissions: requested, removed: previous.filter(s => !requested.includes(s)), expanded: expanded(v?.manifest, p.manifest),
        summary: [p.manifest.description, ...requested, ...p.manifest.secrets.map(s => s.name + " 用于" + s.purpose), "不能直接联网、读写用户文件或启动其他进程。"].join("；") } : null };
  }
  return { root, active, view, list: () => Object.keys(entries).map(view),
    secretNames: (id: string) => get(id).versions.flatMap(v => v.manifest.secrets.map(s => s.name)),
    propose(path: string) {
      const pending = { ...inspect(path), path };
      const id = pending.manifest.id;
      save({ ...entries, [id]: { ...entries[id], versions: entries[id]?.versions ?? [], pending } });
      return view(id).pending!;
    },
    approve(id: string, sha: unknown) {
      change(id, e => {
        const p = e.pending;
        check(p && p.sha === sha, "Pending hash does not match");
        installPackage(packages, p.path, p.sha);
        const old = e.versions.at(-1);
        const known = e.versions.find(v => v.sha === sha);
        check(known?.status !== "quarantined", "Version is quarantined");
        const kv = old?.kv ?? {};
        check(known || !Object.keys(kv).length || Buffer.byteLength(JSON.stringify(kv)) <= p.manifest.resources.storageKB * 1024, "New storage quota is below current usage");
        e.versions = e.versions.filter(v => v.sha !== sha);
        e.versions.push(known ?? { sha: p.sha, manifest: p.manifest, kv: structuredClone(kv), sources: structuredClone(old?.sources ?? {}),
          status: "enabled", failures: 0 });
        delete e.pending;
      });
    },
    reject(id: string) {
      const e = get(id);
      check(e.pending, "No pending install");
      if (e.versions.length) change(id, x => { delete x.pending; });
      else { const next = { ...entries }; delete next[id]; save(next); }
    },
    rollback(id: string, sha?: unknown) {
      change(id, e => {
        const index = sha === undefined ? e.versions.length - 2 : e.versions.findIndex(v => v.sha === sha);
        check(index >= 0 && index < e.versions.length - 1, "Unknown previous version");
        const target = e.versions[index]!;
        check(target.status !== "quarantined", "Version is quarantined");
        verify(join(packages, target.sha), target.sha);
        e.versions.splice(index, 1); e.versions.push(target);
      });
    },
    update(id: string, sha: string, fn: (v: Version) => void) {
      change(id, e => { const v = e.versions.at(-1); check(v?.sha === sha, "Plugin version changed"); fn(v); });
    },
    directory(sha: string) { const dir = join(packages, sha); verify(dir, sha); return dir; },
    remove(id: string) {
      const e = get(id), next = { ...entries };
      delete next[id]; save(next);
      for (const v of e.versions) rmSync(join(packages, v.sha), { force: true, recursive: true });
    },
  };
}
export type Store = ReturnType<typeof openStore>;
