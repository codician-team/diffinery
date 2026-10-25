/**
 * Token usage from model responses, read by the model proxy as they stream
 * through it, so a run's token budget is charged by Diffinery and not trusted
 * to the agent. Understands Anthropic Messages, OpenAI Responses and Chat
 * Completions, streamed (SSE) or not.
 */

export interface Usage {
  /** Input tokens read without a cache. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Tokens as a budget counts them: cache reads cost about a tenth of other
 * input with every provider, so they count as a tenth.
 */
export const weighted = (u: Usage): number => u.input + u.cacheWrite + u.output + Math.ceil(u.cacheRead / 10);

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** The usage one response object (or stream event) reports, if any. */
export function usageOf(o: unknown): Usage | null {
  if (!o || typeof o !== "object") return null;
  const x = o as Record<string, unknown>;
  const u = (x.usage ?? (x.message as Record<string, unknown> | undefined)?.usage ?? (x.response as Record<string, unknown> | undefined)?.usage) as Record<string, unknown> | undefined;
  if (!u || typeof u !== "object") return null;
  if ("prompt_tokens" in u || "completion_tokens" in u) {
    // Chat Completions: prompt_tokens includes cached ones.
    const cached = n((u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens);
    return { input: Math.max(n(u.prompt_tokens) - cached, 0), output: n(u.completion_tokens), cacheRead: cached, cacheWrite: 0 };
  }
  const details = u.input_tokens_details as Record<string, unknown> | undefined;
  if (details && "cached_tokens" in details) {
    // OpenAI Responses: input_tokens includes cached ones.
    const cached = n(details.cached_tokens);
    return { input: Math.max(n(u.input_tokens) - cached, 0), output: n(u.output_tokens), cacheRead: cached, cacheWrite: 0 };
  }
  // Anthropic: input_tokens excludes cache reads and writes.
  return { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) };
}

/** Events of one response report running totals (Anthropic's message_start, then message_delta): keep the largest of each. */
const fold = (a: Usage | null, b: Usage | null): Usage | null => (!a ? b : b ? { input: Math.max(a.input, b.input), output: Math.max(a.output, b.output), cacheRead: Math.max(a.cacheRead, b.cacheRead), cacheWrite: Math.max(a.cacheWrite, b.cacheWrite) } : a);

const parse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** The most of a non-streamed body that is read for its usage. */
const MAX_JSON = 16 * 1024 * 1024;

/** An SSE line longer than this can't be a usage event: it is dropped rather than buffered. */
const MAX_SSE_LINE = 1024 * 1024;

/** Read a response body (a tee of what goes back to the agent) for the usage it reports; null when it reports none. */
export async function readUsage(body: ReadableStream<Uint8Array>, contentType: string): Promise<Usage | null> {
  return (await meterUsage(body, contentType)).usage;
}

/**
 * The usage a response reports, and whether part of it couldn't be read: an SSE line too long to keep, or a
 * JSON body too large to parse. Usage may have been in that part (a streamed Responses answer reports it only
 * in `response.completed`, which carries the whole answer), so runs held to their bookings charge the most
 * the request could have cost instead (`unreadCharge`).
 */
export async function meterUsage(body: ReadableStream<Uint8Array>, contentType: string): Promise<{ usage: Usage | null; unreadable: boolean }> {
  const sse = contentType.includes("text/event-stream");
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let usage: Usage | null = null;
  let buf = "";
  let size = 0;
  let dropping = false;
  let unreadable = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!sse) {
        size += value.length;
        if (size <= MAX_JSON) buf += value;
        continue;
      }
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        // The rest of a line already dropped.
        if (dropping) {
          dropping = false;
          continue;
        }
        if (line.startsWith("data:")) usage = fold(usage, usageOf(parse(line.slice(5).trim())));
      }
      if (buf.length > MAX_SSE_LINE) {
        buf = "";
        dropping = true;
        unreadable = true;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (sse) return { usage: !dropping && buf.trim().startsWith("data:") ? fold(usage, usageOf(parse(buf.trim().slice(5).trim()))) : usage, unreadable };
  if (size > MAX_JSON) return { usage, unreadable: true };
  return { usage: fold(usage, usageOf(parse(buf))), unreadable };
}

