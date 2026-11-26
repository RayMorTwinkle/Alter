import { check } from "./manifest.ts";

export function containsCredential(text: string, secrets: readonly string[]) {
  return secrets.some(secret => secret && text.includes(secret));
}

// Check decoded JSON strings as well as keys, including strings containing quotes or newlines.
export function withholdCredentials(value: unknown, secrets: readonly string[]) {
  if (!secrets.length) return;
  const json = JSON.stringify(value, (key, field: unknown) => {
    check(!containsCredential(key, secrets) && !(typeof field === "string" && containsCredential(field, secrets)), "Credential withheld");
    return field;
  });
  check(!json || !containsCredential(json, secrets), "Credential withheld");
}
