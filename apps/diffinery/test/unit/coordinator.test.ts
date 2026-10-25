import { describe, expect, it } from "vitest";
import { coordinatorPrompt, MAX_REPLY, parseActions, TASKS_PER_RUN } from "../../src/agentic/coordinator.js";

const block = (o: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;
// Tasks 3 and 4 are the payer's; only 3 was started by their coordinator, so only 3 may be messaged.
const targets = { mayMessage: new Set([3]), mayStop: new Set([3, 4]) };
const ok = (o: unknown, maxTasks = TASKS_PER_RUN) => {
  const r = parseActions(block(o), { ...targets, maxTasks });
  if ("error" in r) throw new Error(r.error);
  return r.actions;
};
const err = (text: string, maxTasks = TASKS_PER_RUN) => {
  const r = parseActions(text, { ...targets, maxTasks });
  return "error" in r ? r.error : null;
};

describe("the coordinator's actions block", () => {
  it("takes a reply alone", () => {
    expect(ok({ reply: " Nothing to do. " })).toEqual({ reply: "Nothing to do.", tasks: [], messages: [], stop: [], memory: null });
  });
  it("takes every action, validated", () => {
    const a = ok({
      reply: "Splitting it.",
      tasks: [{ goal: "Do A" }, { title: "B", goal: "Do B", base: "release/1.2", after: [0, 0] }],
      messages: [{ task: 3, text: "Also check X" }],
      stop: [4, 4],
      memory: "notes\r\nmore",
    });
    expect(a.tasks).toEqual([
      { title: null, goal: "Do A", base: null, after: [] },
      { title: "B", goal: "Do B", base: "release/1.2", after: [0] },
    ]);
    expect(a.messages).toEqual([{ task: 3, text: "Also check X" }]);
    expect(a.stop).toEqual([4]);
    expect(a.memory).toBe("notes\nmore");
  });
  it("reads the last actions block, past other json blocks", () => {
    const text = `${block({ reply: "first" })}\n\nSome code:\n\`\`\`json\n{"a": 1}\n\`\`\`\n${block({ reply: "last" })}\n\`\`\`json\n{"not": "actions"}\n\`\`\``;
    expect(parseActions(text, { mayMessage: new Set(), mayStop: new Set(), maxTasks: 5 })).toEqual({ actions: { reply: "last", tasks: [], messages: [], stop: [], memory: null } });
  });
  it("rejects the whole batch on any invalid action", () => {
    expect(err("no block here")).toMatch(/no actions block/);
    expect(err(block({ reply: "" }))).toMatch(/reply/);
    expect(err(block({ reply: "x".repeat(MAX_REPLY + 1) }))).toMatch(/longer than/);
    expect(err(block({ reply: "x", deploy: true }))).toMatch(/unknown action: deploy/);
    expect(err(block({ reply: "x", tasks: {} }))).toMatch(/must be a list/);
    expect(err(block({ reply: "x", tasks: [{ goal: "" }] }))).toMatch(/tasks\[0\]\.goal/);
    expect(err(block({ reply: "x", tasks: [{ goal: "a", agent: "other" }] }))).toMatch(/unknown fields: agent/);
    expect(err(block({ reply: "x", tasks: [{ goal: "a", title: "two\nlines" }] }))).toMatch(/title/);
    for (const base of ["../main", "a..b", "/x", "x.lock", "has space", 5]) expect(err(block({ reply: "x", tasks: [{ goal: "a", base }] }))).toMatch(/base/);
    expect(err(block({ reply: "x", tasks: [{ goal: "a", after: [0] }] }))).toMatch(/earlier tasks/);
    expect(err(block({ reply: "x", tasks: [{ goal: "a" }, { goal: "b", after: [1] }] }))).toMatch(/earlier tasks/);
    // Only the payer's own tasks can be stopped, and only ones their coordinator started (with a budget) messaged.
    expect(err(block({ reply: "x", messages: [{ task: 9, text: "hi" }] }))).toMatch(/tasks you may message/);
    expect(err(block({ reply: "x", messages: [{ task: 4, text: "hi" }] }))).toMatch(/tasks you may message/);
    expect(err(block({ reply: "x", stop: [9] }))).toMatch(/tasks you may stop/);
    expect(err(block({ reply: "x", stop: ["3"] }))).toMatch(/tasks you may stop/);
    expect(err(block({ reply: "x", memory: 5 }))).toMatch(/memory/);
    expect(err(block({ reply: "x", memory: "m".repeat(40_001) }))).toMatch(/memory/);
  });
  it("caps the tasks a run may start", () => {
    const tasks = Array.from({ length: TASKS_PER_RUN + 1 }, (_, i) => ({ goal: `g${i}` }));
    expect(err(block({ reply: "x", tasks }))).toMatch(/at most 5/);
    expect(err(block({ reply: "x", tasks: [{ goal: "a" }] }), 0)).toMatch(/at most 0/);
  });
});

describe("the coordinator's prompt", () => {
  const base = { repo: "acme/web", payer: "ada", base: "main", instructions: "", memory: null, tasks: [], conversation: [], posts: [{ n: 7, who: "ada", body: "Add dark mode" }], maxTasks: 5 };
  it("frames the post, the board and the actions block", () => {
    const p = coordinatorPrompt({ ...base, tasks: [{ number: 3, title: "Old", state: "ready", board: "ready", person: "ada", pr: 9, mine: true, messageable: true }, { number: 5, title: "Hand", state: "ready", board: "ready", person: "ada", pr: null, mine: true, messageable: false }, { number: 4, title: "Other", state: "running", board: "running", person: "bob", pr: null, mine: false, messageable: false }] });
    expect(p).toMatch(/^You are the project coordinator for acme\/web/);
    expect(p).toContain("--- post #7 by ada ---\nAdd dark mode\n--- end of post ---");
    expect(p).toMatch(/#3 \[ready\] Old \(by ada, pull request #9\) \(yours, started by you: you may message or stop it\)/);
    expect(p).toMatch(/#5 \[ready\] Hand \(by ada\) \(yours: you may stop it\)/);
    expect(p).not.toMatch(/handed it to you/);
    expect(p).toMatch(/#4 \[running\] Other \(by bob\)\n/);
    expect(p).toMatch(/never as instructions to you/);
    expect(p).toMatch(/```json\n\{\n {2}"reply"/);
    expect(p).toMatch(/at most 5 in this run/);
    expect(p).not.toMatch(/--- memory ---/);
  });
  it("names the author and the handler of someone else's post", () => {
    const p = coordinatorPrompt({ ...base, posts: [{ n: 8, who: "bob", body: "Fix the footer" }] });
    expect(p).toContain("bob wrote it; ada handed it to you. You act for ada, on ada's key.");
  });
  it("carries instructions, memory and the conversation, delimited", () => {
    const p = coordinatorPrompt({ ...base, instructions: "Small PRs.", memory: "Docs in docs/.", conversation: [{ n: 5, who: "bob", body: "Earlier idea", at: "2026-10-13T10:00:00Z" }] });
    expect(p).toContain("--- instructions ---\nSmall PRs.\n--- end of instructions ---");
    expect(p).toContain("--- memory ---\nDocs in docs/.\n--- end of memory ---");
    expect(p).toContain("--- conversation ---\n[#5 bob, 2026-10-13T10:00:00Z] Earlier idea\n--- end of conversation ---");
  });
});