/**
 * What a request whose answer's usage couldn't be read, or that reported none, is charged on a run held to its
 * bookings: a token per byte it sent (three times its estimate's input; it can pull in nothing else, see
 * prepareRequest), and the output cap it was sent with. Images and PDFs bill by pixels and pages instead, which
 * the limit on requests at once (inflight.ts) bounds.
 */
export const unreadCharge = (estimate: Usage, size: number): Usage => ({ ...estimate, input: Math.max(estimate.input, size) });

export const formatTokens = (t: number): string => (t >= 1_000_000 ? `${+(t / 1_000_000).toFixed(1)}M` : t >= 1000 ? `${Math.round(t / 1000)}k` : String(t));

/**
 * What a CLI reports about its own usage in one line of its output (phase 5a), for runs whose model
 * requests don't pass Diffinery: a terminal's signed-in subscription. Claude Code's `result` event
 * gives its run's totals and cost (`set`); each Codex `turn.completed` gives one turn's tokens (`add`).
 */
export function reportedUsage(runtime: string, line: string): { usage: Usage; costUsd: number | null; mode: "set" | "add" } | null {
  const claude = runtime === "claude-code" && line.startsWith('{"type":"result"');
  const codex = runtime === "codex" && line.startsWith('{"type":"turn.completed"');
  if (!claude && !codex) return null;
  const j = parse(line) as Record<string, unknown> | null;
  if (!j || typeof j !== "object") return null;
  const u = j.usage as Record<string, unknown> | undefined;
  if (!u || typeof u !== "object") return null;
  if (codex) {
    // Codex: input_tokens includes the cached ones.
    const cached = n(u.cached_input_tokens);
    return { usage: { input: Math.max(n(u.input_tokens) - cached, 0), output: n(u.output_tokens), cacheRead: cached, cacheWrite: 0 }, costUsd: null, mode: "add" };
  }
  const cost = typeof j.total_cost_usd === "number" && Number.isFinite(j.total_cost_usd) && j.total_cost_usd >= 0 ? j.total_cost_usd : null;
  return { usage: { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) }, costUsd: cost, mode: "set" };
}

/**
 * A run's usage as people see it (phase 5a). Requests through the model proxy are counted by Diffinery
 * (`proxy`); a run with none, in a terminal on a subscription, has only what its CLI reported (`runtime`).
 * The cost is always the CLI's own figure (Claude Code's), never computed here.
 */
export interface RunUsage {
  source: "proxy" | "runtime";
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
}

export function runUsage(r: {
  model_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reported_input: number;
  reported_output: number;
  reported_cache_read: number;
  reported_cache_write: number;
  cost_usd: number | null;
}): RunUsage | null {
  const costUsd = r.cost_usd ?? null;
  if (r.model_calls > 0) return { source: "proxy", requests: r.model_calls, input: r.input_tokens, output: r.output_tokens, cacheRead: r.cache_read_tokens, cacheWrite: r.cache_write_tokens, costUsd };
  if (r.reported_input || r.reported_output || r.reported_cache_read || r.reported_cache_write || costUsd !== null)
    return { source: "runtime", requests: 0, input: r.reported_input, output: r.reported_output, cacheRead: r.reported_cache_read, cacheWrite: r.reported_cache_write, costUsd };
  return null;
}

/** Several runs' usage added up; the cost counts the runs that reported one, and is null when none did. */
export function totalUsage(list: Array<RunUsage | null>): Omit<RunUsage, "source"> | null {
  const xs = list.filter((u): u is RunUsage => !!u);
  if (!xs.length) return null;
  const costs = xs.map((u) => u.costUsd).filter((c): c is number => c !== null);
  return {
    requests: xs.reduce((a, u) => a + u.requests, 0),
    input: xs.reduce((a, u) => a + u.input, 0),
    output: xs.reduce((a, u) => a + u.output, 0),
    cacheRead: xs.reduce((a, u) => a + u.cacheRead, 0),
    cacheWrite: xs.reduce((a, u) => a + u.cacheWrite, 0),
    costUsd: costs.length ? costs.reduce((a, c) => a + c, 0) : null,
  };
}

/** Usage as the REST API and MCP give it, with GitHub-style snake_case names. */
export const usageJson = (u: Omit<RunUsage, "source"> & { source?: RunUsage["source"] }) => ({
  ...(u.source ? { source: u.source } : {}),
  requests: u.requests,
  input_tokens: u.input,
  output_tokens: u.output,
  cache_read_tokens: u.cacheRead,
  cache_write_tokens: u.cacheWrite,
  cost_usd: u.costUsd === null ? null : Math.round(u.costUsd * 10_000) / 10_000,
});

