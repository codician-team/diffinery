/**
 * GitHub Actions workflow commands (`::name k=v::message` on stdout) and file
 * commands (`$GITHUB_ENV`, `$GITHUB_OUTPUT`, ... files).
 */

export interface WorkflowCommand {
  command: string;
  properties: Record<string, string>;
  message: string;
}

export function unescapeData(s: string): string {
  return s.replace(/%0D/gi, "\r").replace(/%0A/gi, "\n").replace(/%25/g, "%");
}

export function unescapeProperty(s: string): string {
  return s
    .replace(/%0D/gi, "\r")
    .replace(/%0A/gi, "\n")
    .replace(/%3A/gi, ":")
    .replace(/%2C/gi, ",")
    .replace(/%25/g, "%");
}

/** Parses a `::command props::message` line. Returns null if not a command. */
export function parseCommand(line: string): WorkflowCommand | null {
  const trimmed = line.replace(/^\s+/, "");
  if (!trimmed.startsWith("::")) return null;
  const end = trimmed.indexOf("::", 2);
  if (end < 0) return null;
  const head = trimmed.slice(2, end);
  const message = trimmed.slice(end + 2);
  const sp = head.indexOf(" ");
  const command = (sp < 0 ? head : head.slice(0, sp)).trim();
  if (!command || !/^[A-Za-z0-9_.-]+$/.test(command)) return null;
  const properties: Record<string, string> = {};
  if (sp >= 0) {
    for (const part of head.slice(sp + 1).split(",")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      properties[part.slice(0, eq).trim()] = unescapeProperty(part.slice(eq + 1));
    }
  }
  return { command, properties, message: unescapeData(message) };
}

/**
 * Parses an env-file style file command (GITHUB_ENV / GITHUB_OUTPUT /
 * GITHUB_STATE): `name=value` lines and `name<<DELIM` heredocs.
 */
export function parseKeyValueFile(content: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (!content) return out;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") continue;
    const eq = line.indexOf("=");
    const hd = line.indexOf("<<");
    if (hd > 0 && (eq < 0 || hd < eq)) {
      const name = line.slice(0, hd);
      const delim = line.slice(hd + 2);
      if (!name || !delim) throw new Error(`Invalid file command format: ${line}`);
      const buf: string[] = [];
      let found = false;
      for (i++; i < lines.length; i++) {
        if (lines[i] === delim) {
          found = true;
          break;
        }
        buf.push(lines[i]!);
      }
      if (!found) throw new Error(`Matching delimiter not found '${delim}'`);
      out.push([name, buf.join("\n")]);
      continue;
    }
    if (eq <= 0) throw new Error(`Invalid file command format: ${line}`);
    out.push([line.slice(0, eq), line.slice(eq + 1)]);
  }
  return out;
}

/** GITHUB_PATH: one directory per line. */
export function parsePathFile(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}
