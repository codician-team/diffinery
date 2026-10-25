import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../../src/agentic/keys.js";
import { proxyAllows, proxyToken } from "../../src/agentic/proxy.js";
import { agentEnv, finalMessage, OPENROUTER_MODEL, parseRuntimeChoice, planPrompt, runPrompt, RUNTIMES, runtimeChoices, runtimeLabel, runtimeNeeds, taskBranch, taskTitle, transcriptItem, type TranscriptLine } from "../../src/agentic/runtimes.js";
import { modelRoute } from "../../src/agentic/tasks.js";
import { mayStop } from "../../src/agentic/tasks.js";
import type { TaskRow } from "../../src/agentic/ProjectDO.js";

const line = (text: string, stream: TranscriptLine["stream"] = "out", seq = 1): TranscriptLine => ({ seq, run: 1, at: "2026-10-13T08:00:00Z", stream, text });

describe("task names", () => {
  it("makes a branch and a title from the goal", () => {
    expect(taskBranch(7, "Fix the Contact sales link on the pricing page, and add a test!")).toBe("agent/7-fix-the-contact-sales-link-on-the");
    expect(taskBranch(3, "  ***  ")).toBe("agent/3");
    expect(taskBranch(12, "Düzelt: ödeme")).toBe("agent/12-d-zelt-deme");
    expect(taskTitle("First line\nmore detail")).toBe("First line");
    expect(taskTitle("x".repeat(150))).toHaveLength(98);
    expect(taskTitle("")).toBe("Agent task");
  });
});

describe("plan first prompts", () => {
  it("asks a plan run for a plan only, read-only", () => {
    const p = planPrompt({ goal: "Add caching", number: 7, by: "ayse" });
    expect(p).toContain("planning task #7");
    expect(p).toContain("read-only");
    expect(p).toContain("Goal:\nAdd caching");
    expect(p).not.toContain("previous plan");
  });
  it("gives a re-plan the plan it replaces and the asked-for changes", () => {
    const p = planPrompt({ goal: "Add caching", number: 7, by: "ayse", plan: "1. Add a cache", message: "Use the KV store" });
    expect(p).toMatch(/Your previous plan:\n--- plan ---\n1\. Add a cache\n--- end of plan ---/);
    expect(p).toContain("Changes ayse asked for:\nUse the KV store");
  });
  it("hands the build run the approved plan, also on a follow-up", () => {
    const first = runPrompt({ goal: "Add caching", number: 7, branch: "agent/7", by: "ayse", plan: "1. Add a cache" });
    expect(first).toMatch(/Goal:\nAdd caching\n\nThe plan for this goal, which ayse approved\. Follow it:\n--- plan ---\n1\. Add a cache\n--- end of plan ---$/);
    const next = runPrompt({ goal: "Add caching", number: 7, branch: "agent/7", by: "ayse", plan: "1. Add a cache", message: "Fix the test" });
    expect(next).toContain("--- plan ---\n1. Add a cache");
    expect(next.indexOf("--- plan ---")).toBeLessThan(next.indexOf("New instructions from ayse"));
    expect(runPrompt({ goal: "Add caching", number: 7, branch: "agent/7", by: "ayse" })).not.toContain("plan");
  });
  it("says a fix run's instructions come from Diffinery, not the person", () => {
    const p = runPrompt({ goal: "Add caching", number: 7, branch: "agent/7", by: "ayse", message: "Checks failed", from: "Diffinery (the pull request's checks failed)" });
    expect(p).toContain("New instructions from Diffinery (the pull request's checks failed):\nChecks failed");
    expect(p).not.toContain("New instructions from ayse");
  });
});