/** A cost in dollars as a person reads it: cents, or less than a cent. */
export const formatCost = (usd: number): string => (usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`);

/** The output an estimate assumes when a request doesn't cap it. */
export const DEFAULT_MAX_OUTPUT = 32_000;
/** What a compaction may write back, which its request can't cap: the most any current OpenAI model emits. */
export const COMPACT_MAX_OUTPUT = 128_000;
/**
 * The most output one request books, whatever cap it asks for: more than any model emits, and small enough
 * that bookings and refunds add up exactly (a cap of 1e300 would swallow a month's count when refunded).
 */
export const MAX_OUTPUT_ESTIMATE = 1_000_000;

/** Runs whose requests must stay within what was booked for them. */
const LIMITED = "agent reviews, runs with a token budget and runs on an organization's key";

/** Endpoints that generate tokens, so each request books an estimate, with the fields that cap their output. */
const GENERATES: Record<string, string[]> = {
  "/v1/messages": ["max_tokens"],
  "/v1/responses": ["max_output_tokens"],
  "/v1/responses/compact": [],
  "/v1/chat/completions": ["max_completion_tokens", "max_tokens"],
  // OpenRouter's legacy text completions.
  "/v1/completions": ["max_tokens"],
};

export interface PreparedRequest {
  /** The body to forward (changed only to ask for usage). */
  body: string;
  /** What the request may cost at most, booked before it goes upstream; null for requests that generate nothing. */
  estimate: Usage | null;
  /** Why a review may not send this request, if it may not. */
  reviewRefuse?: string;
  /** The body a run held to its bookings sends instead: every output cap set to the booked one and no paid provider-side tools, so the estimate holds. */
  reviewBody?: string;
  /**
   * The body any other run sends when the request asks for provider-run tools (MCP servers, web fetch or search):
   * the provider would reach hosts on the run's behalf, past the jail's allowlist, so they are dropped.
   */
  jailBody?: string;
  /** The model the request asks for (null when it names none), for runs pinned to one. */
  model?: string | null;
  /** A routing field the request sets, which a pinned run may not. */
  routing?: string;
}

/**
 * Request fields that choose other models, providers or paid extras (OpenRouter's fallbacks and routing,
 * plugins, web search, and more answers to pick from): a review or a run pinned to a model may not set them,
 * or its code could switch to a far pricier model than the one its budget was set for.
 */
const ROUTING = ["models", "route", "provider", "plugins", "web_search_options", "speed", "best_of", "preset"] as const;

/**
 * Why a run may not send a prepared request: a review never sets routing fields, and a run pinned to a model
 * (one that goes through OpenRouter with a model chosen in Diffinery) asks only for that model.
 */
export function pinRefusal(p: Pick<PreparedRequest, "estimate" | "model" | "routing">, run: { review: boolean; model: string | null; orgKey?: boolean }): string | undefined {
  const who = run.review || run.orgKey ? LIMITED : "this task";
  if ((run.review || run.orgKey || run.model) && p.routing) return `${p.routing} isn't available to ${who}: Diffinery pins the model and its routing`;
  if (run.model && p.estimate && p.model !== run.model) return `this ${run.review ? "review" : "task"} runs on ${run.model}${p.model ? `, not ${p.model}` : ""}`;
  return undefined;
}

/**
 * The tools a review's requests may carry: tools the agent runs itself. Function and custom tools (and Anthropic's,
 * which have no type), and the client-run built-ins, versioned or not (bash_20250124, text_editor_20250728, OpenAI's
 * local_shell and apply_patch). Every other tool type runs on the provider and may cost extra beyond tokens (web
 * search, web fetch, code execution, file search, MCP, and whatever providers add next), so it is dropped, with
 * `mcp_servers`: a review's token budget then bounds what it spends.
 */
const CLIENT_TOOL = /^(function|custom|(bash|text_editor|computer|memory|local_shell|shell|apply_patch)(_\d+)?)$/;

