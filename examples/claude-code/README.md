# Claude Code hooks for untacit

Example Claude Code configuration that keeps an agent session aware of the
untacit business-logic graph while it works on a **source repo**.

## What each hook does

- **`session-start.sh`** (`SessionStart`) — when a Claude Code session opens,
  prints a digest of the graph into the session context: `untacit stats`,
  open conflicts (`untacit conflicts` — it exits with code 2 when conflicts
  exist, hence the `|| true`), and recent drift (`untacit diff`). If
  `UNTACIT_GRAPH` is unset it does nothing, silently.
- **`suggest-reextract.sh`** (`PostToolUse`, matcher `Edit|Write`) — after the
  agent edits or writes a file, if the path looks like source code
  (`.ts/.js/.py/.go/.java/.rb/.php/.cs`…), it prints a reminder with the exact
  `untacit extract code … --paths <file> --import --branch` command to
  re-extract that path on demand. It always exits 0 and never blocks the tool
  call.

## Install

1. Copy the hook scripts into the **source repo** (the repo the agent edits,
   not the graph repo) and make them executable:

   ```sh
   mkdir -p .claude/hooks
   cp examples/claude-code/session-start.sh examples/claude-code/suggest-reextract.sh .claude/hooks/
   chmod +x .claude/hooks/session-start.sh .claude/hooks/suggest-reextract.sh
   ```

2. Merge `settings.json` into the source repo's `.claude/settings.json`
   (project-wide) or into `~/.claude/settings.json` (all your projects). The
   commands reference the scripts via `$CLAUDE_PROJECT_DIR`; adjust the paths
   if you install the scripts elsewhere.

3. Point the hooks at your graph repo (and optionally at a specific binary):

   ```sh
   export UNTACIT_GRAPH=/path/to/graph-repo   # required — hooks no-op without it
   export UNTACIT_BIN=untacit                 # optional, default: untacit on PATH
   ```

## Cost warning

Neither hook ever runs an extraction. `suggest-reextract.sh` only **suggests**
the command: every re-extraction costs LLM calls, and untacit deliberately has
no file-watcher — you (or the agent, explicitly) decide when a change is worth
re-extracting. See `examples/hooks/post-merge` for the same philosophy applied
to git merges.
