import { describe, expect, it } from "vitest";
import {
  containsExpression,
  evaluate,
  evaluateIf,
  evaluateValue,
  ExpressionSyntaxError,
  interpolate,
  splitTemplate,
  type ExprContext,
  type StatusFns,
} from "../src/index.js";

const ctx: ExprContext = {
  github: {
    event_name: "push",
    ref: "refs/heads/main",
    repository: "acme/widgets",
    event: {
      commits: [
        { id: "a1", message: "fix: bug", author: { name: "Ann" } },
        { id: "b2", message: "feat: thing", author: { name: "Bob" } },
        { id: "c3", message: "chore", author: null },
      ],
      pull_request: { labels: [{ name: "bug" }, { name: "ci" }], number: 42 },
    },
  },
  env: { NODE_ENV: "production", Mixed_Case: "yes" },
  matrix: { node: 20, os: "ubuntu-latest" },
  steps: { "build-step": { outputs: { artifact: "dist.tgz" }, outcome: "success" } },
  needs: { build: { result: "success", outputs: { version: "1.2.3" } } },
  inputs: { debug: true, count: 3, name: "" },
  vars: { REGION: "eu" },
};

const ev = (e: string) => evaluate(e, ctx);

const status = (s: "success" | "failure" | "cancelled"): StatusFns => ({
  success: () => s === "success",
  failure: () => s === "failure",
  cancelled: () => s === "cancelled",
});

describe("literals", () => {
  it("parses null, booleans, numbers, strings", () => {
    expect(ev("null")).toBe(null);
    expect(ev("true")).toBe(true);
    expect(ev("false")).toBe(false);
    expect(ev("711")).toBe(711);
    expect(ev("-9.2")).toBe(-9.2);
    expect(ev("0xff")).toBe(255);
    expect(ev("-2.99e-2")).toBe(-0.0299);
    expect(ev("1e3")).toBe(1000);
    expect(ev("'Mona the Octocat'")).toBe("Mona the Octocat");
    expect(ev("'It''s open source!'")).toBe("It's open source!");
    expect(ev("''")).toBe("");
  });

  it("supports NaN and Infinity keywords", () => {
    expect(ev("NaN")).toBeNaN();
    expect(ev("Infinity")).toBe(Infinity);
  });
});

describe("property access", () => {
  it("dereferences with . and []", () => {
    expect(ev("github.event_name")).toBe("push");
    expect(ev("github['event_name']")).toBe("push");
    expect(ev("steps.build-step.outputs.artifact")).toBe("dist.tgz");
    expect(ev("steps['build-step'].outputs['artifact']")).toBe("dist.tgz");
    expect(ev("github.event.commits[1].id")).toBe("b2");
    expect(ev("github.event.commits['1'].id")).toBe("b2");
  });

  it("is case-insensitive for property and context names", () => {
    expect(ev("GITHUB.Event_Name")).toBe("push");
    expect(ev("env.mixed_case")).toBe("yes");
    expect(ev("Needs.BUILD.outputs.VERSION")).toBe("1.2.3");
  });

  it("returns null for unknown properties and contexts", () => {
    expect(ev("github.nope")).toBe(null);
    expect(ev("github.nope.deeper.still")).toBe(null);
    expect(ev("unknowncontext.x")).toBe(null);
    expect(ev("github.event.commits[99]")).toBe(null);
    expect(ev("github.event.commits[-1]")).toBe(null);
    expect(ev("github.ref.length")).toBe(null);
  });

  it("supports object filters", () => {
    expect(ev("github.event.commits.*.message")).toEqual(["fix: bug", "feat: thing", "chore"]);
    expect(ev("github.event.commits.*.author.name")).toEqual(["Ann", "Bob"]);
    expect(ev("github.event.pull_request.labels.*.name")).toEqual(["bug", "ci"]);
    expect(ev("github.event.commits[*].id")).toEqual(["a1", "b2", "c3"]);
    expect(ev("contains(github.event.pull_request.labels.*.name, 'CI')")).toBe(true);
    expect(ev("needs.*.result")).toEqual(["success"]);
    expect(evaluate("fruits.*.*", { fruits: { a: [1, 2], b: { x: 3 } } })).toEqual([1, 2, 3]);
    expect(ev("github.missing.*")).toEqual([]);
  });
});

