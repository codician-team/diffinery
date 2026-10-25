import { describe, expect, it } from "vitest";
import { COMPACT_MAX_OUTPUT, DEFAULT_MAX_OUTPUT, MAX_OUTPUT_ESTIMATE, formatCost, formatTokens, meterUsage, pinRefusal, prepareRequest, readBody, readUsage, remoteInput, reportedUsage, runUsage, totalUsage, unreadCharge, usageJson, usageOf, weighted } from "../../src/agentic/usage.js";

const stream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });

describe("usageOf", () => {
  it("reads Anthropic, OpenAI Responses and Chat Completions usage", () => {
    expect(usageOf({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } })).toEqual({ input: 10, output: 5, cacheRead: 100, cacheWrite: 20 });
    expect(usageOf({ type: "message_start", message: { usage: { input_tokens: 7, output_tokens: 1 } } })).toEqual({ input: 7, output: 1, cacheRead: 0, cacheWrite: 0 });
    expect(usageOf({ type: "response.completed", response: { usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 100 }, output_tokens: 9 } } })).toEqual({ input: 20, output: 9, cacheRead: 100, cacheWrite: 0 });
    expect(usageOf({ usage: { prompt_tokens: 50, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 40 } } })).toEqual({ input: 10, output: 4, cacheRead: 40, cacheWrite: 0 });
    expect(usageOf({ type: "ping" })).toBeNull();
    expect(usageOf({ usage: { input_tokens: -3, output_tokens: "9" } })).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
  it("weighs cache reads as a tenth", () => {
    expect(weighted({ input: 10, output: 5, cacheRead: 101, cacheWrite: 20 })).toBe(10 + 5 + 20 + 11);
    expect(formatTokens(2_000_000)).toBe("2M");
    expect(formatTokens(120_000)).toBe("120k");
    expect(formatTokens(950)).toBe("950");
  });
});

