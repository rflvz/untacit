#!/bin/sh
# untacit — Claude Code SessionStart hook: graph context digest.
#
# Emits a compact digest of the untacit graph (stats, open conflicts, recent
# drift) so the agent starts the session already knowing the business-logic
# landscape. Output goes to stdout, which Claude Code adds to the session
# context.
#
# Configure via environment:
#   UNTACIT_GRAPH  path to the graph repo (unset → this hook is a silent no-op)
#   UNTACIT_BIN    untacit executable (default: "untacit" on PATH)
#
# No ANSI escapes: the CLI's colors (picocolors) auto-disable without a TTY,
# so hook output is guaranteed plain text.

# No graph configured → nothing to say. Exit 0 so the session starts normally.
[ -n "${UNTACIT_GRAPH:-}" ] || exit 0

UNTACIT="${UNTACIT_BIN:-untacit}"
command -v "$UNTACIT" >/dev/null 2>&1 || exit 0

echo "untacit graph digest ($UNTACIT_GRAPH):"

"$UNTACIT" stats --graph "$UNTACIT_GRAPH"

# Exit-code convention: 0 ok, 1 error, 2 = findings. `conflicts` exits 2 when
# there ARE open conflicts — exactly the case we want printed — so `|| true`
# keeps that from aborting the hook.
"$UNTACIT" conflicts --graph "$UNTACIT_GRAPH" || true

# Drift introduced by the latest committed run (every import commits, so the
# working tree is clean by construction and a ref-less diff would always be
# empty). Needs at least two commits; errors are irrelevant here.
"$UNTACIT" diff HEAD~1 HEAD --graph "$UNTACIT_GRAPH" 2>/dev/null || true

exit 0
