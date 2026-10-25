import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { CliError, type Io } from "./io.js";

export const DEFAULT_URL = "https://diffinery.com";

export interface StoredConfig {
  url?: string;
  token?: string;
}

export interface ResolvedConfig {
  url: string;
  token: string | null;
  /** Where the token came from, for messages. */
  tokenSource: "env" | "config" | null;
  urlSource: "env" | "config" | "default";
  file: string;
}

export function configDir(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(env.HOME || homedir(), ".config");
  return path.join(base, "diffinery");
}

export const configPath = (env: NodeJS.ProcessEnv) => path.join(configDir(env), "config.json");

export async function readConfig(env: NodeJS.ProcessEnv): Promise<StoredConfig> {
  const file = configPath(env);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object") return {};
    const o = v as Record<string, unknown>;
    return { url: typeof o.url === "string" ? o.url : undefined, token: typeof o.token === "string" ? o.token : undefined };
  } catch {
    throw new CliError(`${file} is not valid JSON; fix or delete it`);
  }
}

export async function writeConfig(env: NodeJS.ProcessEnv, cfg: StoredConfig): Promise<string> {
  const dir = configDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode only applies to a directory it creates: an existing one may be readable by others.
  await chmod(dir, 0o700);
  const file = configPath(env);
  const clean: StoredConfig = {};
  if (cfg.url) clean.url = cfg.url;
  if (cfg.token) clean.token = cfg.token;
  // A new file that is never readable by others, then renamed over the old one, so the token is never
  // in a loosely permissioned file, even for a moment, and a crash never leaves half a config.
  const tmp = path.join(dir, `.config.json.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(clean, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return file;
}

/** localhost, *.localhost, 127.0.0.0/8 and ::1. */
export function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Normalizes a user-typed server URL: adds https://, drops trailing slashes and any path. */
export function normalizeUrl(u: string): string {
  let s = u.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    throw new CliError(`invalid URL: ${u}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new CliError(`URL must be http(s): ${u}`);
  // Tokens go with every request: plain http only to this machine (a local development server).
  if (parsed.protocol === "http:" && !isLoopback(parsed.hostname)) throw new CliError(`refusing ${parsed.protocol}//${parsed.host}: tokens would be sent unencrypted; use https (plain http works only for localhost)`);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** Env vars override the config file; the URL falls back to the public instance. */
export async function resolveConfig(io: Io): Promise<ResolvedConfig> {
  const stored = await readConfig(io.env);
  const envUrl = io.env.DIFFINERY_URL?.trim();
  const envToken = io.env.DIFFINERY_TOKEN?.trim();
  const url = envUrl ? normalizeUrl(envUrl) : stored.url ? normalizeUrl(stored.url) : DEFAULT_URL;
  const token = envToken || stored.token || null;
  return {
    url,
    token,
    tokenSource: envToken ? "env" : stored.token ? "config" : null,
    urlSource: envUrl ? "env" : stored.url ? "config" : "default",
    file: configPath(io.env),
  };
}
