// Reads the repo-root .env (TYPESENSE_HOST, TYPESENSE_ADMIN_API_KEY) without
// a dependency. Values already in process.env win.
import {existsSync, readFileSync} from "node:fs";
import {resolve} from "node:path";

export function loadRootEnv(): void {
  const file = resolve(__dirname, "../../.env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

// "xyz.a1.typesense.net" → https://xyz.a1.typesense.net; a full URL is kept.
export function typesenseBaseUrl(host: string): string {
  const h = host.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(h) ? h : `https://${h}`;
}

export function isLocalHost(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl);
}
