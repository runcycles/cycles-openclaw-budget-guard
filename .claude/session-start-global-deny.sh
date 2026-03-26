#!/bin/bash
# Session start hook: ensure global Claude Code deny rules and git proxy config
#
# 1. Writes MCP deny rules to ~/.claude/settings.json so mcp__github__
#    file-mutation tools are blocked globally (even in cross-repo sessions).
# 2. Fixes git remote URLs to use the local git proxy when available,
#    so native git push works instead of falling back to MCP tools.

set -e

# --- Part 1: Global MCP deny rules ---

GLOBAL_SETTINGS="$HOME/.claude/settings.json"

if ! [ -f "$GLOBAL_SETTINGS" ] || ! grep -q "mcp__github__push_files" "$GLOBAL_SETTINGS" 2>/dev/null; then
  mkdir -p "$HOME/.claude"

  if [ -f "$GLOBAL_SETTINGS" ]; then
    TMP_SETTINGS=$(mktemp)
    if command -v python3 &>/dev/null; then
      python3 -c "
import json
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
fi

# --- Part 2: Fix git remote URLs to use local proxy ---
# Some sessions clone repos via github.com directly, which lacks push credentials.
# If the local git proxy is running, rewrite remote URLs to use it.

# Detect local git proxy: look for the proxy in any sibling repo's remote URL
PROXY_BASE=""
for dir in /home/user/*/; do
  if [ -d "$dir/.git" ]; then
    url=$(git -C "$dir" remote get-url origin 2>/dev/null || true)
    if echo "$url" | grep -q '127.0.0.1.*local_proxy'; then
      # Extract base URL: http://local_proxy@127.0.0.1:PORT/git
      PROXY_BASE=$(echo "$url" | sed 's|\(http://local_proxy@127\.0\.0\.1:[0-9]*/git\)/.*|\1|')
      break
    fi
  fi
done

if [ -n "$PROXY_BASE" ]; then
  # Fix any repos with github.com remote URLs
  for dir in /home/user/*/; do
    if [ -d "$dir/.git" ]; then
      url=$(git -C "$dir" remote get-url origin 2>/dev/null || true)
      # Match github.com URLs (SSH or HTTPS) and rewrite to local proxy
      if echo "$url" | grep -qE '(git@github\.com:|https?://github\.com/)'; then
        # Extract org/repo from the URL
        repo_path=$(echo "$url" | sed -E 's|.*github\.com[:/](.*)\.git$|\1|; s|.*github\.com[:/](.*)$|\1|')
        if [ -n "$repo_path" ]; then
          new_url="${PROXY_BASE}/${repo_path}"
          git -C "$dir" remote set-url origin "$new_url" 2>/dev/null || true
        fi
      fi
    fi
  done
fi
