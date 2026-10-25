/**
 * Release notes like GitHub's "Generate release notes": merged pull requests
 * between two tags, grouped by the categories in `.github/release.yml`, then
 * first-time contributors and a full changelog link. Pure, so it is unit-tested.
 * https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes
 */
import { parse } from "yaml";

export interface NotesPull {
  number: number;
  title: string;
  author: string;
  labels: string[];
  url: string;
}

export interface NotesCategory {
  title: string;
  labels: string[];
  exclude?: { labels?: string[]; authors?: string[] };
}

export interface NotesConfig {
  exclude?: { labels?: string[]; authors?: string[] };
  categories?: NotesCategory[];
}

const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : undefined);

/** Parse `.github/release.yml`; returns an empty config for anything malformed. */
export function parseReleaseConfig(text: string): NotesConfig {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return {};
  }
  const changelog = (doc as { changelog?: Record<string, unknown> } | null)?.changelog;
  if (!changelog || typeof changelog !== "object") return {};
  const ex = changelog.exclude as Record<string, unknown> | undefined;
  const out: NotesConfig = {};
  if (ex && typeof ex === "object") out.exclude = { labels: strings(ex.labels), authors: strings(ex.authors) };
  if (Array.isArray(changelog.categories)) {
    out.categories = [];
    for (const raw of changelog.categories as Array<Record<string, unknown>>) {
      if (!raw || typeof raw !== "object" || typeof raw.title !== "string") continue;
      const cex = raw.exclude as Record<string, unknown> | undefined;
      out.categories.push({ title: raw.title, labels: strings(raw.labels) ?? [], exclude: cex && typeof cex === "object" ? { labels: strings(cex.labels), authors: strings(cex.authors) } : undefined });
    }
  }
  return out;
}

const hasAny = (labels: string[], wanted: string[] | undefined) => !!wanted?.length && (wanted.includes("*") || labels.some((l) => wanted.includes(l)));
const byAuthor = (author: string, authors: string[] | undefined) => !!authors?.some((a) => a === "*" || a.toLowerCase() === author.toLowerCase());

const line = (p: NotesPull) => `* ${p.title} by @${p.author} in ${p.url}`;

export function renderReleaseNotes(input: { pulls: NotesPull[]; newContributors: NotesPull[]; changelogUrl: string; config?: NotesConfig }): string {
  const cfg = input.config ?? {};
  const pulls = input.pulls.filter((p) => !hasAny(p.labels, cfg.exclude?.labels) && !byAuthor(p.author, cfg.exclude?.authors));
  const parts: string[] = [];
  if (pulls.length) {
    const sections: string[] = [];
    if (cfg.categories?.length) {
      const placed = new Set<number>();
      for (const cat of cfg.categories) {
        const items = pulls.filter((p) => !placed.has(p.number) && hasAny(p.labels, cat.labels) && !hasAny(p.labels, cat.exclude?.labels) && !byAuthor(p.author, cat.exclude?.authors));
        for (const p of items) placed.add(p.number);
        if (items.length) sections.push(`### ${cat.title}\n${items.map(line).join("\n")}`);
      }
      const other = pulls.filter((p) => !placed.has(p.number));
      if (other.length) sections.push(`### Other Changes\n${other.map(line).join("\n")}`);
    } else sections.push(pulls.map(line).join("\n"));
    parts.push(`## What's Changed\n${sections.join("\n\n")}`);
  }
  if (input.newContributors.length) {
    parts.push(`## New Contributors\n${input.newContributors.map((p) => `* @${p.author} made their first contribution in ${p.url}`).join("\n")}`);
  }
  parts.push(`**Full Changelog**: ${input.changelogUrl}`);
  return parts.join("\n\n");
}
