#!/bin/bash
# Session start hook: ensure global Claude Code deny rules exist
# In multi-repo sessions (cwd=/home/user), per-repo settings don't apply.
# This hook writes deny rules to ~/.claude/settings.json so mcp__github__
# file-mutation tools are blocked globally.

set -e

GLOBAL_SETTINGS="$HOME/.claude/settings.json"

# If global settings already has deny rules, skip
if [ -f "$GLOBAL_SETTINGS" ] && grep -q "mcp__github__push_files" "$GLOBAL_SETTINGS" 2>/dev/null; then
  exit 0
fi

mkdir -p "$HOME/.claude"

# If file exists, merge deny rules into it; otherwise create it
if [ -f "$GLOBAL_SETTINGS" ]; then
  # File exists but lacks deny rules — add them
  # Use a temp file to avoid partial writes
  TMP_SETTINGS=$(mktemp)
  if command -v python3 &>/dev/null; then
    python3 -c "
import json, sys
with open('$GLOBAL_SETTINGS') as f:
    settings = json.load(f)
perms = settings.setdefault('permissions', {})
deny = perms.get('deny', [])
needed = [
    'mcp__github__create_or_update_file',
    'mcp__github__push_files',
    'mcp__github__delete_file'
]
for rule in needed:
    if rule not in deny:
        deny.append(rule)
perms['deny'] = deny
with open('$TMP_SETTINGS', 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')
" && mv "$TMP_SETTINGS" "$GLOBAL_SETTINGS"
  else
    rm -f "$TMP_SETTINGS"
  fi
else
  # No global settings file — create one
  cat > "$GLOBAL_SETTINGS" << 'EOF'
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "deny": [
      "mcp__github__create_or_update_file",
      "mcp__github__push_files",
      "mcp__github__delete_file"
    ]
  }
}
EOF
fi
