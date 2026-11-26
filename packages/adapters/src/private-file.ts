import { chmodSync, closeSync, openSync, writeFileSync } from "node:fs";

export const ownerOnly = (file: string) => chmodSync(file, 0o600);

export function writePrivate(file: string, value: string | Buffer, protect = ownerOnly) {
  const fd = openSync(file, "wx", 0o600);
  try {
    protect(file);
    writeFileSync(fd, value);
  } finally { closeSync(fd); }
}
