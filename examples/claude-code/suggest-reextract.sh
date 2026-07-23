#!/bin/sh
# untacit — Claude Code PostToolUse hook (matcher: Edit|Write).
#
# After the agent edits a source file, print a NON-BLOCKING reminder that the
# untacit graph may now be stale, and how to re-extract just that path. It
# never runs the extraction itself: each re-extraction costs LLM calls, so —
# like the post-merge hook and unlike a permanent file-watcher, which v1
# deliberately does not have — re-extraction happens on demand, when a human
# (or the agent, explicitly) decides the change is worth it.
#
# Configure via environment:
#   UNTACIT_GRAPH  path to the graph repo (unset → silent no-op)
#
# Always exits 0: a suggestion must never block the agent's tool call.

[ -n "${UNTACIT_GRAPH:-}" ] || exit 0

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

cat <<EOF
untacit: $FILE changed — the business-logic graph may be stale for this path.
To re-extract it on demand (costs LLM calls; untacit has no watcher by design):
  untacit extract code <source-repo> --paths $FILE --import --graph "$UNTACIT_GRAPH" --branch
The run lands on its own branch of the graph repo, ready to review as a PR.
EOF

exit 0