describe("runPrompt", () => {
  it("carries the goal, and for a follow-up the previous ending and the message", () => {
    const first = runPrompt({ goal: "Add a test", number: 4, branch: "agent/4-add-a-test", by: "ayse" });
    expect(first).toMatch(/task #4/);
    expect(first).toMatch(/Don't push/);
    expect(first.endsWith("Goal:\nAdd a test")).toBe(true);
    const next = runPrompt({ goal: "Add a test", number: 4, branch: "agent/4-add-a-test", by: "ayse", message: "Also cover the error path", previous: "Added test/foo.test.ts" });
    expect(next).toMatch(/The original goal:\nAdd a test/);
    expect(next).toMatch(/Where the previous run ended:\nAdded test\/foo.test.ts/);
    expect(next.endsWith("New instructions from ayse:\nAlso cover the error path")).toBe(true);
  });
});

describe("agentEnv", () => {
  it("points each provider at the proxy and puts only the run's token in the secret environment", () => {
    const { env, secret } = agentEnv("https://diffinery.com", ["anthropic", "openai"], "dmt_r_tok");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://diffinery.com/-/model/anthropic");
    expect(env.OPENAI_BASE_URL).toBe("https://diffinery.com/-/model/openai/v1");
    expect(secret).toEqual({ ANTHROPIC_API_KEY: "dmt_r_tok", OPENAI_API_KEY: "dmt_r_tok", CODEX_API_KEY: "dmt_r_tok" });
    expect(Object.values(env)).not.toContain("dmt_r_tok");
    expect(agentEnv("https://x", ["anthropic"], "t").secret).toEqual({ ANTHROPIC_API_KEY: "t" });
  });

  it("installs runtimes without any credential, and passes the prompt by environment", () => {
    for (const r of Object.values(RUNTIMES)) {
      expect(r.install ?? "").not.toMatch(/KEY|TOKEN/);
      if (r.id !== "custom") expect(r.command()).toContain('"$DIFFINERY_TASK_PROMPT"');
    }
    expect(RUNTIMES["claude-code"].needs).toEqual(["anthropic"]);
    expect(RUNTIMES.codex.needs).toEqual(["openai"]);
    expect(RUNTIMES.custom.command("echo hi")).toBe("echo hi");
    // Reviews run without web tools, which cost extra on the provider.
    expect(RUNTIMES["claude-code"].command(undefined, undefined, true)).toContain('--disallowedTools "WebSearch,WebFetch"');
    expect(RUNTIMES["claude-code"].command()).not.toContain("disallowedTools");
    expect(RUNTIMES.codex.command(undefined, undefined, true)).toContain("-c web_search=disabled");
    // A review's checkout is the pull request's: none of its agent configuration is loaded.
    expect(RUNTIMES["claude-code"].command(undefined, undefined, true, true)).toContain("--safe-mode");
    expect(RUNTIMES["claude-code"].command(undefined, undefined, true)).not.toContain("--safe-mode");
    expect(RUNTIMES.codex.command(undefined, undefined, true, true)).toContain("-c project_doc_max_bytes=0");
    expect(RUNTIMES.codex.command()).not.toContain("web_search");
  });
});

describe("OpenRouter", () => {
  it("points Claude Code at OpenRouter's Messages endpoint with the token as a bearer token and the model on every role", () => {
    const { env, secret } = agentEnv("https://d", ["openrouter"], "tok", { runtime: "claude-code", route: { via: "openrouter", model: "anthropic/claude-sonnet-4.5" } });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://d/-/model/openrouter");
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(secret).toEqual({ OPENROUTER_API_KEY: "tok", ANTHROPIC_AUTH_TOKEN: "tok" });
    for (const k of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL", "DIFFINERY_MODEL"]) expect(env[k]).toBe("anthropic/claude-sonnet-4.5");
    expect(Object.values(env)).not.toContain("tok");
  });
  it("gives Codex an OpenRouter model provider on the Responses API", () => {
    const { env, secret } = agentEnv("https://d", ["openrouter"], "tok", { runtime: "codex", route: { via: "openrouter", model: "openai/gpt-5" } });
    expect(env.OPENROUTER_BASE_URL).toBe("https://d/-/model/openrouter/v1");
    expect(env.DIFFINERY_MODEL).toBe("openai/gpt-5");
    expect(secret).toEqual({ OPENROUTER_API_KEY: "tok" });
    const cmd = RUNTIMES.codex.command(undefined, "openrouter");
    expect(cmd).toContain("-c model_provider=openrouter");
    expect(cmd).toContain('-c "model_providers.openrouter.base_url=$OPENROUTER_BASE_URL"');
    expect(cmd).toContain("-c model_providers.openrouter.env_key=OPENROUTER_API_KEY");
    expect(cmd).toContain("-c model_providers.openrouter.wire_api=responses");
    expect(cmd).toContain('-m "$DIFFINERY_MODEL"');
    expect(cmd.endsWith('"$DIFFINERY_TASK_PROMPT"')).toBe(true);
    expect(RUNTIMES.codex.command()).not.toContain("openrouter");
  });
  it("chooses where calls go, with a model only for OpenRouter", () => {
    expect(modelRoute("claude-code", undefined, undefined)).toEqual({ via: null, model: null });
    expect(modelRoute("claude-code", "anthropic", "")).toEqual({ via: null, model: null });
    expect(modelRoute("claude-code", "openrouter", "")).toEqual({ via: "openrouter", model: "~anthropic/claude-sonnet-latest" });
    expect(modelRoute("codex", "openrouter", " qwen/qwen3-coder:free ")).toEqual({ via: "openrouter", model: "qwen/qwen3-coder:free" });
    expect(() => modelRoute("claude-code", "openai", undefined)).toThrow(/must be anthropic or openrouter/);
    expect(() => modelRoute("custom", "openrouter", undefined)).toThrow(/leave `provider` out/);
    expect(() => modelRoute("codex", undefined, "openai/gpt-5")).toThrow(/only for OpenRouter/);
    expect(() => modelRoute("codex", "openrouter", "gpt-5; rm -rf /")).toThrow(/OpenRouter model id/);
    expect(OPENROUTER_MODEL.test("anthropic/claude-opus-4.1[1m]")).toBe(true);
    expect(OPENROUTER_MODEL.test("$(id)/x")).toBe(false);
    expect(runtimeNeeds("claude-code", "openrouter")).toEqual(["openrouter"]);
    expect(runtimeNeeds("claude-code", null)).toEqual(["anthropic"]);
    expect(runtimeLabel("codex", { via: "openrouter", model: "openai/gpt-5" })).toBe("Codex via OpenRouter (openai/gpt-5)");
    expect(runtimeLabel("codex", { via: null })).toBe("Codex");
  });
  it("offers each runtime through OpenRouter on the forms, enabled by the keys you have", () => {
    const names = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter" } as const;
    const choices = runtimeChoices(new Set(["openrouter"]), names);
    expect(choices.map((c) => [c.value, c.disabled])).toEqual([
      ["claude-code", true],
      ["claude-code+openrouter", false],
      ["codex", true],
      ["codex+openrouter", false],
      ["custom", false],
    ]);
    expect(parseRuntimeChoice("codex+openrouter")).toEqual({ runtime: "codex", provider: "openrouter" });
    expect(parseRuntimeChoice("custom")).toEqual({ runtime: "custom", provider: undefined });
  });
});

describe("transcriptItem", () => {
  it("reads Claude Code's stream-json", () => {
    expect(transcriptItem(line(JSON.stringify({ type: "system", subtype: "init", model: "claude-x", session_id: "s" })))).toEqual([{ kind: "note", body: "Claude Code started (claude-x)." }]);
    const msg = { type: "assistant", message: { content: [{ type: "text", text: "Looking at the link." }, { type: "tool_use", name: "Bash", input: { command: "grep -rn contact" } }] } };
    expect(transcriptItem(line(JSON.stringify(msg)))).toEqual([
      { kind: "text", body: "Looking at the link." },
      { kind: "tool", title: "Bash", body: "$ grep -rn contact" },
    ]);
    const result = { type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "src/a.ts:1" }], is_error: false }] } };
    expect(transcriptItem(line(JSON.stringify(result)))).toEqual([{ kind: "output", body: "src/a.ts:1" }]);
    const done = { type: "result", is_error: false, num_turns: 4, total_cost_usd: 0.1234, result: "Fixed it." };
    expect(transcriptItem(line(JSON.stringify(done)))).toEqual([{ kind: "result", title: "Done · 4 turns · $0.12", body: "Fixed it." }]);
  });

  it("reads Codex's --json", () => {
    expect(transcriptItem(line(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "All done." } })))).toEqual([{ kind: "text", body: "All done." }]);
    expect(transcriptItem(line(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm test", aggregated_output: "ok", exit_code: 1 } })))).toEqual([{ kind: "tool", title: "$ npm test", body: "ok\n(exit 1)" }]);
    expect(transcriptItem(line(JSON.stringify({ type: "item.started", item: { type: "command_execution" } })))).toEqual([]);
    expect(transcriptItem(line(JSON.stringify({ type: "turn.failed", error: { message: "quota" } })))).toEqual([{ kind: "error", body: "quota" }]);
  });

  it("shows other lines as they are", () => {
    expect(transcriptItem(line("plain output"))).toEqual([{ kind: "output", body: "plain output" }]);
    expect(transcriptItem(line("[1,2]"))).toEqual([{ kind: "output", body: "[1,2]" }]);
    expect(transcriptItem(line("boom", "err"))).toEqual([{ kind: "error", body: "boom" }]);
    expect(transcriptItem(line("Installing.", "note"))).toEqual([{ kind: "note", body: "Installing." }]);
  });

  it("finds how a run ended", () => {
    const lines = [line(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Working" }] } }), "out", 1), line(JSON.stringify({ type: "result", result: "Changed 2 files." }), "out", 2), line("Pushed.", "note", 3)];
    expect(finalMessage(lines)).toBe("Changed 2 files.");
    expect(finalMessage([line("nothing")])).toBeNull();
  });
});

describe("model proxy token", () => {
  const req = (h: Record<string, string>) => new Request("https://d/-/model/anthropic/v1/messages", { headers: h });
  it("takes the run's token from x-api-key or a bearer header, and nothing else", () => {
    expect(proxyToken(req({ "x-api-key": "dmt_r_abc" }))).toBe("dmt_r_abc");
    expect(proxyToken(req({ authorization: "Bearer dmt_r_abc" }))).toBe("dmt_r_abc");
    expect(proxyToken(req({ "x-api-key": "sk-ant-real" }))).toBeNull();
    expect(proxyToken(req({ authorization: "Bearer dfy_personal" }))).toBeNull();
    expect(proxyToken(req({}))).toBeNull();
  });
});

describe("model proxy endpoints", () => {
  it("allows only the model endpoints the runtimes use", () => {
    expect(proxyAllows("anthropic", "POST", "/v1/messages")).toBe(true);
    expect(proxyAllows("anthropic", "POST", "/v1/messages/count_tokens")).toBe(true);
    expect(proxyAllows("anthropic", "GET", "/v1/models")).toBe(true);
    expect(proxyAllows("anthropic", "GET", "/v1/models/claude-x")).toBe(true);
    expect(proxyAllows("openai", "POST", "/v1/responses")).toBe(true);
    expect(proxyAllows("openai", "GET", "/v1/responses/resp_123")).toBe(true);
    expect(proxyAllows("openai", "POST", "/v1/chat/completions")).toBe(true);
    for (const [p, m, path] of [
      ["anthropic", "GET", "/v1/files"],
      ["anthropic", "DELETE", "/v1/files/file_1"],
      ["anthropic", "POST", "/v1/messages/batches"],
      ["anthropic", "GET", "/v1/messages"],
      ["anthropic", "POST", "/v1/messages/../files"],
      ["openai", "GET", "/v1/files"],
      ["openai", "POST", "/v1/batches"],
      ["openai", "GET", "/v1/vector_stores"],
      ["openai", "POST", "/v1/assistants"],
      ["openai", "DELETE", "/v1/responses/resp_123"],
      ["openai", "GET", "/v1/responses/resp_1/input_items"],
      ["openai", "POST", "/v1/messages"],
    ] as const) expect(proxyAllows(p, m, path), `${p} ${m} ${path}`).toBe(false);
  });
});

describe("model keys", () => {
  it("checks the key's shape per provider", () => {
    expect(PROVIDERS.anthropic.pattern.test(`sk-ant-api03-${"a".repeat(40)}`)).toBe(true);
    expect(PROVIDERS.anthropic.pattern.test(`sk-proj-${"a".repeat(40)}`)).toBe(false);
    expect(PROVIDERS.openai.pattern.test(`sk-proj-${"a".repeat(40)}`)).toBe(true);
    expect(PROVIDERS.openai.pattern.test("sk-short")).toBe(false);
    expect(PROVIDERS.openai.pattern.test(`sk-${"a".repeat(30)} extra`)).toBe(false);
  });
});

describe("mayStop", () => {
  const t = { person_id: "u-ayse", agent_id: "a-bot" } as TaskRow;
  it("is the person, the agent or an admin", () => {
    expect(mayStop({ id: "u-ayse", login: "ayse", kind: "user", role: "write" }, t)).toBe(true);
    expect(mayStop({ id: "a-bot", login: "bot", kind: "agent", role: "write" }, t)).toBe(true);
    expect(mayStop({ id: "u-bob", login: "bob", kind: "user", role: "admin" }, t)).toBe(true);
    expect(mayStop({ id: "u-bob", login: "bob", kind: "user", role: "write" }, t)).toBe(false);
  });
});
