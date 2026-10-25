-- Whether a web terminal was opened to run agent tasks (phase 4b): only those run one, each in a jail inside the
-- terminal's sandbox (containers/runner/src/jail.ts). Terminals opened before this run none.
ALTER TABLE agent_terminals ADD COLUMN tasks INTEGER NOT NULL DEFAULT 0;