describe("readUsage", () => {
  it("adds up an Anthropic stream's running totals, split across chunks", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1000,"cache_read_input_tokens":5000,"output_tokens":1}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\nevent: message_delta\nda',
      'ta: {"type":"message_delta","usage":{"output_tokens":300}}\n\nevent: message_stop\ndata: {"type":"message_stop"}',
    ];
    expect(await readUsage(stream(sse), "text/event-stream; charset=utf-8")).toEqual({ input: 1000, output: 300, cacheRead: 5000, cacheWrite: 0 });
  });
  it("reads an OpenAI Responses stream and a plain JSON answer", async () => {
    const sse = ['data: {"type":"response.created","response":{}}\n\n', 'data: {"type":"response.completed","response":{"usage":{"input_tokens":80,"input_tokens_details":{"cached_tokens":0},"output_tokens":12}}}\n\n'];
    expect(await readUsage(stream(sse), "text/event-stream")).toEqual({ input: 80, output: 12, cacheRead: 0, cacheWrite: 0 });
    expect(await readUsage(stream(['{"id":"x","usage":{"prompt_tokens":3,', '"completion_tokens":2}}']), "application/json")).toEqual({ input: 3, output: 2, cacheRead: 0, cacheWrite: 0 });
    expect(await readUsage(stream(["not json"]), "application/json")).toBeNull();
    expect(await readUsage(stream(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"]), "text/event-stream")).toBeNull();
  });
  it("drops an SSE line too long to be a usage event, and still reads the rest", async () => {
    const huge = "data: " + "x".repeat(1100 * 1024);
    expect(await readUsage(stream([huge.slice(0, 600_000), huge.slice(600_000), '\ndata: {"usage":{"input_tokens":4,"output_tokens":2}}\n\n']), "text/event-stream")).toEqual({ input: 4, output: 2, cacheRead: 0, cacheWrite: 0 });
  });
  it("says when part of an answer was too large to read for usage", async () => {
    // A streamed Responses answer whose response.completed (the whole answer, with its usage) is over a megabyte.
    const completed = 'data: {"type":"response.completed","response":{"output":"' + "x".repeat(1100 * 1024) + '","usage":{"input_tokens":300000,"output_tokens":9}}}';
    const chunks = ['data: {"type":"response.created","response":{}}\n\n', completed.slice(0, 700_000), completed.slice(700_000, 1_400_000), completed.slice(1_400_000) + "\n\n"];
    expect(await meterUsage(stream(chunks), "text/event-stream")).toEqual({ usage: null, unreadable: true });
    // The tail of the dropped line isn't read as a line of its own.
    expect(await meterUsage(stream([completed.slice(0, 1_100_000), 'x"}}\ndata: {"usage":{"input_tokens":1,"output_tokens":1}}\n']), "text/event-stream")).toEqual({ usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, unreadable: true });
    expect(await meterUsage(stream(['data: {"usage":{"input_tokens":4,"output_tokens":2}}\n']), "text/event-stream")).toEqual({ usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 }, unreadable: false });
    // Such an answer is charged a token per byte sent, plus its output cap.
    expect(unreadCharge({ input: 100, output: 16, cacheRead: 0, cacheWrite: 0 }, 300)).toEqual({ input: 300, output: 16, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("prepareRequest", () => {
  const prep = (method: string, path: string, body: string) => prepareRequest(method, path, body, new TextEncoder().encode(body).length);
  it("estimates the most an answer may cost: a token per 3 bytes plus the output it allows", () => {
    const body = JSON.stringify({ model: "m", max_tokens: 1000, messages: [{ role: "user", content: "é".repeat(300) }] });
    expect(prep("POST", "/v1/messages", body)).toEqual({ body, reviewBody: body, model: "m", estimate: { input: Math.ceil((body.length + 300) / 3), output: 1000, cacheRead: 0, cacheWrite: 0 } });
    expect(prep("POST", "/v1/responses", '{"max_output_tokens":50}').estimate?.output).toBe(50);
    expect(prep("POST", "/v1/chat/completions", '{"max_completion_tokens":70}').estimate?.output).toBe(70);
    expect(prep("POST", "/v1/messages", '{"model":"m"}').estimate?.output).toBe(DEFAULT_MAX_OUTPUT);
    expect(prep("POST", "/v1/messages", "not json").estimate).toEqual({ input: 3, output: DEFAULT_MAX_OUTPUT, cacheRead: 0, cacheWrite: 0 });
    // Each endpoint's own cap fields only; Chat Completions takes either.
    expect(prep("POST", "/v1/messages", '{"max_output_tokens":50}').estimate?.output).toBe(DEFAULT_MAX_OUTPUT);
    expect(prep("POST", "/v1/responses", '{"max_tokens":50}').estimate?.output).toBe(DEFAULT_MAX_OUTPUT);
    expect(prep("POST", "/v1/chat/completions", '{"max_tokens":60}').estimate?.output).toBe(60);
    expect(prep("POST", "/v1/completions", '{"prompt":"x","max_tokens":80}').estimate?.output).toBe(80);
    // A compaction can't be capped: it books the most a model emits.
    expect(prep("POST", "/v1/responses/compact", '{"input":[],"max_output_tokens":5}').estimate?.output).toBe(COMPACT_MAX_OUTPUT);
    expect(prep("POST", "/v1/responses/compact", '{"input":[]}').reviewBody).toBe('{"input":[]}');
    // Requests that generate nothing are never estimated.
    expect(prep("POST", "/v1/messages/count_tokens", "{}").estimate).toBeNull();
    expect(prep("GET", "/v1/models", "").estimate).toBeNull();
  });
  it("asks streamed Chat Completions for usage", () => {
    const p = prep("POST", "/v1/chat/completions", '{"model":"m","stream":true,"stream_options":{"include_usage":false,"x":1}}');
    expect(JSON.parse(p.body).stream_options).toEqual({ include_usage: true, x: 1 });
    expect(JSON.parse(prep("POST", "/v1/chat/completions", '{"stream":true}').body).stream_options).toEqual({ include_usage: true });
    const unchanged = '{"stream":false}';
    expect(prep("POST", "/v1/chat/completions", unchanged).body).toBe(unchanged);
  });
  it("names what a review may not send: background responses and context stored at the provider", () => {
    expect(prep("POST", "/v1/responses", '{"background":true}').reviewRefuse).toMatch(/background/);
    expect(prep("POST", "/v1/responses", '{"previous_response_id":"resp_1","input":"x"}').reviewRefuse).toMatch(/^previous_response_id/);
    expect(prep("POST", "/v1/responses/compact", '{"conversation":"conv_1"}').reviewRefuse).toMatch(/^conversation/);
    expect(prep("POST", "/v1/responses", '{"prompt":{"id":"pmpt_1"}}').reviewRefuse).toMatch(/^prompt/);
    expect(prep("POST", "/v1/responses", '{"previous_response_id":null,"input":"x"}').reviewRefuse).toBeUndefined();
    expect(prep("POST", "/v1/messages", '{"prompt":"x","max_tokens":5}').reviewRefuse).toBeUndefined();
    expect(prep("POST", "/v1/chat/completions", '{"n":128,"max_completion_tokens":16000}').reviewRefuse).toMatch(/\(n\)/);
    expect(prep("POST", "/v1/chat/completions", '{"n":"2"}').reviewRefuse).toMatch(/\(n\)/);
    expect(prep("POST", "/v1/chat/completions", '{"n":1,"max_completion_tokens":5}').reviewRefuse).toBeUndefined();
  });
  it("books the largest of a request's caps, and a review sends every cap as the one booked", () => {
    const p = prep("POST", "/v1/chat/completions", '{"max_completion_tokens":1,"max_tokens":100000}');
    expect(p.estimate?.output).toBe(100_000);
    expect(JSON.parse(p.reviewBody!)).toEqual({ max_completion_tokens: 100_000, max_tokens: 100_000 });
    expect(JSON.parse(prep("POST", "/v1/chat/completions", '{"max_completion_tokens":7,"max_tokens":7}').reviewBody!)).toEqual({ max_completion_tokens: 7, max_tokens: 7 });
  });
  it("pins a review's or a pinned run's model and routing", () => {
    const req = (o: object) => prep("POST", "/v1/chat/completions", JSON.stringify({ max_tokens: 5, ...o }));
    const pinned = { review: false, model: "anthropic/claude-sonnet-4.5" };
    expect(pinRefusal(req({ model: "anthropic/claude-sonnet-4.5" }), pinned)).toBeUndefined();
    expect(pinRefusal(req({ model: "openai/o1-pro" }), pinned)).toMatch(/runs on anthropic\/claude-sonnet-4\.5, not openai\/o1-pro/);
    expect(pinRefusal(req({}), pinned)).toMatch(/runs on anthropic\/claude-sonnet-4\.5$/);
    for (const k of ["models", "route", "provider", "plugins", "web_search_options", "speed", "best_of"]) {
      expect(req({ model: "anthropic/claude-sonnet-4.5", [k]: k === "models" ? ["x/y"] : {} }).routing).toBe(k);
      expect(pinRefusal(req({ model: "anthropic/claude-sonnet-4.5", [k]: {} }), pinned)).toMatch(new RegExp(`^${k} isn't available to this task`));
      expect(pinRefusal(req({ model: "m", [k]: {} }), { review: true, model: null })).toMatch(new RegExp(`^${k} isn't available to agent reviews`));
    }
    // A run that isn't pinned (a custom command, or a direct provider) may choose: only reviews refuse routing.
    expect(pinRefusal(req({ model: "any/model", plugins: [] }), { review: false, model: null })).toBeUndefined();
    expect(pinRefusal(req({ model: "any/model" }), { review: true, model: null })).toBeUndefined();
    // Requests that generate nothing aren't pinned.
    expect(pinRefusal(prep("POST", "/v1/messages/count_tokens", '{"model":"other"}'), pinned)).toBeUndefined();
  });
  it("strips paid provider-side tools from a review's request, and keeps the rest", () => {
    const fn = { name: "Read", input_schema: {} };
    const a = prep("POST", "/v1/messages", JSON.stringify({ max_tokens: 9, tools: [fn, { type: "web_search_20250305", name: "web_search" }, { type: "web_fetch_20250910", name: "web_fetch" }, { type: "code_execution_20250825", name: "code_execution" }, { type: "mcp_toolset", mcp_server_name: "x" }], mcp_servers: [{ url: "https://x" }], tool_choice: { type: "auto" } }));
    expect(JSON.parse(a.reviewBody!)).toEqual({ max_tokens: 9, tools: [fn], tool_choice: { type: "auto" } });
    // Every other run drops them too (the provider would reach hosts past the jail's allowlist), caps untouched.
    expect(JSON.parse(a.jailBody!)).toEqual({ max_tokens: 9, tools: [fn], tool_choice: { type: "auto" } });
    expect(prep("POST", "/v1/messages", JSON.stringify({ max_tokens: 9, tools: [fn] })).jailBody).toBeUndefined();
    const local = { type: "local_shell" };
    const o = prep("POST", "/v1/responses", JSON.stringify({ max_output_tokens: 9, tools: [local, { type: "web_search" }, { type: "web_search_preview_2025_03_11" }, { type: "file_search" }, { type: "code_interpreter" }, { type: "image_generation" }, { type: "mcp", server_url: "https://x" }], tool_choice: { type: "web_search" } }));
    expect(JSON.parse(o.reviewBody!)).toEqual({ max_output_tokens: 9, tools: [local] });
    // An allowlist: dated variants and tool types nobody has invented yet are dropped too; client-run tools stay.
    const custom = { type: "custom", name: "grep" };
    const patch = { type: "apply_patch" };
    const f = { type: "function", name: "Read", parameters: {} };
    const d = prep("POST", "/v1/responses", JSON.stringify({ max_output_tokens: 9, tools: [f, custom, patch, { type: "web_search_2025_08_26" }, { type: "deep_research_2027_01_01" }, { type: 7 }], tool_choice: { type: "function", name: "Read" } }));
    expect(JSON.parse(d.reviewBody!)).toEqual({ max_output_tokens: 9, tools: [f, custom, patch], tool_choice: { type: "function", name: "Read" } });
    const bash = { type: "bash_20250124", name: "bash" };
    const editor = { type: "text_editor_20250728", name: "str_replace_based_edit_tool" };
    const m = prep("POST", "/v1/messages", JSON.stringify({ max_tokens: 9, tools: [bash, editor, { type: "memory_20250818", name: "memory" }, { type: "web_search_20260101", name: "web_search" }, { type: "tool_search_tool_regex_20251119", name: "tool_search" }], tool_choice: { type: "tool", name: "web_search" } }));
    expect(JSON.parse(m.reviewBody!)).toEqual({ max_tokens: 9, tools: [bash, editor, { type: "memory_20250818", name: "memory" }] });
    const cf = { type: "function", function: { name: "Read", parameters: {} } };
    const c = prep("POST", "/v1/chat/completions", JSON.stringify({ max_tokens: 9, tools: [cf, { type: "web_search" }], tool_choice: { type: "function", function: { name: "Read" } } }));
    expect(JSON.parse(c.reviewBody!)).toEqual({ max_tokens: 9, tools: [cf], tool_choice: { type: "function", function: { name: "Read" } } });
    // With no tools left, neither tools nor a tool choice is sent.
    expect(JSON.parse(prep("POST", "/v1/responses", JSON.stringify({ max_output_tokens: 9, tools: [{ type: "web_search" }], tool_choice: "required" })).reviewBody!)).toEqual({ max_output_tokens: 9 });
    // Nothing to strip and nothing to cap: the request goes as it is.
    expect(JSON.parse(prep("POST", "/v1/messages", JSON.stringify({ max_tokens: 9, tools: [fn] })).reviewBody!)).toEqual({ max_tokens: 9, tools: [fn] });
    // Ordinary tasks keep their tools: only the review body changes.
    expect(JSON.parse(a.body).tools).toHaveLength(5);
  });
  it("gives reviews a body capped at the estimate's output when the request sets no cap", () => {
    expect(JSON.parse(prep("POST", "/v1/responses", '{"input":"x"}').reviewBody!)).toEqual({ input: "x", max_output_tokens: DEFAULT_MAX_OUTPUT });
    expect(JSON.parse(prep("POST", "/v1/messages", '{"messages":[]}').reviewBody!)).toEqual({ messages: [], max_tokens: DEFAULT_MAX_OUTPUT });
    const streamed = JSON.parse(prep("POST", "/v1/chat/completions", '{"stream":true}').reviewBody!);
    expect(streamed).toEqual({ stream: true, stream_options: { include_usage: true }, max_completion_tokens: DEFAULT_MAX_OUTPUT });
    // A request that caps its output, any way the endpoint takes it, is sent as it is.
    // Written out again even when nothing changes, so a repeated key reaches the provider once, as it was read.
    expect(prep("POST", "/v1/chat/completions", '{"max_tokens":9}').reviewBody).toBe('{"max_tokens":9}');
    expect(prep("POST", "/v1/responses", '{"max_output_tokens":9,"model":"a","model":"b"}').reviewBody).toBe('{"max_output_tokens":9,"model":"b"}');
    expect(prep("POST", "/v1/messages/count_tokens", "{}").reviewBody).toBeUndefined();
    expect(JSON.parse(prep("POST", "/v1/completions", '{"prompt":"x"}').reviewBody!)).toEqual({ prompt: "x", max_tokens: DEFAULT_MAX_OUTPUT });
    // OpenRouter's text completions take a prompt, which isn't stored context there.
    expect(prep("POST", "/v1/completions", '{"prompt":"x","max_tokens":5}').reviewRefuse).toBeUndefined();
  });
  it("books and sends at most MAX_OUTPUT_ESTIMATE of output, whatever cap a request asks for (phase 5b)", () => {
    const huge = prep("POST", "/v1/messages", '{"max_tokens":1e300,"messages":[]}');
    expect(huge.estimate?.output).toBe(MAX_OUTPUT_ESTIMATE);
    expect(JSON.parse(huge.reviewBody!).max_tokens).toBe(MAX_OUTPUT_ESTIMATE);
    expect(prep("POST", "/v1/responses", '{"max_output_tokens":1e309}').estimate?.output).toBe(DEFAULT_MAX_OUTPUT);
  });
  it("refuses input a request doesn't carry, which its booking can't see (phase 5b)", () => {
    const refuse = (path: string, x: unknown) => prep("POST", path, JSON.stringify(x)).reviewRefuse;
    const msg = (content: unknown) => ({ max_tokens: 16, messages: [{ role: "user", content }] });
    // Stored context: Responses item references, and Anthropic containers.
    expect(refuse("/v1/responses", { input: [{ type: "item_reference", id: "msg_1" }] })).toMatch(/^item_reference inputs aren't available to agent reviews/);
    expect(refuse("/v1/messages", { ...msg("hi"), container: "container_1" })).toMatch(/^container isn't available/);
    // Anthropic documents and images by URL or file, Responses files and images by id or URL, Chat Completions parts by URL.
    expect(refuse("/v1/messages", msg([{ type: "document", source: { type: "url", url: "https://example.com/a.pdf" } }]))).toMatch(/^inputs given by URL aren't available/);
    expect(refuse("/v1/messages", msg([{ type: "image", source: { type: "file", file_id: "file_1" } }]))).toMatch(/^inputs given by file id/);
    expect(refuse("/v1/messages", { ...msg("x"), system: [{ type: "text", text: "s" }, { type: "document", source: { type: "url", url: "https://e/x" } }] })).toMatch(/URL/);
    expect(refuse("/v1/responses", { input: [{ role: "user", content: [{ type: "input_file", file_id: "file_1" }] }] })).toMatch(/file id/);
    expect(refuse("/v1/responses", { input: [{ role: "user", content: [{ type: "input_file", file_url: "https://e/a.pdf" }] }] })).toMatch(/URL/);
    expect(refuse("/v1/responses", { input: [{ role: "user", content: [{ type: "input_image", image_url: "https://e/a.png" }] }] })).toMatch(/URL/);
    expect(refuse("/v1/chat/completions", { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://e/a.png" } }] }] })).toMatch(/URL/);
    expect(refuse("/v1/chat/completions", { messages: [{ role: "user", content: [{ type: "file", file: { filename: "a.pdf", file_data: "https://e/a.pdf" } }] }] })).toMatch(/URL/);
    // A tool result can't bring one in either, deep in the conversation.
    expect(refuse("/v1/messages", msg([{ type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: { type: "url", url: "https://e/i.png" } }] }]))).toMatch(/URL/);
    // Content sent as data is fine, and so is a URL in a tool call's own arguments (Claude Code's WebFetch).
    expect(refuse("/v1/messages", msg([{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBO" } }, { type: "document", source: { type: "text", data: "t" } }]))).toBeUndefined();
    expect(refuse("/v1/responses", { input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,iVBO" }, { type: "input_file", filename: "a.pdf", file_data: "data:application/pdf;base64,JVBE" }] }] })).toBeUndefined();
    expect(refuse("/v1/messages", { max_tokens: 9, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "WebFetch", input: { url: "https://e/x", file_id: "f" } }] }] })).toBeUndefined();
    expect(refuse("/v1/responses", { input: [{ type: "function_call", call_id: "c", name: "f", arguments: '{"image_url":"https://e"}' }] })).toBeUndefined();
    // Tools' schemas aren't input.
    expect(refuse("/v1/messages", { ...msg("x"), tools: [{ name: "fetch", input_schema: { type: "object", properties: { url: { type: "string" }, file_id: { type: "string" } } } }] })).toBeUndefined();
    expect(remoteInput({ messages: "plain text" })).toBeUndefined();
    // A call's type doesn't hide what else the object carries: only its input or arguments are skipped.
    expect(refuse("/v1/chat/completions", { messages: [{ role: "user", content: [{ type: "file", file: { type: "tool_use", file_data: "https://e/big.pdf" } }] }] })).toMatch(/URL/);
    expect(refuse("/v1/chat/completions", { messages: [{ role: "user", content: [{ type: "file", file: { type: "function_call", file_id: "file_1" } }] }] })).toMatch(/file id/);
    expect(refuse("/v1/messages", msg([{ type: "tool_use", id: "t", name: "x", input: {}, content: [{ type: "image", source: { type: "url", url: "https://e" } }] }]))).toMatch(/URL/);
  });
  it("refuses any background but false, bodies that aren't JSON objects, and :online models (phase 5b)", () => {
    for (const b of [true, "true", 1, {}]) expect(prep("POST", "/v1/responses", JSON.stringify({ background: b })).reviewRefuse).toMatch(/^background responses/);
    for (const b of [false, null]) expect(prep("POST", "/v1/responses", JSON.stringify({ background: b, input: "x" })).reviewRefuse).toBeUndefined();
    for (const body of ['{"temperature":NaN}', "[]", '"x"', ""]) expect(prep("POST", "/v1/messages", body).reviewRefuse).toMatch(/^a request whose body isn't a JSON object/);
    expect(prep("POST", "/v1/chat/completions", '{"model":"openai/gpt-4o:online","messages":[]}').reviewRefuse).toMatch(/^web search models \(:online\)/);
    expect(prep("POST", "/v1/chat/completions", '{"model":"openai/gpt-4o:online:free","messages":[]}').reviewRefuse).toMatch(/^web search models/);
    expect(prep("POST", "/v1/chat/completions", '{"model":"@preset/cheap","messages":[]}').reviewRefuse).toMatch(/^OpenRouter presets/);
    expect(prep("POST", "/v1/chat/completions", '{"model":"openai/gpt-4o@Preset/cheap","messages":[]}').reviewRefuse).toMatch(/^OpenRouter presets/);
    expect(prep("POST", "/v1/chat/completions", '{"model":"m","preset":"cheap","messages":[]}').routing).toBe("preset");
    // Requests that generate nothing aren't held to anything.
    expect(prep("POST", "/v1/messages/count_tokens", "not json").reviewRefuse).toBeUndefined();
  });
  it("strips paid provider-side tools from runs on an organization's key, as from reviews (phase 5b)", () => {
    const fn = { name: "Read", input_schema: {} };
    const p = prep("POST", "/v1/messages", JSON.stringify({ max_tokens: 9, messages: [], tools: [fn, { type: "web_fetch_20250910", name: "web_fetch" }], mcp_servers: [{ type: "url", url: "https://m" }] }));
    expect(JSON.parse(p.reviewBody!)).toEqual({ max_tokens: 9, messages: [], tools: [fn] });
    // A shell runs on the agent's side only with no environment, or a local one: OpenAI's hosted shell runs in a provider container.
    const shells = [{ type: "shell" }, { type: "shell", environment: { type: "local" } }, { type: "shell", environment: { type: "container_auto" } }];
    expect(JSON.parse(prep("POST", "/v1/responses", JSON.stringify({ max_output_tokens: 9, tools: shells })).reviewBody!).tools).toEqual(shells.slice(0, 2));
  });
  it("names runs on an organization's key among those held to their bookings", () => {
    expect(prep("POST", "/v1/responses", '{"background":true}').reviewRefuse).toBe("background responses aren't available to agent reviews, runs with a token budget and runs on an organization's key");
    const req = (x: Record<string, unknown>) => prep("POST", "/v1/chat/completions", JSON.stringify(x));
    expect(pinRefusal(req({ model: "m", models: ["a", "b"] }), { review: false, model: null, orgKey: true })).toMatch(/^models isn't available to agent reviews, runs with a token budget and runs on an organization's key/);
    expect(pinRefusal(req({ model: "m", models: ["a", "b"] }), { review: false, model: null })).toBeUndefined();
  });
});

describe("readBody", () => {
  const chunks = (parts: Uint8Array[]) => new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } });
  it("reads a body whole, and refuses one past the limit by its bytes", async () => {
    const e = new TextEncoder();
    expect(new TextDecoder().decode((await readBody(chunks([e.encode("ab"), e.encode("çd")]), 5))!)).toBe("abçd");
    expect(await readBody(chunks([e.encode("ab"), e.encode("çde")]), 5)).toBeNull();
    expect(await readBody(null, 5)).toEqual(new Uint8Array());
  });
});

describe("usage a CLI reports (phase 5a)", () => {
  it("reads Claude Code's result totals and cost, and Codex's per-turn tokens", () => {
    const result = JSON.stringify({ type: "result", subtype: "success", result: "x".repeat(50_000), total_cost_usd: 0.4123, usage: { input_tokens: 12, output_tokens: 340, cache_read_input_tokens: 9000, cache_creation_input_tokens: 800 } });
    expect(reportedUsage("claude-code", result)).toEqual({ usage: { input: 12, output: 340, cacheRead: 9000, cacheWrite: 800 }, costUsd: 0.4123, mode: "set" });
    const turn = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 55 } });
    expect(reportedUsage("codex", turn)).toEqual({ usage: { input: 200, output: 55, cacheRead: 1000, cacheWrite: 0 }, costUsd: null, mode: "add" });
  });

  it("reads nothing from other runtimes, other events, or a cost that isn't a number", () => {
    const result = JSON.stringify({ type: "result", total_cost_usd: 1, usage: { input_tokens: 1 } });
    expect(reportedUsage("custom", result)).toBeNull();
    expect(reportedUsage("codex", result)).toBeNull();
    expect(reportedUsage("claude-code", JSON.stringify({ type: "assistant", usage: { input_tokens: 1 } }))).toBeNull();
    expect(reportedUsage("claude-code", '{"type":"result", cut')).toBeNull();
    expect(reportedUsage("claude-code", JSON.stringify({ type: "result", result: "no usage" }))).toBeNull();
    expect(reportedUsage("claude-code", JSON.stringify({ type: "result", total_cost_usd: -2, usage: { input_tokens: 1 } }))!.costUsd).toBeNull();
    expect(reportedUsage("claude-code", JSON.stringify({ type: "result", total_cost_usd: "9", usage: { input_tokens: 1 } }))!.costUsd).toBeNull();
  });

  const row = { model_calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reported_input: 0, reported_output: 0, reported_cache_read: 0, reported_cache_write: 0, cost_usd: null as number | null };

  it("takes the proxy's counts when the run used it, else what the CLI reported, else none", () => {
    expect(runUsage(row)).toBeNull();
    // A run through the proxy keeps Diffinery's counts, even if its CLI also reported some.
    expect(runUsage({ ...row, model_calls: 3, input_tokens: 10, output_tokens: 5, reported_input: 999, cost_usd: 0.02 })).toEqual({ source: "proxy", requests: 3, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.02 });
    expect(runUsage({ ...row, reported_input: 7, reported_output: 2, reported_cache_read: 100 })).toEqual({ source: "runtime", requests: 0, input: 7, output: 2, cacheRead: 100, cacheWrite: 0, costUsd: null });
    expect(runUsage({ ...row, cost_usd: 0 })).toEqual({ source: "runtime", requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
  });

  it("adds runs up, with a cost only from the runs that reported one", () => {
    const a = runUsage({ ...row, model_calls: 2, input_tokens: 10, output_tokens: 1, cost_usd: 0.5 });
    const b = runUsage({ ...row, reported_input: 5, reported_output: 4 });
    expect(totalUsage([a, null, b])).toEqual({ requests: 2, input: 15, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.5 });
    expect(totalUsage([b])!.costUsd).toBeNull();
    expect(totalUsage([null])).toBeNull();
    expect(usageJson({ ...a!, costUsd: 0.123456 })).toEqual({ source: "proxy", requests: 2, input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.1235 });
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(1.416)).toBe("$1.42");
  });
});
