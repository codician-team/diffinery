/**
 * Client islands: real Kumo components (kumo-ui.com) mounted over server-rendered placeholders.
 *
 * The server renders `<span class="dfy-k" data-k="select|checkbox|radio" data-p='{…}'>` with a
 * look-alike placeholder and the hidden inputs the form submits. This bundle swaps each one for
 * the Kumo component and keeps writing the same hidden inputs, so the server-side form handling
 * never sees a difference (and the forms still submit their defaults if this script fails).
 */
import { useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Select } from "@cloudflare/kumo/components/select";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Radio } from "@cloudflare/kumo/components/radio";
import { KumoPortalProvider } from "@cloudflare/kumo";

type SelectProps = {
  name: string;
  items: { value: string; label: string }[];
  value?: string;
  values?: string[];
  multiple?: boolean;
  placeholder?: string;
  label?: string;
  size?: "xs" | "sm" | "base" | "lg";
  autosubmit?: boolean;
  disabled?: boolean;
  id?: string;
};
type CheckboxProps = { name: string; value: string; checked?: boolean; label: string; description?: string; disabled?: boolean; aria?: string };
type RadioProps = {
  name: string;
  value?: string;
  items: { value: string; label: string; description?: string; disabled?: boolean }[];
  orientation?: "vertical" | "horizontal";
  label?: string;
};

/** Labels arrive as HTML the server rendered (and escaped) with its own JSX. */
const Html = ({ html }: { html: string }) => <span className="dfy-k-html" dangerouslySetInnerHTML={{ __html: html }} />;

const Hidden = ({ name, values }: { name: string; values: string[] }) => (
  <>
    {values.map((v, i) => (
      <input key={`${i}:${v}`} type="hidden" name={name} value={v} />
    ))}
  </>
);

function submitSoon(el: HTMLElement | null) {
  // Let React commit the new hidden input values first.
  setTimeout(() => el?.closest("form")?.requestSubmit(), 0);
}

function KSelect({ p }: { p: SelectProps }) {
  const ref = useRef<HTMLSpanElement>(null);
  const labels = new Map(p.items.map((i) => [i.value, i.label]));
  const [single, setSingle] = useState<string | null>(p.value ?? null);
  const [many, setMany] = useState<string[]>(p.values ?? []);
  const common = {
    items: p.items,
    size: p.size ?? "base",
    disabled: p.disabled,
    placeholder: p.placeholder,
    "aria-label": p.label,
    id: p.id,
  };
  return (
    <span ref={ref} className="dfy-k-select">
      {p.multiple ? (
        <Select<string, true>
          {...common}
          multiple
          value={many}
          onValueChange={(v) => {
            setMany(v ?? []);
            if (p.autosubmit) submitSoon(ref.current);
          }}
          renderValue={(v) => (v.length ? v.map((x) => labels.get(x) ?? x).join(", ") : null)}
        />
      ) : (
        <Select<string>
          {...common}
          value={single}
          onValueChange={(v) => {
            setSingle(v);
            if (p.autosubmit) submitSoon(ref.current);
          }}
        />
      )}
      <Hidden name={p.name} values={p.multiple ? many : single === null ? [] : [single]} />
    </span>
  );
}

function KCheckbox({ p }: { p: CheckboxProps }) {
  const [on, setOn] = useState(!!p.checked);
  return (
    <>
      <Checkbox
        checked={on}
        disabled={p.disabled}
        onCheckedChange={(v) => setOn(!!v)}
        label={
          p.label ? (
            // One child: Kumo lays label content out in a row, and the description goes under the label.
            <span className="dfy-k-lbl">
              <Html html={p.label} />
              {p.description ? <span className="dfy-k-desc" dangerouslySetInnerHTML={{ __html: p.description }} /> : null}
            </span>
          ) : undefined
        }
        aria-label={p.label ? undefined : p.aria}
      />
      <Hidden name={p.name} values={on ? [p.value] : []} />
    </>
  );
}

function KRadio({ p }: { p: RadioProps }) {
  const [v, setV] = useState<string | undefined>(p.value);
  return (
    <>
      <Radio.Group legend={undefined} orientation={p.orientation ?? "vertical"} value={v} onValueChange={(x) => setV(x as string)}>
        {p.label ? <Radio.Legend className="sr-only">{p.label}</Radio.Legend> : null}
        {p.items.map((i) => (
          <Radio.Item
            key={i.value}
            value={i.value}
            disabled={i.disabled}
            label={
              <>
                <Html html={i.label} />
                {i.description ? <span className="dfy-k-desc" dangerouslySetInnerHTML={{ __html: i.description }} /> : null}
              </>
            }
          />
        ))}
      </Radio.Group>
      <Hidden name={p.name} values={v === undefined ? [] : [v]} />
    </>
  );
}

const KINDS: Record<string, (p: never) => ReactNode> = {
  select: (p: SelectProps) => <KSelect p={p} />,
  checkbox: (p: CheckboxProps) => <KCheckbox p={p} />,
  radio: (p: RadioProps) => <KRadio p={p} />,
};

/** Kumo's dark theme keys off data-mode: the Appearance setting (data-theme) if chosen, else the system setting. */
function syncMode() {
  const fixed = document.documentElement.dataset.theme;
  if (fixed === "light" || fixed === "dark") {
    document.documentElement.dataset.mode = fixed;
    return;
  }
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => (document.documentElement.dataset.mode = mq.matches ? "dark" : "light");
  apply();
  mq.addEventListener("change", apply);
}

function portal(): HTMLElement {
  let el = document.getElementById("dfy-k-portal");
  if (!el) {
    el = document.createElement("div");
    el.id = "dfy-k-portal";
    el.className = "dfy-k dfy-k-portal";
    document.body.append(el);
  }
  return el;
}

function mount(el: HTMLElement, container: HTMLElement) {
  if (el.dataset.mounted) return;
  const kind = KINDS[el.dataset.k ?? ""];
  if (!kind) return;
  let props: unknown;
  try {
    props = JSON.parse(el.dataset.p ?? "{}");
  } catch {
    return;
  }
  el.dataset.mounted = "1";
  el.textContent = "";
  const root = createRoot(el);
  flushSync(() => root.render(<KumoPortalProvider container={container}>{kind(props as never)}</KumoPortalProvider>));
}

function start() {
  syncMode();
  const container = portal();
  const scan = (root: ParentNode) => root.querySelectorAll<HTMLElement>(".dfy-k[data-k]:not([data-mounted])").forEach((el) => mount(el, container));
  scan(document);
  // Live updates swap server-rendered fragments in place; mount the islands they bring along.
  new MutationObserver((records) => {
    for (const r of records)
      for (const n of r.addedNodes) {
        if (!(n instanceof HTMLElement) || container.contains(n)) continue;
        if (n.matches(".dfy-k[data-k]")) mount(n, container);
        else scan(n);
      }
  }).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
