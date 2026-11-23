import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { check, expanded, permissions, PluginError, type Manifest } from "./manifest.ts";
import { activatePackage, preparePackage, verify } from "./packages.ts";

export type Status = "enabled" | "disabled" | "paused" | "quarantined";
export type Progress = { seen?: string[]; invalid: number; paused: boolean; next: number };
type Dependencies = Record<string, string>;
export type Version = { installedAt?: number; userApproved?: boolean; dependencies?: Dependencies; manifest: Manifest; sha: string; kv: Record<string, unknown>; sources: Record<string, Progress>; status: Status; failures: number };
type Proposal = { manifest: Manifest; sha: string; path: string; staged?: string; dependencies?: Dependencies };
type Entry = { pending?: Proposal; versions: Version[] };
export function openStore(data: string) {
  const root = join(data, "plugins"), packages = join(root, "packages"), file = join(root, "registry.json");
  mkdirSync(root, { mode: 0o700, recursive: true });
  let entries: Record<string, Entry> = {};
  try { entries = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  // An approval granted for the old isolated runtime does not grant user permissions.
  let migrated = false;
  for (const entry of Object.values(entries)) {
    const last = entry.versions.at(-1);
    const offerApproval = last && last.userApproved === undefined && last.status !== "quarantined";
    for (const version of entry.versions) {
      if (version.userApproved !== undefined) continue;
      migrated = true;
      version.userApproved = false;
      if (version.status !== "quarantined") version.status = "disabled";
    }
    if (!entry.pending && offerApproval) {
      entry.pending = { manifest: last.manifest, sha: last.sha, path: join(packages, last.sha) };
    }
  }
  if (migrated) save(entries);
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
  function discard(pending: Proposal | undefined) {
    if (pending?.staged) rmSync(pending.staged, { recursive: true, force: true });
  }
  function view(id: string) {
    const e = get(id), v = active(id), p = e.pending;
    const dependencyLabels = (deps: Dependencies = {}) => Object.entries(deps).map(([name, version]) => "npm " + name + "@" + version);
    const previous = v ? [...permissions(v.manifest), ...dependencyLabels(v.dependencies)] : [];
    const requested = p ? [...permissions(p.manifest), ...dependencyLabels(p.dependencies)] : [];
    return { id, status: v?.status ?? "pending", active: v?.sha ?? null, manifest: v?.manifest ?? p!.manifest,
      failures: v?.failures ?? 0, sources: Object.entries(v?.sources ?? {}).map(([name, s]) => ({ name, paused: s.paused, invalid: s.invalid, next: s.next })),
      versions: e.versions.map(x => ({ sha: x.sha, version: x.manifest.version })),
      pending: p ? { manifest: p.manifest, sha: p.sha, directory: p.path, codeUrl: pathToFileURL(p.path).href,
        dependencies: p.dependencies ?? {}, permissions: requested, removed: previous.filter(s => !requested.includes(s)),
        expanded: [...expanded(v?.manifest, p.manifest), ...dependencyLabels(p.dependencies).filter(s => !previous.includes(s))],
        summary: ["此插件以你的权限运行，可以读写文件、联网、执行命令", p.manifest.description, ...requested,
          ...p.manifest.secrets.map(s => s.name + " 用于" + s.purpose), "代码目录 " + p.path].join("\n") } : null };
  }
  return { root, active, view, list: () => Object.keys(entries).map(view),
    secretNames: (id: string) => get(id).versions.flatMap(v => v.manifest.secrets.map(s => s.name)),
    async propose(path: string) {
      const pending = await preparePackage(root, path);
      const id = pending.manifest.id, old = entries[id]?.pending;
      try { save({ ...entries, [id]: { versions: entries[id]?.versions ?? [], pending } }); }
      catch (error) { discard(pending); throw error; }
      discard(old);
      return view(id).pending!;
    },
    async approve(id: string, sha: unknown, at = Date.now()) {
      const proposal = get(id).pending;
      check(proposal && proposal.sha === sha, "Pending hash does not match");
      verify(proposal.path, proposal.sha);
      const p = proposal.staged ? proposal : await preparePackage(root, proposal.path);
      try {
        change(id, e => {
          check(e.pending?.sha === p.sha && p.sha === sha, "Pending hash does not match");
          const old = e.versions.at(-1);
          const known = e.versions.find(v => v.sha === sha);
          check(known?.status !== "quarantined", "Version is quarantined");
          const kv = old?.kv ?? {};
          check(known || !Object.keys(kv).length || Buffer.byteLength(JSON.stringify(kv)) <= p.manifest.resources.storageKB * 1024, "New storage quota is below current usage");
          if (p.staged && existsSync(p.staged)) activatePackage(packages, p.staged, p.sha);
          else verify(join(packages, p.sha), p.sha);
          e.versions = e.versions.filter(v => v.sha !== sha);
          const version: Version = known ?? { sha: p.sha, manifest: p.manifest, kv: structuredClone(kv),
            sources: structuredClone(old?.sources ?? {}), status: "enabled", failures: 0 };
          if (!version.userApproved) version.status = "enabled";
          version.installedAt ??= at;
          version.userApproved = true;
          version.dependencies = p.dependencies ?? {};
          e.versions.push(version);
          delete e.pending;
        });
      } finally { if (p !== proposal || !get(id).pending) discard(p); }
    },
    reject(id: string) {
      const e = get(id);
      check(e.pending, "No pending install");
      if (e.versions.length) change(id, x => { delete x.pending; });
      else { const next = { ...entries }; delete next[id]; save(next); }
      discard(e.pending);
    },
    rollback(id: string, sha?: unknown) {
      change(id, e => {
        const index = sha === undefined ? e.versions.length - 2 : e.versions.findIndex(v => v.sha === sha);
        check(index >= 0 && index < e.versions.length - 1, "Unknown previous version");
        const target = e.versions[index]!;
        check(target.userApproved, "Version needs approval to run with user permissions");
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
      discard(e.pending);
      for (const v of e.versions) rmSync(join(packages, v.sha), { force: true, recursive: true });
    },
  };
}
export type Store = ReturnType<typeof openStore>;
