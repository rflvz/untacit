#!/bin/sh
# untacit — Claude Code PostToolUse hook (matcher: Edit|Write).
#
# After the agent edits a source file, remind it that the untacit graph may
# now be stale, and how to re-extract just that path. It never runs the
# extraction itself: each re-extraction costs LLM calls, so — like the
# post-merge hook and unlike a permanent file-watcher, which v1 deliberately
# does not have — re-extraction happens on demand, when a human (or the
# agent, explicitly) decides the change is worth it.
#
# Configure via environment:
#   UNTACIT_GRAPH  path to the graph repo (unset → silent no-op)
#   UNTACIT_BIN    untacit executable (default: "untacit" on PATH)
#
# Always exits 0: a suggestion must never block the agent's tool call.

[ -n "${UNTACIT_GRAPH:-}" ] || exit 0

UNTACIT="${UNTACIT_BIN:-untacit}"

# Claude Code delivers the hook event as JSON on stdin; we want
# .tool_input.file_path. Defensive grep/sed extraction (no jq/python/node
# dependency): grab the first "file_path":"..." value.
INPUT=$(cat 2>/dev/null) || exit 0
FILE=$(printf '%s' "$INPUT" | tr -d '\n' \
  | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

[ -n "$FILE" ] || exit 0

# Only source code is worth re-extracting business logic from.
case "$FILE" in
  *.ts|*.tsx|*.js|*.jsx|*.py|*.go|*.java|*.rb|*.php|*.cs) ;;
  *) exit 0 ;;
esac

# `extract code --paths` takes SOURCE-REPO-RELATIVE paths, but the hook's
# tool_input.file_path is absolute. CLAUDE_PROJECT_DIR (set by Claude Code
# when running hooks) is the project root — strip it to get the relative
# path the CLI expects.
ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
REL="${FILE#"$ROOT"/}"

# Plain stdout of a PostToolUse hook (exit 0) is transcript-only — the model
# never sees it. To reach the AGENT's context the hook must emit the
# hookSpecificOutput JSON envelope. (Paths containing double quotes or
# backslashes would break this hand-built JSON; that is acceptable for an
# example hook.)
cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"untacit: $REL changed — the business-logic graph may be stale for this path. To re-extract it on demand (costs LLM calls; untacit has no watcher by design): $UNTACIT extract code $ROOT --paths $REL --import --graph $UNTACIT_GRAPH --branch — the run lands on its own branch of the graph repo, ready to review as a PR."}}
EOF

exit 0
