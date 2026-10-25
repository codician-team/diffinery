import { describe, expect, it } from "vitest";
import { TERMINAL_CLAUDE_SETTINGS, terminalCommand } from "../../src/agentic/runtimes.js";

describe("a task in a web terminal", () => {
  it("runs the agent without web tools, and Claude Code without reading the sign-ins or the git credential", () => {
    expect(terminalCommand("claude-code")).toContain('--disallowedTools "WebSearch,WebFetch"');
    expect(terminalCommand("claude-code")).toContain('--settings "$DIFFINERY_AGENT_SETTINGS"');
    expect(terminalCommand("codex")).toContain("-c web_search=disabled");
    const deny: string[] = JSON.parse(TERMINAL_CLAUDE_SETTINGS).permissions.deny;
    for (const p of ["~/.claude/**", "~/.claude.json", "~/.codex/**", "~/.config/**", "//workspace/repo/.git/config"]) {
      expect(deny).toContain(`Read(${p})`);
      expect(deny).toContain(`Edit(${p})`);
    }
  });
});