const typeOf = (t: unknown): unknown => (t && typeof t === "object" ? (t as { type?: unknown }).type : undefined);
const clientTool = (t: unknown): boolean => {
  const type = typeOf(t);
  // A tool with an environment other than the agent's own (OpenAI's hosted shell, in a provider's container) runs there.
  const env = t && typeof t === "object" ? (t as { environment?: unknown }).environment : undefined;
  if (env !== undefined && typeOf(env) !== "local") return false;
  return !!t && typeof t === "object" && (type === undefined || (typeof type === "string" && CLIENT_TOOL.test(type)));
};
/** The name a tool or a tool choice gives: Anthropic's and Responses' `name`, or Chat Completions' `function.name`. */
const nameOf = (t: unknown): unknown => (t && typeof t === "object" ? ((t as { name?: unknown }).name ?? ((t as { function?: { name?: unknown } }).function?.name)) : undefined);

/** A request's fields with only client-run tools; the same object when it has nothing else. */
function withoutPaidTools(x: Record<string, unknown>): Record<string, unknown> {
  const tools = Array.isArray(x.tools) ? (x.tools as unknown[]) : null;
  const kept = tools?.filter(clientTool) ?? [];
  const dropTools = !!tools && kept.length !== tools.length;
  if (!dropTools && x.mcp_servers === undefined) return x;
  const out: Record<string, unknown> = { ...x };
  delete out.mcp_servers;
  if (dropTools) {
    if (kept.length) out.tools = kept;
    else delete out.tools;
    // A tool choice that names a tool, or a tool type, that isn't kept would be refused upstream, as would any choice once no tools are left.
    const choice = out.tool_choice;
    if (!kept.length) delete out.tool_choice;
    else if (choice && typeof choice === "object") {
      const type = typeOf(choice);
      const name = nameOf(choice);
      const general = type === "auto" || type === "any" || type === "none";
      const keptName = name !== undefined && kept.some((t) => nameOf(t) === name);
      const keptType = typeof type === "string" && type !== "function" && type !== "custom" && type !== "tool" && kept.some((t) => typeOf(t) === type);
      if (!general && !keptName && !keptType) delete out.tool_choice;
    }
  }
  return out;
}

/**
 * Fields that pull in context stored at the provider, which the request's size doesn't show: the Responses API's
 * stored responses, conversations and prompts, and Anthropic's containers (with their skills and files).
 */
const storedContext = (path: string): readonly string[] => (path.startsWith("/v1/responses") ? ["previous_response_id", "conversation", "prompt"] : path === "/v1/messages" ? ["container"] : []);

/** The fields of a request that carry its input (and none of its tools or settings). */
const INPUT_FIELDS = ["messages", "input", "system", "instructions"] as const;

/** Keys whose value, a string or `{ url }`, is an image, file, audio or video given by URL unless it is a `data:` URL. */
const MEDIA_URL = ["image_url", "file_url", "video_url", "audio_url"] as const;

/**
 * Input the provider fetches or looks up itself, so the request's size doesn't show what it costs: Responses
 * `item_reference` items (stored context, like previous_response_id), anything given by file id, and images,
 * documents and files given by URL (Anthropic's `url` and `file` sources, Responses' `input_file` and `input_image`,
 * Chat Completions' `image_url` and `file` parts, OpenRouter's `file_data` URLs). Only what was sent counts:
 * a tool call's own arguments (Claude Code's WebFetch takes a URL) are never read as input; every other field
 * of the call is.
 */
export function remoteInput(x: Record<string, unknown>): string | undefined {
  const stack: unknown[] = INPUT_FIELDS.map((k) => x[k]);
  const isUrl = (v: unknown) => typeof v === "string" && !v.startsWith("data:");
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== "object") continue;
    if (Array.isArray(v)) {
      for (const e of v) stack.push(e);
      continue;
    }
    const o = v as Record<string, unknown>;
    const type = o.type;
    if (type === "item_reference") return "item_reference inputs";
    if (typeof o.file_id === "string") return "inputs given by file id";
    const src = o.source as Record<string, unknown> | undefined;
    if (src && typeof src === "object" && (src.type === "url" || src.type === "file")) return `inputs given by ${src.type === "url" ? "URL" : "file id"}`;
    for (const k of MEDIA_URL) {
      const m = o[k];
      if (isUrl(m) || (m && typeof m === "object" && isUrl((m as { url?: unknown }).url))) return "inputs given by URL";
    }
    if (typeof o.file_data === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(o.file_data)) return "inputs given by URL";
    // What a model asked a tool to do (its input or arguments) isn't input.
    const call = type === "tool_use" || type === "server_tool_use" || type === "function_call" || type === "custom_tool_call";
    for (const [k, e] of Object.entries(o)) if (e && typeof e === "object" && !(call && (k === "input" || k === "arguments"))) stack.push(e);
  }
  return undefined;
}

