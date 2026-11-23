const inherited = ["PATH", "HOME", "LANG", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "USERPROFILE"];

export function pluginEnvironment(secretNames: string[], secretValues: string[] = []): NodeJS.ProcessEnv {
  const withheld = new Set(secretNames.map(name => name.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const key of inherited) {
    const value = process.env[key];
    if (!withheld.has(key) && value !== undefined && !secretValues.some(s => s && value.includes(s))) env[key] = value;
  }
  return env;
}
