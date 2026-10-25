import type { AppContext } from "../auth/principal.js";
import { Directory } from "../lib/directory.js";
import { taskPersonAllowed } from "./access.js";
import { isProvider, ModelKeys, PROVIDERS, type Provider } from "./keys.js";
import { bookSpend, proxyPayer, settleSpend, spendMonth } from "./org-policy.js";
import { freeSlot, MAX_IN_FLIGHT, takeSlot } from "./inflight.js";
import { overLimit } from "../lib/rate-limit.js";
import { meterUsage, NO_USAGE, prepareRequest, readBody, unreadCharge, weighted } from "./usage.js";

/** The largest model request the proxy forwards (it reads each one to charge it). */
const MAX_REQUEST = 32 * 1024 * 1024;

/**
 * The model proxy: `/-/model/<provider>/v1/...`. A task's runtime calls it
 * with the run's token (`dmt_...`, as its API key) and the proxy forwards the
 * request to the provider with the key of whoever pays (the person's own, or
 * under its policy an organization's: org-policy.ts), decrypted here for this
 * request only. So no key ever enters a sandbox, container or terminal, and the
 * token stops working when the run ends.
 *
 * It runs before the app's identity middleware: its token isn't an account
 * credential and works nowhere else.
 */

const UPSTREAM: Record<Provider, string> = { anthropic: "https://api.anthropic.com", openai: "https://api.openai.com", openrouter: "https://openrouter.ai/api" };

/**
 * Only the model endpoints the runtimes use. The person's key could reach the
 * rest of their provider account (stored files, batches, assistants), which an
 * agent misled by repository content must not.
 */
const ALLOWED: Record<Provider, Array<[method: string, path: RegExp]>> = {
  anthropic: [
    ["POST", /^\/v1\/messages$/],
    ["POST", /^\/v1\/messages\/count_tokens$/],
    ["GET", /^\/v1\/models(\/[A-Za-z0-9._:-]+)?$/],
  ],
  openai: [
    ["POST", /^\/v1\/responses$/],
    // Codex compacts long conversations, and reads a background response back by id.
    ["POST", /^\/v1\/responses\/compact$/],
    ["GET", /^\/v1\/responses\/[A-Za-z0-9_-]+$/],
    ["POST", /^\/v1\/chat\/completions$/],
    ["GET", /^\/v1\/models(\/[A-Za-z0-9._:-]+)?$/],
  ],
  // OpenRouter: its Anthropic-compatible Messages endpoint (Claude Code), the OpenAI-compatible ones (Codex,
  // custom commands) and the model list. Never keys, credits, generation stats or anything else on the account.
  openrouter: [
    ["POST", /^\/v1\/messages$/],
    ["POST", /^\/v1\/messages\/count_tokens$/],
    ["POST", /^\/v1\/responses$/],
    ["POST", /^\/v1\/chat\/completions$/],
    ["POST", /^\/v1\/completions$/],
    ["GET", /^\/v1\/models$/],
  ],
};

export const proxyAllows = (provider: Provider, method: string, path: string): boolean => ALLOWED[provider].some(([m, re]) => m === method && re.test(path));

/** Request headers that never go upstream: credentials, cookies and the hop's own. */
const DROP = new Set(["authorization", "x-api-key", "cookie", "host", "content-length", "connection", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "x-forwarded-for", "x-forwarded-proto", "x-real-ip"]);

/** OpenRouter's app attribution and request options: only Diffinery sets these, never the sandbox. */
const ATTRIBUTION = /^(x-openrouter-.*|x-title|http-referer|referer)$/i;

/** Headers that pick an organization or project within a provider account (OpenAI's). */
const ACCOUNT_SCOPE = /^openai-(organization|project)$/i;

const err = (status: number, message: string) =>
  new Response(JSON.stringify({ type: "error", error: { type: status === 401 ? "authentication_error" : status === 404 ? "not_found_error" : status === 429 ? "rate_limit_error" : "permission_error", message } }), { status, headers: { "content-type": "application/json" } });

export function proxyToken(req: Request): string | null {
  const key = req.headers.get("x-api-key");
  if (key?.startsWith("dmt_")) return key.trim();
  const m = /^Bearer\s+(dmt_\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1]! : null;
}