describe("operators", () => {
  it("logical not and grouping", () => {
    expect(ev("!true")).toBe(false);
    expect(ev("!''")).toBe(true);
    expect(ev("!!github")).toBe(true);
    expect(ev("!(1 == 2)")).toBe(true);
    expect(ev("(true || false) && false")).toBe(false);
  });

  it("&& and || return operand values", () => {
    expect(ev("'a' && 'b'")).toBe("b");
    expect(ev("'' && 'b'")).toBe("");
    expect(ev("null || 'fallback'")).toBe("fallback");
    expect(ev("inputs.name || 'default-name'")).toBe("default-name");
    expect(ev("0 || null")).toBe(null);
    expect(ev("github.event_name == 'push' && 'yes' || 'no'")).toBe("yes");
    expect(ev("github.event_name == 'pr' && 'yes' || 'no'")).toBe("no");
  });

  it("precedence: comparison binds tighter than equality, && tighter than ||", () => {
    expect(ev("1 < 2 == true")).toBe(true);
    expect(ev("true || false && false")).toBe(true);
  });

  it("compares strings case-insensitively", () => {
    expect(ev("'ABC' == 'abc'")).toBe(true);
    expect(ev("'abc' != 'ABD'")).toBe(true);
    expect(ev("'a' < 'B'")).toBe(true);
    expect(ev("'b' >= 'B'")).toBe(true);
  });

  it("coerces mismatched types to numbers", () => {
    expect(ev("null == 0")).toBe(true);
    expect(ev("true == 1")).toBe(true);
    expect(ev("false == 0")).toBe(true);
    expect(ev("'' == 0")).toBe(true);
    expect(ev("'0x10' == 16")).toBe(true);
    expect(ev("' 42 ' == 42")).toBe(true);
    expect(ev("'1e2' == 100")).toBe(true);
    expect(ev("'abc' == 0")).toBe(false);
    expect(ev("'true' == true")).toBe(false); // 'true' -> NaN
    expect(ev("null == false")).toBe(true);
    expect(ev("inputs.count == '3'")).toBe(true);
    expect(ev("inputs.debug == 'true'")).toBe(false);
    expect(ev("inputs.debug == true")).toBe(true);
    expect(ev("2 > '10'")).toBe(false);
    expect(ev("'2' > '10'")).toBe(true); // string compare
  });

  it("follows NaN rules", () => {
    expect(ev("NaN == NaN")).toBe(false);
    expect(ev("NaN != NaN")).toBe(true);
    expect(ev("'abc' < 5")).toBe(false);
    expect(ev("'abc' >= 5")).toBe(false);
    expect(ev("!NaN")).toBe(true);
  });

  it("compares objects and arrays by reference", () => {
    expect(ev("github.event == github.event")).toBe(true);
    expect(ev("fromJSON('{}') == fromJSON('{}')")).toBe(false);
    expect(ev("github.event == 1")).toBe(false);
    expect(ev("github.event < github.event")).toBe(false);
  });

  it("null compares equal to null", () => {
    expect(ev("null == null")).toBe(true);
    expect(ev("github.nope == null")).toBe(true);
    expect(ev("github.nope == ''")).toBe(true); // null -> 0, '' -> 0
  });
});

