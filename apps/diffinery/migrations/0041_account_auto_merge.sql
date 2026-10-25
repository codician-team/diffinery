-- Turn on auto-merge for the pull requests an account opens (repo/auto-merge.ts applyRule): NULL is off,
-- else the merge method ("merge", "squash", "rebase", or "default" for the branch's own). People set it
-- for themselves; an agent's owner sets it for the agent.
ALTER TABLE accounts ADD COLUMN auto_merge TEXT;
