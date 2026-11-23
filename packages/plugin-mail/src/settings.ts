import type { PluginDescription, PluginStatus } from "@alter/core";
import { defaultClients, smtpTransport, withImap } from "./client.ts";
import { mailConfigFromEnv } from "./config.ts";
import { createMailPlugin } from "./index.ts";

export const mailDescription: PluginDescription = { id: "mail", name: "邮件",
  provides: { channels: [], capabilities: ["mail"], sources: ["mail"] }, settings: [
    { key: "ALTER_MAIL_ADDRESS", label: "邮箱地址", type: "text", required: true, help: "用于登录和发信的邮箱地址。" },
    { key: "ALTER_MAIL_AUTH_CODE", label: "授权码", type: "secret", required: true, help: "邮箱服务商签发的客户端授权码。" },
    { key: "ALTER_MAIL_IMAP", label: "IMAP 服务器", type: "text", required: false, help: "收信服务器及端口。", default: "imap.163.com:993" },
    { key: "ALTER_MAIL_SMTP", label: "SMTP 服务器", type: "text", required: false, help: "发信服务器及端口。", default: "smtp.163.com:465" },
  ] };

export function mailInstance(env: NodeJS.ProcessEnv, changed: () => void) {
  const config = mailConfigFromEnv(env)!;
  let imap = false;
  let smtp = false;
  const plugin = createMailPlugin(config, defaultClients, ok => {
    if (imap !== ok) { imap = ok; changed(); }
  });
  return { plugin, async status(probe = true): Promise<PluginStatus> {
    if (probe) {
      const transport = smtpTransport(config, true);
      try {
        [imap, smtp] = await Promise.all([withImap(config, defaultClients, async () => true).catch(() => false),
          transport.verify().then(() => true, () => false)]);
      } finally { transport.close(); }
    }
    const checks = [{ id: "imap", label: "IMAP 登录", ok: imap }, { id: "smtp", label: "SMTP 可用", ok: smtp }];
    const failed = checks.filter(check => !check.ok);
    return { state: failed.length ? "error" : "ok", checks,
      ...(failed.length && { detail: failed.map(check => check.label).join("、") + "失败，请检查地址、端口和授权码。" }) };
  } };
}
