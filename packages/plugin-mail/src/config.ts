import { isIP } from "node:net";

type Endpoint = { host: string; port: number };
export type MailConfig = { dataDir?: string; address: string; authCode: string; imap: Endpoint; smtp: Endpoint };

function validHostname(host: string) {
  return host.length <= 253 && host.split(".").every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label));
}

export function validAddress(value: string) {
  const [local, domain, ...extra] = value.split("@");
  return value.length <= 254 && !!local && local.length <= 64 && !!domain && extra.length === 0 &&
    local.split(".").every(atom => /^[^\s@<>,;:"\\()\[\]\x00-\x1f\x7f]+$/u.test(atom)) &&
    domain.includes(".") && validHostname(domain);
}

function endpoint(value: string, key: string): Endpoint {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(value);
  const host = match?.[1] ?? match?.[2] ?? "";
  const port = Number(match?.[3]);
  const validHost = match?.[1] ? isIP(host) === 6 : validHostname(host);
  if (!validHost || !port || port > 65535) throw new Error(`${key} requires host:port`);
  return { host, port };
}

export function mailConfigFromEnv(env: NodeJS.ProcessEnv): MailConfig | undefined {
  const address = env.ALTER_MAIL_ADDRESS?.trim();
  if (!address) return undefined;
  if (!validAddress(address)) throw new Error("Invalid ALTER_MAIL_ADDRESS");
  const authCode = env.ALTER_MAIL_AUTH_CODE?.trim();
  if (!authCode) throw new Error("Missing ALTER_MAIL_AUTH_CODE");
  return {
    address, authCode,
    imap: endpoint(env.ALTER_MAIL_IMAP?.trim() ?? "imap.163.com:993", "ALTER_MAIL_IMAP"),
    smtp: endpoint(env.ALTER_MAIL_SMTP?.trim() ?? "smtp.163.com:465", "ALTER_MAIL_SMTP"),
  };
}