describe("functions", () => {
  it("contains", () => {
    expect(ev("contains('Hello world', 'llo')")).toBe(true);
    expect(ev("contains('Hello world', 'LLO')")).toBe(true);
    expect(ev("contains('Hello world', 'xyz')")).toBe(false);
    expect(ev("contains(fromJSON('[\"push\", \"pull_request\"]'), github.event_name)")).toBe(true);
    expect(ev("contains(fromJSON('[1, 2]'), '2')")).toBe(true);
    expect(ev("contains(fromJSON('[1, 2]'), 3)")).toBe(false);
    expect(ev("contains(github.ref, 'main')")).toBe(true);
    expect(ev("CONTAINS('abc', 'b')")).toBe(true);
  });

  it("startsWith / endsWith", () => {
    expect(ev("startsWith('Hello world', 'he')")).toBe(true);
    expect(ev("startsWith(github.ref, 'refs/tags/')")).toBe(false);
    expect(ev("endsWith('Hello world', 'LD')")).toBe(true);
    expect(ev("endswith(github.ref, '/main')")).toBe(true);
    expect(ev("startsWith(123, 12)")).toBe(true);
  });

  it("format", () => {
    expect(ev("format('Hello {0} {1} {2}', 'Mona', 'the', 'Octocat')")).toBe("Hello Mona the Octocat");
    expect(ev("format('{{Hello {0} {1} {2}!}}', 'Mona', 'the', 'Octocat')")).toBe("{Hello Mona the Octocat!}");
    expect(ev("format('{0}{0}', 'x')")).toBe("xx");
    expect(ev("format('{0}-{1}', 1.5, true)")).toBe("1.5-true");
    expect(ev("format('{0}', null)")).toBe("");
    expect(() => ev("format('{1}', 'a')")).toThrow(/no matching argument/);
    expect(() => ev("format('{x}', 'a')")).toThrow(/invalid format/);
    expect(() => ev("format('a } b')")).toThrow(/invalid format/);
  });

  it("join", () => {
    expect(ev("join(github.event.pull_request.labels.*.name, ', ')")).toBe("bug, ci");
    expect(ev("join(fromJSON('[1, true, null]'))")).toBe("1,true,");
    expect(ev("join('abc', '-')")).toBe("abc");
  });

  it("toJSON pretty prints with 2 spaces", () => {
    expect(ev("toJSON(matrix)")).toBe('{\n  "node": 20,\n  "os": "ubuntu-latest"\n}');
    expect(ev("toJSON('x')")).toBe('"x"');
    expect(ev("toJSON(null)")).toBe("null");
    expect(ev("toJSON(github.nope)")).toBe("null");
  });

  it("fromJSON", () => {
    expect(ev("fromJSON('{\"a\": [1, 2]}').a[1]")).toBe(2);
    expect(ev("fromJSON('true')")).toBe(true);
    expect(ev("fromJSON('42') == 42")).toBe(true);
    expect(() => ev("fromJSON('{nope')")).toThrow(/fromJSON/);
  });

  it("hashFiles delegates to extra.hashFiles", () => {
    expect(ev("hashFiles('**/package-lock.json')")).toBe("");
    const seen: string[][] = [];
    const out = evaluate("hashFiles('**/package-lock.json', '!node_modules/**')", ctx, undefined, {
      hashFiles: (...p) => {
        seen.push(p);
        return "abc123";
      },
    });
    expect(out).toBe("abc123");
    expect(seen).toEqual([["**/package-lock.json", "!node_modules/**"]]);
  });

  it("status functions", () => {
    expect(evaluate("success()", {}, status("failure"))).toBe(false);
    expect(evaluate("failure()", {}, status("failure"))).toBe(true);
    expect(evaluate("cancelled()", {}, status("cancelled"))).toBe(true);
    expect(evaluate("always()", {}, status("cancelled"))).toBe(true);
    expect(evaluate("always()", {}, { ...status("success"), always: () => false })).toBe(false);
    expect(evaluate("success()", {})).toBe(true);
  });
});

describe("syntax errors", () => {
  const bad = [
    "",
    "github.",
    "1 ==",
    "(true",
    "'unterminated",
    "a b",
    "nosuchfn(1)",
    "contains('a')",
    "success(1)",
    "\"double\"",
    "a = b",
    "a & b",
    "github[",
  ];
  for (const expr of bad) {
    it(`throws for ${JSON.stringify(expr)}`, () => {
      expect(() => evaluate(expr, ctx)).toThrow(ExpressionSyntaxError);
    });
  }
  it("has a clear message", () => {
    expect(() => evaluate("foo(1)", {})).toThrow(/Unrecognized function 'foo'/);
    expect(() => evaluate("1 ==", {})).toThrow(/end of expression/);
  });
});