export async function modelProxy(c: AppContext): Promise<Response> {
  const provider = c.req.param("provider") ?? "";
  if (!isProvider(provider)) return err(404, "unknown model provider");
  const url = new URL(c.req.url);
  const rest = url.pathname.slice(`/-/model/${provider}`.length);
  if (!proxyAllows(provider, c.req.method, rest)) return err(403, `${c.req.method} ${rest} isn't available to agent tasks: only the ${PROVIDERS[provider].name} model endpoints are`);
  const token = proxyToken(c.req.raw);
  if (!token) return err(401, "a task's model token is required");
  const repoId = token.split("_")[1];
  if (!repoId || !/^[A-Za-z0-9-]{8,64}$/.test(repoId)) return err(401, "malformed model token");
  const env = c.env;
  // Check the token before reading a body of up to 32 MB, and only wake a project that exists. Wrong
  // tokens count against the sign-in limit per address.
  const known = await env.DB.prepare("SELECT 1 FROM repos WHERE id = ?").bind(repoId).first();
  const project = known ? env.PROJECT.get(env.PROJECT.idFromName(repoId)) : null;
  if (!project || !(await project.modelTokenLive(token))) {
    if (await overLimit(env, [["RL_AUTH", `ip:${c.req.header("cf-connecting-ip") ?? "unknown"}`]])) return err(429, "too many requests with invalid model tokens");
    return err(401, "this model token isn't valid: its task run has ended");
  }
  // Read and prepare the request first: its estimate is booked against the run before it goes upstream.
  let body: string | undefined;
  let prepared: ReturnType<typeof prepareRequest> = { body: "", estimate: null };
  if (!["GET", "HEAD"].includes(c.req.method)) {
    if (Number(c.req.header("content-length") ?? 0) > MAX_REQUEST) return err(413, "the request is too large");
    const bytes = await readBody(c.req.raw.body, MAX_REQUEST);
    if (!bytes) return err(413, "the request is too large");
    prepared = prepareRequest(c.req.method, rest, new TextDecoder().decode(bytes), bytes.byteLength);
    body = prepared.body;
  }
  const { estimate } = prepared;
  // The leases a limit on requests at once gave this request (inflight.ts), freed once it is settled.
  const slots: string[] = [];
  const free = () => {
    for (const id of slots.splice(0)) c.executionCtx.waitUntil(freeSlot(env, id).catch((e) => console.error("freeing a model request's slot failed", e)));
  };
  // Everything from here, the provider's answer and its settlement included, runs under one waitUntil registered
  // now: if the sandbox drops its connection while the Worker waits, the request is still settled and its slots freed.
  let settling: Promise<unknown> = Promise.resolve();
  const work = (async (): Promise<Response> => {
    const run = await project.modelAuth(token, { provider, estimate, reviewRefuse: prepared.reviewRefuse, model: prepared.model, routing: prepared.routing });
    if (!run) return err(401, "this model token isn't valid: its task run has ended");
    if ("limit" in run) return err(429, run.limit);
    if ("refuse" in run) return err(403, run.refuse);
    if ("busy" in run) {
      const res = err(429, run.busy);
      res.headers.set("retry-after", "60");
      return res;
    }
    // Runs held to their bookings (reviews, coordinators and the tasks they start, and runs on an organization's key, whose
    // monthly allowance depends on them) send the capped, tool-stripped body their booking assumes.
    const limited = run.bounded || run.orgKey;
    if (limited && prepared.reviewBody) body = prepared.reviewBody;
    else if (prepared.jailBody) body = prepared.jailBody;
    // A booked request that never reaches the provider, or that it answers with an error, costs nothing.
    // `spend` is the booking against the person's monthly allowance on an organization's key, once made.
    let spend: { org: string; tokens: number; month: string } | null = null;
    const refund = (unsent = true) => {
      if (estimate || unsent) c.executionCtx.waitUntil(project.chargeUsage(run.task, run.run, NO_USAGE, estimate, unsent).catch((e) => console.error("refunding a model request failed", e)));
      if (spend) c.executionCtx.waitUntil(settleSpend(env, spend.org, run.personId, -spend.tokens, spend.month).catch((e) => console.error("refunding an organization's allowance failed", e)));
      free();
    };
    const busy = (why: string) => {
      refund();
      const res = err(429, why);
      res.headers.set("retry-after", "5");
      return res;
    };
    // A stored response can't be read back on these runs: on an organization's key it could be anyone's in that account.
    if (limited && c.req.method === "GET" && rest.startsWith("/v1/responses")) {
      refund();
      return err(403, `reading stored responses isn't available to agent reviews, runs with a token budget and runs on an organization's key`);
    }
    // A run held to a budget has at most MAX_IN_FLIGHT generating requests at once.
    if (run.bounded && estimate) {
      const slot = await takeSlot(env, `run:${run.repoId}:${run.task}:${run.run}`);
      if (!slot) return busy(`this run already has ${MAX_IN_FLIGHT} model requests on their way; try again when one is answered`);
      slots.push(slot);
    }
    const stop = (why: string) => c.executionCtx.waitUntil(project.stop(run.task, "Diffinery", `Stopped: ${why}.`).then(() => undefined, () => undefined));
    // The person must still be allowed to run the task, on every request; otherwise the task stops.
    const dir = new Directory(env);
    const [repo, agent] = await Promise.all([dir.repoById(run.repoId), dir.account(run.agentId)]);
    if (!repo || !agent || !(await taskPersonAllowed(dir, run.personId, agent, repo))) {
      refund();
      stop("the person who started the task can no longer run it");
      return err(403, "the person who started this task can no longer run it");
    }
    // Whoever pays must still be allowed to, on every request and uncached (phase 5b): a member removed from the
    // organization, a repository transferred out of it, or a policy or key changed applies at the next request.
    const payer = await proxyPayer(env, dir, { repo, personId: run.personId, keyOwner: run.keyOwner, provider });
    if ("refuse" in payer) {
      refund();
      stop(payer.refuse);
      return err(403, payer.refuse);
    }
    if (payer.org) {
      // Under an allowance, a person has at most MAX_IN_FLIGHT generating requests at once on the organization's keys,
      // across all their runs: what an image or PDF bills isn't in the booking, so this bounds how far they can go past it.
      if (payer.org.cap !== null && estimate) {
        const slot = await takeSlot(env, `org:${payer.org.id}:${run.personId}`);
        if (!slot) return busy(`${MAX_IN_FLIGHT} of your model requests on ${payer.org.login}'s keys are already on their way; try again when one is answered`);
        slots.push(slot);
      }
      const tokens = estimate ? weighted(estimate) : 0;
      const month = spendMonth();
      if (!(await bookSpend(env, payer.org.id, run.personId, tokens, payer.org.cap))) {
        const why = `this month's allowance of ${payer.org.cap!.toLocaleString("en-US")} tokens per person on ${payer.org.login}'s keys is used up`;
        refund();
        stop(why);
        return err(403, why);
      }
      spend = { org: payer.org.id, tokens, month };
    }
    // Decrypted here, for this request only.
    const key = await new ModelKeys(env).reveal(run.keyOwner, provider);
    if (!key) {
      refund();
      return err(403, payer.org ? `${payer.org.login} has no ${PROVIDERS[provider].name} key any more` : `no ${PROVIDERS[provider].name} key in Settings → Model access`);
    }
    const headers = new Headers();
    // On an organization's key, the run doesn't choose the organization or project within the provider's account.
    for (const [k, v] of c.req.raw.headers) if (!DROP.has(k.toLowerCase()) && !ATTRIBUTION.test(k) && !(payer.org && ACCOUNT_SCOPE.test(k))) headers.set(k, v);
    if (provider === "anthropic") headers.set("x-api-key", key);
    else headers.set("authorization", `Bearer ${key}`);
    if (provider === "openrouter") {
      // OpenRouter's app attribution headers: Diffinery, not whatever the sandbox claims.
      headers.set("http-referer", env.PUBLIC_URL);
      headers.set("x-title", "Diffinery");
    }
    const base = (provider === "anthropic" ? env.MODEL_UPSTREAM_ANTHROPIC : provider === "openai" ? env.MODEL_UPSTREAM_OPENAI : env.MODEL_UPSTREAM_OPENROUTER) || UPSTREAM[provider];
    // If the provider can't be reached, the booking stays: it may have started the answer.
    const res = await fetch(`${base}${rest}${url.search}`, { method: c.req.method, headers, body, redirect: "manual" });
    const out = new Headers(res.headers);
    out.delete("set-cookie");
    if (!res.body || !res.ok) {
      refund(false);
      return new Response(res.body, { status: res.status, headers: out });
    }
    if (!estimate) {
      free();
      return new Response(res.body, { status: res.status, headers: out });
    }
    // Settle the booking to the tokens the provider reports, read from a copy of the response as it streams back.
    // An answer that reports none, or with a part too large to read for usage, is charged its estimate, or on a run
    // held to its bookings unreadCharge; one whose reading fails is never settled, and so stays charged its estimate.
    const [agentCopy, meter] = res.body.tee();
    const booked = spend;
    const sent = body === undefined ? 0 : new TextEncoder().encode(body).byteLength;
    settling =
      meterUsage(meter, res.headers.get("content-type") ?? "")
        .then(async ({ usage, unreadable }) => {
          const u = limited && (unreadable || !usage) ? unreadCharge(estimate, sent) : (usage ?? estimate);
          await project.chargeUsage(run.task, run.run, u, estimate);
          if (booked) await settleSpend(env, booked.org, run.personId, weighted(u) - booked.tokens, booked.month);
        })
        .catch((e) => console.error("reading model usage failed", e))
        .finally(free);
    return new Response(agentCopy, { status: res.status, headers: out });
  })().catch((e) => {
    free();
    throw e;
  });
  c.executionCtx.waitUntil(work.then(() => settling, () => undefined));
  return work;
}
