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

# The previous version of this block only ran the merge when push_files was
# missing, which silently left the policy incomplete if push_files happened to
# exist while one of the other two rules had been removed. The python3 merge
# is idempotent (skips rules already present), so we now always run it on
# session start to guarantee all three deny rules are in place.
# Tracked org-wide at runcycles/.github#63.
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

# --- Part 2: Fix git remote URLs to use local proxy ---
# NOTE: This block intentionally rewrites the `origin` remote on EVERY sibling
# repo under /home/user/* with a github.com remote. That multi-repo scope is
# only meaningful inside Claude Code's remote sessions (which clone many repos
# and need them all on the local git proxy). To keep the default safe on
# vanilla developer machines, we gate on $http_proxy being set — the Claude
# Code remote env sets that, a vanilla dev machine does not.
# Explicit override: set CYCLES_CLAUDE_SKIP_REMOTE_REWRITE=1 to skip even when
# $http_proxy is set. Tracked org-wide at runcycles/.github#63.
if [ -z "$http_proxy" ] || [ -n "$CYCLES_CLAUDE_SKIP_REMOTE_REWRITE" ]; then
  exit 0
fi

# Some sessions clone repos via github.com directly, which lacks push credentials.
# If the local git proxy is running, rewrite remote URLs to use it.

# Detect local git proxy: look for the proxy in any sibling repo's remote URL
PROXY_BASE=""
for dir in /home/user/*/; do
  if [ -d "$dir/.git" ]; then
    url=$(git -C "$dir" remote get-url origin 2>/dev/null || true)
    if echo "$url" | grep -q 'local_proxy.*127.0.0.1'; then
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
