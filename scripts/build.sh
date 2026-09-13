#!/bin/bash
# Build: compile src/ → lib/ with the dsh checkout's tsc.
# Requires DSH_CHECKOUT pointing at a dsh source checkout (auto-probe below).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# DSH_CHECKOUT 探测：环境变量 → 常见路径
CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in "/Users/tsbj/feyanggit/deepseek-harness" "$HOME/deepseek-harness" "$HOME/feyanggit/deepseek-harness" "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
  done
fi
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  echo "build: cannot locate the dsh checkout (set DSH_CHECKOUT)" >&2
  exit 1
fi

TSC="$CHECKOUT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ] && [ ! -f "$TSC.cmd" ]; then
  echo "build: tsc not found at $TSC" >&2
  exit 1
fi

link_pkg() {
  local target="$CHECKOUT/$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "node_modules/$1" "$target"
}


# .bin 链接（tsdown / rolldown 客户端打包用）
if [ -d "$CHECKOUT/node_modules/.bin" ]; then
  mkdir -p node_modules/.bin
  for bin in tsdown rolldown; do
    if [ -x "$CHECKOUT/node_modules/.bin/$bin" ] || [ -f "$CHECKOUT/node_modules/.bin/$bin" ]; then
      ln -sf "$CHECKOUT/node_modules/.bin/$bin" "node_modules/.bin/$bin"
    fi
  done
fi

echo "=== Linking build dependencies (checkout: $CHECKOUT) ==="
mkdir -p node_modules/@deepseek-ai
node -e "const fs=require('fs');fs.rmSync('node_modules/@standard-schema',{recursive:true,force:true})"
link_pkg cordis vendor/cordis
link_pkg cosmokit vendor/cosmokit
link_pkg schemastery vendor/schemastery
link_pkg @deepseek-ai/dsh-tools packages/core/tools
link_pkg @deepseek-ai/dsh-llm packages/llm/llm
link_pkg @deepseek-ai/dsh-system-prompt packages/core/system-prompt
link_pkg @deepseek-ai/dsh-host-webserver packages/host/webserver
link_pkg @deepseek-ai/dsh-agent packages/core/agent
link_pkg @deepseek-ai/dsh-client-ui-slots packages/client/ui-slots
# @types/node（编译类型；checkout 自带）
link_pkg @types/node node_modules/@types/node

# @types/react-dom（浏览器半边 createPortal 的类型；只存在于 checkout 的 apps/web，缺失则跳过）
if [ -d "$CHECKOUT/apps/web/node_modules/@types/react-dom" ] && [ ! -e node_modules/@types/react-dom ]; then
  link_pkg @types/react-dom apps/web/node_modules/@types/react-dom
fi

# ssh2（SSH 连接资源 test/exec 的运行时依赖；已声明在 package.json dependencies）
# 构建期链接：优先 profile node_modules，其次 checkout node_modules；都没有则跳过（运行时降级 TCP 探测）
if [ ! -e node_modules/ssh2 ]; then
  SSH2_SRC=""
  for candidate in "${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/ssh2" "$CHECKOUT/node_modules/ssh2" "$CHECKOUT"/node_modules/.pnpm/ssh2@*/node_modules/ssh2; do
    if [ -d "$candidate" ]; then SSH2_SRC="$candidate"; break; fi
  done
  if [ -n "$SSH2_SRC" ]; then
    node -e "
      const fs = require('fs');
      const path = require('path');
      fs.mkdirSync('node_modules', { recursive: true });
      fs.symlinkSync(path.resolve(process.argv[1]), path.resolve('node_modules/ssh2'), process.platform === 'win32' ? 'junction' : 'dir');
    " "$SSH2_SRC"
    echo "=== ssh2 linked from $SSH2_SRC ==="
  else
    echo "=== ssh2 not found (test/exec 将降级为 TCP 探测) ==="
  fi
fi

# undici（SSE 长静默 dispatcher：bodyTimeout=0 防长工具执行期间流被 300s chunk 间超时掐断）
# 已声明在 package.json dependencies；本地无网时从 checkout pnpm store 链接，都没有则跳过（运行时优雅降级默认 fetch）
if [ ! -e node_modules/undici ]; then
  UNDICI_SRC=""
  for candidate in "$CHECKOUT"/node_modules/.pnpm/undici@7*/node_modules/undici "$CHECKOUT/node_modules/undici"; do
    if [ -d "$candidate" ]; then UNDICI_SRC="$candidate"; break; fi
  done
  if [ -n "$UNDICI_SRC" ]; then
    node -e "
      const fs = require('fs');
      const path = require('path');
      fs.mkdirSync('node_modules', { recursive: true });
      fs.symlinkSync(path.resolve(process.argv[1]), path.resolve('node_modules/undici'), process.platform === 'win32' ? 'junction' : 'dir');
    " "$UNDICI_SRC"
    echo "=== undici linked from $UNDICI_SRC ==="
  else
    echo "=== undici not found (SSE 长静默段将使用 undici 默认 300s chunk 超时) ==="
  fi
fi

STD_SCHEMA=$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -iname '@standard-schema+spec@*' 2>/dev/null | head -1)
if [ -n "$STD_SCHEMA" ]; then
  node -e "
    const fs = require('fs');
    const path = require('path');
    fs.rmSync('node_modules/@standard-schema', { recursive: true, force: true });
    fs.mkdirSync('node_modules/@standard-schema', { recursive: true });
    fs.symlinkSync(path.resolve(process.argv[1]), path.resolve('node_modules/@standard-schema/spec'), process.platform === 'win32' ? 'junction' : 'dir');
  " "$STD_SCHEMA/node_modules/@standard-schema/spec"
fi

echo "=== Compiling src → lib ==="
"$TSC" -p tsconfig.json
echo "=== Build complete ==="
