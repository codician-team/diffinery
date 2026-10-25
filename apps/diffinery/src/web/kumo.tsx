/** @jsxImportSource hono/jsx */
/**
 * Kumo form controls (kumo-ui.com) for the server-rendered pages.
 *
 * Every select, checkbox and radio on the site is a Kumo component: the server renders a
 * look-alike placeholder plus the hidden inputs the form submits, and the islands bundle
 * (../../islands/kumo.tsx, built into build/islands/) mounts the real component over it.
 * Never render a native <select>, checkbox or radio; use KSelect, KCheckbox and KRadio.
 */
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import KUMO_JS from "../../build/islands/kumo.js.txt";
import KUMO_CSS from "../../build/islands/kumo.css.txt";
import KUMO_JS_BR from "../../build/islands/kumo.js.br.bin";
import KUMO_CSS_BR from "../../build/islands/kumo.css.br.bin";
import { escapeHtml } from "./markdown.js";

// ---------------------------------------------------------------- assets

/** FNV-1a, enough to give each build its own immutable URL. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
let urls: { js: string; css: string } | undefined;
export function kumoAssets(): { js: string; css: string } {
  urls ??= { js: `/-/kumo/${fnv(KUMO_JS)}.js`, css: `/-/kumo/${fnv(KUMO_CSS)}.css` };
  return urls;
}

const ASSETS = [
  { url: () => kumoAssets().js, type: "text/javascript; charset=utf-8", text: KUMO_JS, br: KUMO_JS_BR },
  { url: () => kumoAssets().css, type: "text/css; charset=utf-8", text: KUMO_CSS, br: KUMO_CSS_BR },
];

/** The encodings an Accept-Encoding header takes (a q of 0 refuses one). */
function accepts(header: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (header ?? "").toLowerCase().split(",")) {
    const [name, ...params] = part.trim().split(";");
    const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
    if (name && (q === undefined || Number(q) > 0)) out.add(name.trim());
  }
  return out;
}

/**
 * GET /-/kumo/<hash>.{js,css}: the islands bundle and its stylesheet. Public and immutable, so app.ts
 * answers them ahead of the session lookup and rate limits, and they go out compressed as built
 * (islands/build.mjs), never compressed again per request. Workers see every request as accepting
 * br; the runtime decodes it for a client that doesn't.
 */
export function kumoAsset(req: Request): Response {
  const path = new URL(req.url).pathname;
  const asset = ASSETS.find((a) => a.url() === path);
  const headers = new Headers({ "x-content-type-options": "nosniff", "strict-transport-security": "max-age=63072000; includeSubDomains; preload", "referrer-policy": "strict-origin-when-cross-origin" });
  if (!asset) {
    headers.set("content-type", "text/plain; charset=utf-8");
    return new Response("Not found", { status: 404, headers });
  }
  headers.set("content-type", asset.type);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("vary", "accept-encoding");
  if (!accepts(req.headers.get("accept-encoding")).has("br")) return new Response(asset.text, { headers });
  headers.set("content-encoding", "br");
  // "manual": the body is already compressed; the runtime sends it as it is.
  return new Response(asset.br, { headers, encodeBody: "manual" });
}

// ---------------------------------------------------------------- helpers

/** Server-rendered HTML for a label (hono JSX escapes text; plain strings are escaped here). */
function htmlOf(c: Child): string {
  if (c === null || c === undefined || c === false || c === true) return "";
  if (typeof c === "string") return escapeHtml(c);
  if (typeof c === "number") return String(c);
  if (Array.isArray(c)) return c.map(htmlOf).join("");
  const s = (c as { toString(): unknown }).toString();
  if (typeof s !== "string") throw new Error("Kumo labels must be synchronous JSX");
  return s;
}

const Hidden = ({ name, values }: { name: string; values: string[] }) => (
  <>
    {values.map((v) => (
      <input type="hidden" name={name} value={v} />
    ))}
  </>
);

export type KOption = { value: string; label: string };

