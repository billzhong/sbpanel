#!/usr/bin/env bash
# Local end-to-end demo: master + one node + two users behind VLESS REALITY, and
# two clients generating real traffic to a mix of sites.
#   scripts/dev-demo.sh start   # build first: make web master node; go build -o bin/devclient ./tools/devclient
#   scripts/dev-demo.sh traffic # one round of requests through both users
#   scripts/dev-demo.sh stop
set -euo pipefail
cd "$(dirname "$0")/.."
D=.dev
WEB=127.0.0.1:28080
GRPC=127.0.0.1:29443
PASS=${SBM_ADMIN_PASSWORD:-sbpanel-dev}
IN_PORT=24443
J="$D/cookies"

api() { curl -fsS -b "$J" -c "$J" -H 'Content-Type: application/json' "$@"; }
py() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

start() {
  mkdir -p "$D/logs"
  if [ ! -f "$D/master.pid" ] || ! kill -0 "$(cat "$D/master.pid")" 2>/dev/null; then
    SBM_ADMIN_PASSWORD="$PASS" nohup bin/sbmaster --data "$D/master" --web "$WEB" --grpc "$GRPC" >"$D/logs/master.log" 2>&1 &
    echo $! >"$D/master.pid"
    for _ in $(seq 1 50); do curl -s -o /dev/null "http://$WEB/" && break; sleep 0.2; done
  fi
  api -X POST "http://$WEB/api/auth/login" -d "{\"username\":\"admin\",\"password\":\"$PASS\"}" >/dev/null

  if [ ! -f "$D/node/node_id" ]; then
    E=$(api -X POST "http://$WEB/api/nodes" -d '{"name":"mac-local"}')
    bin/sbnode enroll --dir "$D/node" --master "$(echo "$E" | py 'd["master"]')" \
      --token "$(echo "$E" | py 'd["token"]')" --ca-sha256 "$(echo "$E" | py 'd["ca_sha256"]')"
  fi
  if [ ! -f "$D/node.pid" ] || ! kill -0 "$(cat "$D/node.pid")" 2>/dev/null; then
    nohup bin/sbnode run --dir "$D/node" >"$D/logs/node.log" 2>&1 &
    echo $! >"$D/node.pid"
    sleep 2
  fi
  NODE=$(cat "$D/node/node_id")

  if [ "$(api "http://$WEB/api/users" | py 'len(d)')" = "0" ]; then
    api -X POST "http://$WEB/api/users" -d '{"username":"alice","traffic_limit":107374182400,"note":"手机 + 笔记本"}' >/dev/null
    api -X POST "http://$WEB/api/users" -d '{"username":"bob","traffic_limit":21474836480}' >/dev/null
  fi
  if [ "$(api "http://$WEB/api/inbounds" | py 'len(d)')" = "0" ]; then
    KP=$(api -X POST "http://$WEB/api/tools/reality-keypair")
    PRIV=$(echo "$KP" | py 'd["private_key"]'); PUB=$(echo "$KP" | py 'd["public_key"]'); SID=$(echo "$KP" | py 'd["short_id"]')
    api -X POST "http://$WEB/api/inbounds" -d "{\"node_id\":\"$NODE\",\"tag\":\"vless-reality\",\"type\":\"vless\",\"remark\":\"主力入口\",
      \"options\":{\"listen\":\"127.0.0.1\",\"listen_port\":$IN_PORT,\"_flow\":\"xtls-rprx-vision\",
        \"tls\":{\"enabled\":true,\"server_name\":\"www.microsoft.com\",\"reality\":{\"enabled\":true,
          \"handshake\":{\"server\":\"www.microsoft.com\",\"server_port\":443},\"private_key\":\"$PRIV\",\"short_id\":[\"$SID\"]}}},
      \"client\":{\"security\":\"reality\",\"sni\":\"www.microsoft.com\",\"public_key\":\"$PUB\",\"short_id\":\"$SID\",\"flow\":\"xtls-rprx-vision\"}}" >/dev/null
    sleep 3
  fi
  # clients for each user
  INB=$(api "http://$WEB/api/inbounds")
  PUB=$(echo "$INB" | py 'd[0]["client"]["public_key"]'); SID=$(echo "$INB" | py 'd[0]["client"]["short_id"]')
  port=17890
  for uid in $(api "http://$WEB/api/users" | py '" ".join(str(u["id"]) for u in d)'); do
    UUID=$(api "http://$WEB/api/users/$uid" | py 'd["user"]["uuid"]')
    cat >"$D/client-$uid.json" <<EOF
{"log":{"level":"warn"},"inbounds":[{"type":"mixed","listen":"127.0.0.1","listen_port":$port}],
 "outbounds":[{"type":"vless","server":"127.0.0.1","server_port":$IN_PORT,"uuid":"$UUID","flow":"xtls-rprx-vision",
  "tls":{"enabled":true,"server_name":"www.microsoft.com","utls":{"enabled":true,"fingerprint":"chrome"},
   "reality":{"enabled":true,"public_key":"$PUB","short_id":"$SID"}}}]}
EOF
    if [ ! -f "$D/client-$uid.pid" ] || ! kill -0 "$(cat "$D/client-$uid.pid")" 2>/dev/null; then
      nohup bin/devclient "$D/client-$uid.json" >"$D/logs/client-$uid.log" 2>&1 &
      echo $! >"$D/client-$uid.pid"
    fi
    echo "$port" >"$D/client-$uid.port"
    port=$((port + 1))
  done
  echo "panel: http://$WEB  (admin / $PASS)"
}

traffic() {
  local sites=(https://www.baidu.com https://www.bilibili.com https://www.qq.com https://github.com https://www.apple.com
    https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js https://www.cloudflare.com https://www.microsoft.com
    https://registry.npmmirror.com/react https://speed.cloudflare.com/__down?bytes=8000000)
  for f in "$D"/client-*.port; do
    p=$(cat "$f")
    for s in "${sites[@]}"; do
      if [ $((RANDOM % 3)) -ne 0 ]; then
        curl -s -o /dev/null -m 20 -x "http://127.0.0.1:$p" "$s" || true
      fi
    done
  done
}

stop() {
  for f in "$D"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "$f"; done
}

"${1:-start}"
