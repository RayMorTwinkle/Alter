#!/bin/sh
# Alter node installer for macOS and Linux. The web app's "add computer" command sets ALTER_SERVER, ALTER_TOKEN and ALTER_NAME.
set -eu
server=${ALTER_SERVER:-}; token=${ALTER_TOKEN:-}; name=${ALTER_NAME:-}
[ -n "$server" ] && [ -n "$token" ] || { echo "請在 Alter 網頁「我的電腦 → 添加電腦」複製完整命令再運行。" >&2; exit 1; }

find_node() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' || return 1
  command -v node
}

echo "[1/5] 檢查 Node.js"
if ! node=$(find_node); then
  if command -v brew >/dev/null 2>&1; then
    echo "      沒有找到合適的 Node.js，用 Homebrew 安裝"
    brew install node
    node=$(find_node) || { echo "Node.js 裝好了但還找不到，請重開終端再運行一次。" >&2; exit 1; }
  else
    echo "需要 Node.js 22.13 或更新版本。請到 https://nodejs.org 安裝 LTS 版後重新運行這條命令。" >&2; exit 1
  fi
fi

echo "[2/5] 下載節點"
dir="${XDG_DATA_HOME:-$HOME/.local/share}/alter-node"
mkdir -p "$dir"
cli="$dir/alter-node.mjs"
pkill -f "alter-node.mjs run" 2>/dev/null || true
curl -fsSL "$server/node/alter-node.mjs" -o "$cli"

echo "[3/5] 配對"
printf "      允許 Alter 在哪個目錄裡工作？直接回車表示整個用戶目錄 %s: " "$HOME"
root=""
read -r root </dev/tty || true
[ -n "$root" ] || root=$HOME
if [ -n "$name" ]; then "$node" "$cli" pair --server "$server" --token "$token" --root "$root" --name "$name"
else "$node" "$cli" pair --server "$server" --token "$token" --root "$root"; fi

echo "[4/5] 設為登入後自動運行"
"$node" "$cli" install-service

echo "[5/5] 啟動"
if [ "$(uname)" = Darwin ]; then
  plist="$HOME/Library/LaunchAgents/org.alter.node.plist"
  launchctl bootout "gui/$(id -u)/org.alter.node" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
else
  systemctl --user daemon-reload
  systemctl --user restart alter-node.service
fi
sleep 5
"$node" "$cli" status
echo
echo "完成。回到 Alter 網頁的「我的電腦」，這台電腦應該顯示在線。以後開機登入會自動運行，不用再管它。"