/** Kumo Select. `label` is the accessible name when there is no visible <label>. */
export const KSelect = (p: {
  name: string;
  options: KOption[];
  value?: string;
  values?: string[];
  multiple?: boolean;
  placeholder?: string;
  label?: string;
  size?: "xs" | "sm" | "base";
  /** Fill the width of the container (form fields) instead of fitting the content. */
  block?: boolean;
  /** Submit the form as soon as the value changes (filters). */
  autosubmit?: boolean;
  disabled?: boolean;
  id?: string;
}) => {
  const values = p.multiple ? (p.values ?? []) : p.value !== undefined ? [p.value] : p.placeholder ? [] : p.options[0] ? [p.options[0].value] : [];
  const shown = values.map((v) => p.options.find((o) => o.value === v)?.label ?? v).join(", ");
  const props = {
    name: p.name,
    items: p.options,
    value: p.multiple ? undefined : values[0],
    values: p.multiple ? values : undefined,
    multiple: p.multiple || undefined,
    placeholder: p.placeholder,
    label: p.label,
    size: p.size,
    autosubmit: p.autosubmit || undefined,
    disabled: p.disabled || undefined,
    id: p.id,
  };
  return (
    <span class={`dfy-k${p.block ? " block" : ""}`} data-k="select" data-p={JSON.stringify(props)}>
      <span class={`kf-select ${p.size ?? "base"}`} aria-hidden="true">
        <span class={shown ? "" : "kf-ph"}>{shown || p.placeholder || ""}</span>
        <svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor">
          <path d="M181.66 170.34a8 8 0 0 1 0 11.32l-48 48a8 8 0 0 1-11.32 0l-48-48a8 8 0 0 1 11.32-11.32L128 212.69l42.34-42.35a8 8 0 0 1 11.32 0Zm-96-84.68L128 43.31l42.34 42.35a8 8 0 0 0 11.32-11.32l-48-48a8 8 0 0 0-11.32 0l-48 48a8 8 0 0 0 11.32 11.32Z" />
        </svg>
      </span>
      <Hidden name={p.name} values={values} />
    </span>
  );
};

/**
 * Kumo Checkbox. Submits `name=value` when checked, nothing otherwise (like a native checkbox).
 * `description` is helper text shown under the label, aligned with it rather than with the box.
 */
export const KCheckbox = (p: { name: string; value?: string; checked?: boolean; label?: Child; description?: Child; aria?: string; disabled?: boolean }) => {
  const value = p.value ?? "1";
  const label = p.label === undefined ? "" : htmlOf(p.label);
  const description = p.description === undefined ? undefined : htmlOf(p.description) || undefined;
  const props = { name: p.name, value, checked: !!p.checked || undefined, label, description, aria: p.aria, disabled: p.disabled || undefined };
  return (
    <span class="dfy-k" data-k="checkbox" data-p={JSON.stringify(props)}>
      <span class="kf-check" aria-hidden="true">
        <span class={`kf-box${p.checked ? " on" : ""}`} />
        {label ? (
          <span>
            {raw(label)}
            {description ? <span class="kf-desc">{raw(description)}</span> : null}
          </span>
        ) : null}
      </span>
      <Hidden name={p.name} values={p.checked ? [value] : []} />
    </span>
  );
};

export type KRadioItem = { value: string; label: Child; description?: Child; disabled?: boolean };

/** Kumo Radio group. */
export const KRadio = (p: { name: string; value?: string; items: KRadioItem[]; orientation?: "vertical" | "horizontal"; label?: string }) => {
  const items = p.items.map((i) => ({ value: i.value, label: htmlOf(i.label), description: i.description === undefined ? undefined : htmlOf(i.description), disabled: i.disabled || undefined }));
  const props = { name: p.name, value: p.value, items, orientation: p.orientation, label: p.label };
  return (
    <span class="dfy-k block" data-k="radio" data-p={JSON.stringify(props)}>
      <span class={`kf-radio ${p.orientation ?? "vertical"}`} aria-hidden="true">
        {items.map((i) => (
          <span class="kf-check">
            <span class={`kf-dot${i.value === p.value ? " on" : ""}`} />
            <span>
              {raw(i.label)}
              {i.description ? <span class="kf-desc">{raw(i.description)}</span> : null}
            </span>
          </span>
        ))}
      </span>
      <Hidden name={p.name} values={p.value === undefined ? [] : [p.value]} />
    </span>
  );
};
