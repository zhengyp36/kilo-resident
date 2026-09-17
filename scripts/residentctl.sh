#!/usr/bin/env bash
# Manage the resident Kilo host (`kilo serve`) + the kilo-resident bridge.
# Usage: scripts/residentctl.sh {start|stop|restart|status|logs}
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$HOME/.local/state/kilo-resident"
LOG="$STATE/log"
mkdir -p "$LOG"

HOST=127.0.0.1
PORT=4097
USER=kilo
PASS=kilo
SERVE_PID="$STATE/serve.pid"
BRIDGE_PID="$STATE/bridge.pid"
SERVE_LOG="$LOG/serve.log"
BRIDGE_LOG="$LOG/bridge.log"

port_open() { timeout 1 bash -c ">/dev/tcp/$1/$2" >/dev/null 2>&1; }
alive() { [[ -f "$1" ]] && kill -0 "$(cat "$1")" 2>/dev/null; }
wait_port() { for _ in $(seq 1 80); do port_open "$1" "$2" && return 0; sleep 0.5; done; return 1; }

control_port() {
  node -e 'try{const c=require(process.argv[1]);process.stdout.write(String(c.control?.port??4180))}catch{process.stdout.write("4180")}' "$REPO/config.json" 2>/dev/null || echo 4180
}

start_serve() {
  if port_open "$HOST" "$PORT"; then echo "serve : already listening on $HOST:$PORT"; return 0; fi
  command -v kilo >/dev/null || { echo "serve : 'kilo' not on PATH"; return 1; }
  echo "serve : starting on $HOST:$PORT ..."
  setsid bash -c 'echo $$ >"'"$SERVE_PID"'"; exec env -u KILO_PROCESS_ROLE -u KILO_RUN_ID -u KILO_PID -u KILO -u KILOCODE_FEATURE KILO_SERVER_USERNAME="'"$USER"'" KILO_SERVER_PASSWORD="'"$PASS"'" kilo serve --hostname "'"$HOST"'" --port "'"$PORT"'"' >>"$SERVE_LOG" 2>&1 &
  if wait_port "$HOST" "$PORT"; then echo "serve : ready"; else echo "serve : FAILED (see $SERVE_LOG)"; return 1; fi
}

start_bridge() {
  if alive "$BRIDGE_PID"; then echo "bridge: already running (pid $(cat "$BRIDGE_PID"))"; return 0; fi
  echo "bridge: starting ..."
  setsid bash -c 'echo $$ >"'"$BRIDGE_PID"'"; cd "'"$REPO"'"; exec node src/index.ts' >>"$BRIDGE_LOG" 2>&1 &
  local cport; cport="$(control_port)"
  if wait_port "$HOST" "$cport"; then echo "bridge: ready (control :$cport)"; else echo "bridge: FAILED (see $BRIDGE_LOG)"; return 1; fi
}

stop_one() {
  local name="$1" f="$2"
  if alive "$f"; then
    local pid; pid="$(cat "$f")"
    echo "$name: stopping pid $pid"
    kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -KILL -"$pid" 2>/dev/null || true
  else
    echo "$name: not running"
  fi
  rm -f "$f"
}

attach() {
  local session="${1:-}"
  local dir="${2:-$PWD}"
  local state="$REPO/state.json"
  if [[ -z "$session" ]]; then
    if [[ -f "$state" ]]; then
      session="$(node -e 'const fs=require("fs");try{const st=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const cfg=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));const dir=(process.argv[3]||"").replace(/\/+$/,"");const bots=cfg.bots||[];const bot=bots.find(function(b){return b.directory.replace(/\/+$/,"")===dir})||bots[0];process.stdout.write((bot&&st.sessions&&st.sessions[bot.name])||"")}catch{}' "$state" "$REPO/config.json" "$dir" 2>/dev/null || true)"
    fi
  elif [[ "$session" == "new" || "$session" == "-" ]]; then
    session=""
  fi
  local args=("http://$HOST:$PORT" -u "$USER" -p "$PASS")
  [[ -n "$session" ]] && args+=(-s "$session")
  [[ -n "$dir" ]] && args+=(--dir "$dir")
  echo "attach: http://$HOST:$PORT${session:+ session=$session}${dir:+ dir=$dir}"
  export TERM=xterm-256color
  exec kilo attach "${args[@]}"
}

status() {
  if alive "$SERVE_PID"; then echo "serve : running (pid $(cat "$SERVE_PID"))"
  elif port_open "$HOST" "$PORT"; then echo "serve : listening on $HOST:$PORT (unmanaged)"
  else echo "serve : down"; fi
  if alive "$BRIDGE_PID"; then echo "bridge: running (pid $(cat "$BRIDGE_PID"))"
  elif port_open "$HOST" "$(control_port)"; then echo "bridge: control :$(control_port) open (unmanaged)"
  else echo "bridge: down"; fi
}

case "${1:-}" in
  start|up)
    start_serve
    start_bridge
    echo
    echo "logs: $SERVE_LOG | $BRIDGE_LOG"
    ;;
  stop|down)
    stop_one bridge "$BRIDGE_PID"
    stop_one serve "$SERVE_PID"
    ;;
  restart)
    stop_one bridge "$BRIDGE_PID"
    stop_one serve "$SERVE_PID"
    start_serve
    start_bridge
    ;;
  bridge-restart)
    stop_one bridge "$BRIDGE_PID"
    start_bridge
    ;;
  status)
    status
    ;;
  attach)
    shift || true
    attach "${1:-}"
    ;;
  logs)
    tail -n 50 -f "$SERVE_LOG" "$BRIDGE_LOG"
    ;;
  *)
    echo "usage: $0 {start|stop|restart|bridge-restart|status|attach [session|new] [dir]|logs}" >&2
    exit 1
    ;;
esac
