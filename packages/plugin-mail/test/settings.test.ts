import { expect, it, vi } from "vitest";
import { mailInstance } from "../src/settings.ts";
import { defaultClients, smtpTransport } from "../src/client.ts";
import { fakeMail } from "./fake.ts";

it("authenticates to IMAP and verifies SMTP without delivering a message", async () => {
  const config = { ALTER_MAIL_ADDRESS: "me@example.test", ALTER_MAIL_AUTH_CODE: "offline-code" };
  const fake = fakeMail();
  const transport = smtpTransport({ address: config.ALTER_MAIL_ADDRESS, authCode: config.ALTER_MAIL_AUTH_CODE,
    imap: { host: "localhost", port: 993 }, smtp: { host: "localhost", port: 465 } });
  const client = await import("../src/client.ts");
  vi.spyOn(client, "smtpTransport").mockReturnValue(transport);
  vi.spyOn(defaultClients, "imap").mockImplementation(fake.clients.imap);
  const verify = vi.spyOn(transport, "verify").mockResolvedValue(true);
  const send = vi.spyOn(transport, "sendMail");
  try {
    const plugin = mailInstance(config, () => {});
    expect(await plugin.status()).toMatchObject({ state: "ok", checks: [{ id: "imap", ok: true }, { id: "smtp", ok: true }] });
    verify.mockRejectedValueOnce(new Error(config.ALTER_MAIL_AUTH_CODE));
    const failure = await plugin.status();
    expect(failure).toMatchObject({ state: "error", checks: [{ ok: true }, { ok: false }] });
    expect(JSON.stringify(failure)).not.toContain(config.ALTER_MAIL_AUTH_CODE);
    expect(send).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); }
});
