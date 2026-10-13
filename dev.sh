#!/usr/bin/env bash
# 一键启动本地开发环境：Go 后端(:8080) + Next.js 前端(:3000) + canvas-agent(:3210)
# 用法:
#   ./dev.sh          启动（已在运行的服务自动跳过）
#   ./dev.sh stop     停止这三个端口上的服务
#   ./dev.sh status   查看状态
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/data/logs/dev"
mkdir -p "$LOG_DIR"

BACKEND_URL="http://127.0.0.1:8080/api/health"
WEB_URL="http://127.0.0.1:3000"
AGENT_URL="http://127.0.0.1:3210/config"

is_up() { curl -fsS --max-time 3 -o /dev/null "$1" 2>/dev/null; }

# 服务探活失败但端口被其他进程占用时，直接报错退出，避免盲目启动后端口冲突
fail_if_port_busy() { # $1=端口 $2=服务名
  local pids cmd
  pids="$(lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    cmd="$(ps -o comm= -p "${pids//$'\n'/,}" 2>/dev/null | head -1)"
    echo "[失败] 端口 $1 被占用 (PID: ${pids//$'\n'/ }, 进程: ${cmd:-未知})，$2 无法启动"
    echo "       可执行 ./dev.sh stop 释放端口，或手动结束该进程"
    return 1
  fi
  return 0
}

start_backend() {
  if is_up "$BACKEND_URL"; then echo "[跳过] Go 后端已在运行 (:8080)"; return; fi
  fail_if_port_busy 8080 "Go 后端" || return 1
  echo "[启动] Go 后端 (:8080) ..."
  (cd "$ROOT" && nohup go run . >"$LOG_DIR/backend.log" 2>&1 &)
}

start_web() {
  if is_up "$WEB_URL"; then echo "[跳过] Next.js 已在运行 (:3000)"; return; fi
  fail_if_port_busy 3000 "Next.js" || return 1
  if [ ! -d "$ROOT/web/node_modules" ]; then
    echo "[安装] web 依赖 (bun install) ..."
    if ! (cd "$ROOT/web" && bun install >"$LOG_DIR/web-install.log" 2>&1); then
      echo "[失败] web 依赖安装失败，见 $LOG_DIR/web-install.log"
      return 1
    fi
  fi
  echo "[启动] Next.js (:3000) ..."
  (cd "$ROOT/web" && nohup bun run dev >"$LOG_DIR/web.log" 2>&1 &)
}

start_agent() {
  if is_up "$AGENT_URL"; then echo "[跳过] canvas-agent 已在运行 (:3210)"; return; fi
  fail_if_port_busy 3210 "canvas-agent" || return 1
  if [ ! -d "$ROOT/canvas-agent/node_modules" ]; then
    echo "[安装] canvas-agent 依赖 (npm install) ..."
    if ! (cd "$ROOT/canvas-agent" && npm install --no-audit --no-fund >"$LOG_DIR/agent-install.log" 2>&1); then
      echo "[失败] canvas-agent 依赖安装失败，见 $LOG_DIR/agent-install.log"
      return 1
    fi
  fi
  echo "[启动] canvas-agent (:3210) ..."
  (cd "$ROOT/canvas-agent" && nohup node index.mjs >"$LOG_DIR/canvas-agent.log" 2>&1 &)
}

wait_up() { # $1=名称 $2=url $3=超时秒
  local name="$1" url="$2" timeout="$3" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if is_up "$url"; then echo "[就绪] $name"; return 0; fi
    sleep 2
    waited=$((waited + 2))
  done
  echo "[失败] $name 未就绪，日志见 $LOG_DIR"
  return 1
}

start_all() {
  start_backend
  start_web
  start_agent
  echo
  echo "等待服务就绪 ..."
  wait_up "Go 后端" "$BACKEND_URL" 60 || true
  wait_up "Next.js" "$WEB_URL" 60 || true
  wait_up "canvas-agent" "$AGENT_URL" 30 || true
  echo
  echo "=== 本地开发环境 ==="
  echo "前端:        http://localhost:3000"
  echo "后端:        http://127.0.0.1:8080"
  echo "canvas-agent: http://127.0.0.1:3210"
  echo "日志目录:    $LOG_DIR"
}

stop_all() {
  for port in 8080 3000 3210; do
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      echo "[停止] 端口 $port 进程: $pids"
      kill $pids 2>/dev/null || true
    else
      echo "[跳过] 端口 $port 无进程"
    fi
  done
}

status_all() {
  for entry in "Go 后端:$BACKEND_URL" "Next.js:$WEB_URL" "canvas-agent:$AGENT_URL"; do
    name="${entry%%:*}"
    url="${entry#*:}"
    if is_up "$url"; then echo "[运行中] $name"; else echo "[未运行] $name"; fi
  done
}

case "${1:-start}" in
  start) start_all ;;
  stop) stop_all ;;
  status) status_all ;;
  *) echo "用法: ./dev.sh [start|stop|status]"; exit 1 ;;
esac