/**
 * Look at a model request before it goes upstream, so that every answer can
 * be charged: its estimate (a token per 3 bytes of request, plus the output
 * it allows) is booked up front and settled to the usage the answer reports,
 * and streamed Chat Completions are asked to include usage. A run held to
 * its bookings (LIMITED) may not start a background response, which it could
 * leave unfetched and so uncharged, pull in stored context or remote inputs
 * its estimate can't see, send a body that isn't a JSON object, or ask for
 * more than one answer; its request that doesn't cap its output is capped at
 * the estimate's DEFAULT_MAX_OUTPUT, and paid provider-side tools are
 * stripped from it. A compaction can't be capped, so it books
 * COMPACT_MAX_OUTPUT.
 */
export function prepareRequest(method: string, path: string, body: string, size: number): PreparedRequest {
  const caps = method === "POST" && Object.hasOwn(GENERATES, path) ? GENERATES[path]! : null;
  if (!caps) return { body, estimate: null };
  const json = parse(body);
  const x = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  // A request can set several caps (Chat Completions takes two): book the largest.
  const capped = x ? caps.map((k) => n(x[k])).filter((v) => v > 0) : [];
  const cap = capped.length ? Math.min(Math.max(...capped), MAX_OUTPUT_ESTIMATE) : undefined;
  const estimate: Usage = { input: Math.ceil(size / 3), output: cap ?? (caps.length ? DEFAULT_MAX_OUTPUT : COMPACT_MAX_OUTPUT), cacheRead: 0, cacheWrite: 0 };
  // A body that isn't a JSON object can't be capped or checked, and a lenient provider might still accept it.
  if (!x) return { body, estimate, reviewRefuse: `a request whose body isn't a JSON object isn't available to ${LIMITED}` };
  const stored = storedContext(path).find((k) => x[k] != null);
  const remote = remoteInput(x);
  const reviewRefuse =
    x.background != null && x.background !== false
      ? `background responses aren't available to ${LIMITED}`
      : stored
        ? `${stored} isn't available to ${LIMITED}: send the whole input instead`
        : remote
          ? `${remote} aren't available to ${LIMITED}: send the content itself instead`
          : x.n != null && x.n !== 1
            ? `more than one answer per request (n) isn't available to ${LIMITED}`
            : typeof x.model === "string" && /:online\b/i.test(x.model)
              ? `web search models (:online) aren't available to ${LIMITED}`
              : typeof x.model === "string" && /@preset\//i.test(x.model)
                ? `OpenRouter presets aren't available to ${LIMITED}`
                : undefined;
  let fields = x;
  if (path === "/v1/chat/completions" && x.stream === true) {
    const so = x.stream_options && typeof x.stream_options === "object" ? (x.stream_options as Record<string, unknown>) : {};
    if (so.include_usage !== true) fields = { ...x, stream_options: { ...so, include_usage: true } };
  }
  const out: PreparedRequest = { body: fields === x ? body : JSON.stringify(fields), estimate, model: typeof x.model === "string" ? x.model : null };
  if (reviewRefuse) out.reviewRefuse = reviewRefuse;
  const routing = ROUTING.find((k) => x[k] != null);
  if (routing) out.routing = routing;
  // A run held to its bookings sends every cap as the one booked (the default when it sets none), and no paid
  // provider-side tools: each of their steps reads more input than the request shows.
  const set = caps.filter((k) => x[k] !== undefined);
  const recap = caps[0] && (!set.length || set.some((k) => x[k] !== estimate.output));
  const unpaid = withoutPaidTools(fields);
  if (unpaid !== fields) out.jailBody = JSON.stringify(unpaid);
  const capTo = (f: Record<string, unknown>) => ({ ...f, ...Object.fromEntries((set.length ? set : [caps[0]!]).map((k) => [k, estimate.output])) });
  // Always written out again, so a key the request repeats reaches the provider once, as read here.
  out.reviewBody = JSON.stringify(recap ? capTo(unpaid) : unpaid);
  return out;
}

/** Read a request body up to `max` bytes, counting as it reads; null when it is larger. */
export async function readBody(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