describe("interpolate", () => {
  it("replaces every expression", () => {
    expect(interpolate("node-${{ matrix.node }}-${{ matrix.os }}", ctx)).toBe("node-20-ubuntu-latest");
    expect(interpolate("no expressions", ctx)).toBe("no expressions");
    expect(interpolate("${{matrix.node}}", ctx)).toBe("20");
  });

  it("coerces values like GitHub", () => {
    expect(interpolate("[${{ github.nope }}]", ctx)).toBe("[]");
    expect(interpolate("${{ true }} ${{ false }}", ctx)).toBe("true false");
    expect(interpolate("${{ 1.50 }} ${{ 0x10 }} ${{ 1e3 }} ${{ -0 }}", ctx)).toBe("1.5 16 1000 0");
    expect(interpolate("${{ 0.1 }}", ctx)).toBe("0.1");
    expect(interpolate("${{ needs.build.outputs }}", ctx)).toBe('{\n  "version": "1.2.3"\n}');
    expect(interpolate("${{ github.event.commits.*.id }}", ctx)).toBe('[\n  "a1",\n  "b2",\n  "c3"\n]');
  });

  it("does not end an expression at }} inside a string literal", () => {
    expect(interpolate("${{ format('{{x}}={0}', 1) }}!", ctx)).toBe("{x}=1!");
    expect(interpolate("${{ 'a}}b' }}", ctx)).toBe("a}}b");
  });

  it("throws on unclosed expressions", () => {
    expect(() => interpolate("echo ${{ github.ref", ctx)).toThrow(/Unclosed expression/);
  });

  it("evaluateValue keeps types for sole expressions", () => {
    expect(evaluateValue("${{ inputs.count }}", ctx)).toBe(3);
    expect(evaluateValue("${{ fromJSON('[1,2]') }}", ctx)).toEqual([1, 2]);
    expect(evaluateValue(" v${{ inputs.count }}", ctx)).toBe(" v3");
    expect(evaluateValue(5, ctx)).toBe(5);
  });

  it("containsExpression / splitTemplate", () => {
    expect(containsExpression("a ${{ b }}")).toBe(true);
    expect(containsExpression("a ${ b }")).toBe(false);
    expect(splitTemplate("a${{ x }}b")).toEqual([
      { kind: "text", text: "a" },
      { kind: "expr", expr: "x", start: 1, end: 9 },
      { kind: "text", text: "b" },
    ]);
  });
});

describe("evaluateIf", () => {
  it("undefined means success()", () => {
    expect(evaluateIf(undefined, ctx, status("success"))).toBe(true);
    expect(evaluateIf(undefined, ctx, status("failure"))).toBe(false);
    expect(evaluateIf("", ctx, status("failure"))).toBe(false);
  });

  it("adds implicit success() when no status function is used", () => {
    expect(evaluateIf("github.event_name == 'push'", ctx, status("success"))).toBe(true);
    expect(evaluateIf("github.event_name == 'push'", ctx, status("failure"))).toBe(false);
    expect(evaluateIf("${{ github.event_name == 'push' }}", ctx, status("success"))).toBe(true);
    expect(evaluateIf("true", ctx, status("cancelled"))).toBe(false);
    expect(evaluateIf(true, ctx, status("failure"))).toBe(false);
    expect(evaluateIf(false, ctx, status("success"))).toBe(false);
  });

  it("does not add success() when a status function is present", () => {
    expect(evaluateIf("always()", ctx, status("failure"))).toBe(true);
    expect(evaluateIf("failure()", ctx, status("failure"))).toBe(true);
    expect(evaluateIf("${{ failure() && github.event_name == 'push' }}", ctx, status("failure"))).toBe(true);
    expect(evaluateIf("!cancelled()", ctx, status("failure"))).toBe(true);
    expect(evaluateIf("cancelled()", ctx, status("success"))).toBe(false);
    expect(evaluateIf("success() || failure()", ctx, status("failure"))).toBe(true);
  });

  it("uses truthiness of the result", () => {
    expect(evaluateIf("inputs.name", ctx, status("success"))).toBe(false);
    expect(evaluateIf("inputs.count", ctx, status("success"))).toBe(true);
    expect(evaluateIf("steps.build-step.outputs.artifact", ctx, status("success"))).toBe(true);
    expect(evaluateIf("github.nope", ctx, status("success"))).toBe(false);
  });

  it("treats mixed text and expressions as a (truthy) string", () => {
    expect(evaluateIf("${{ false }} == true", ctx, status("success"))).toBe(true);
  });

  it("throws on syntax errors", () => {
    expect(() => evaluateIf("github.event_name ==", ctx, status("success"))).toThrow(ExpressionSyntaxError);
  });
});
