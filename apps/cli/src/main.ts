import { dispatch, type Registry } from "./cli.js";
import { adminCommands, agentGroup, secretGroup, tokenGroup, variableGroup } from "./commands/admin.js";
import { authCommands, authGroup } from "./commands/auth.js";
import { issueGroup } from "./commands/issue.js";
import { migrateGroup } from "./commands/migrate.js";
import { prGroup } from "./commands/pr.js";
import { repoGroup } from "./commands/repo.js";
import { runGroup } from "./commands/run.js";
import { runnerCommand } from "./commands/runner.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { workflowGroup } from "./commands/workflow.js";
import { CliError, processIo, type Io } from "./io.js";

export const registry: Registry = {
  groups: [authGroup, repoGroup, prGroup, issueGroup, runGroup, workflowGroup, secretGroup, variableGroup, tokenGroup, agentGroup, migrateGroup],
  commands: [...authCommands, ...adminCommands, runnerCommand, upgradeCommand],
};

/** Runs the CLI and returns its exit code (never calls process.exit). */
export async function main(argv: string[], io: Io = processIo()): Promise<number> {
  try {
    return await dispatch(registry, argv, io);
  } catch (e) {
    if (e instanceof CliError) {
      io.stderr.write(`error: ${e.message}\n`);
      return e.code;
    }
    io.stderr.write(`error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    return 1;
  }
}
