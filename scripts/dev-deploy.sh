#!/usr/bin/env bash
# Fast dev deploy: build linux binaries locally and push them straight to your own
# machines over SSH, without cutting a GitHub release. Machines must have been set
# up once with install.sh (it creates the services, env files and directories).
#
#   scripts/dev-deploy.sh                 # build the working tree, deploy master + all nodes
#   scripts/dev-deploy.sh nodes           # only nodes      (also: master)
#   scripts/dev-deploy.sh --ref HEAD      # build a clean checkout of a commit instead
#   scripts/dev-deploy.sh --skip-web      # reuse web/dist (backend-only change)
#   scripts/dev-deploy.sh rollback        # put back the previous binaries everywhere
#   scripts/dev-deploy.sh status          # versions and service state
#
# Hosts come from .dev/deploy/hosts.env (or $SBP_HOSTS_FILE):
#   MASTER_HOST="root@panel.example.com"           # runs sbmaster
#   NODE_HOSTS="root@panel.example.com node2 node3" # run sbnode (ssh aliases are fine)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

HOSTS_FILE=${SBP_HOSTS_FILE:-.dev/deploy/hosts.env}
[ -f "$HOSTS_FILE" ] || { echo "missing $HOSTS_FILE (see the header of this script)" >&2; exit 1; }
# shellcheck disable=SC1090
. "$HOSTS_FILE"
MASTER_HOST=${MASTER_HOST:-}
NODE_HOSTS=${NODE_HOSTS:-}

what=all ref="" skip_web=0
while [ $# -gt 0 ]; do
	case "$1" in
	all | master | nodes | rollback | status) what=$1 ;;
	--ref) ref=$2; shift ;;
	--skip-web) skip_web=1 ;;
	-h | --help) sed -n '2,16p' "$0"; exit 0 ;;
	*) echo "unknown argument: $1" >&2; exit 1 ;;
	esac
	shift
done

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
targets() { # "<host> <binary>" lines for the selected part
	if [ "$what" != nodes ] && [ -n "$MASTER_HOST" ]; then echo "$MASTER_HOST sbmaster"; fi
	if [ "$what" != master ]; then for h in $NODE_HOSTS; do echo "$h sbnode"; done; fi
}
remote() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$1" "bash -c $(printf '%q' "$2")"; }

status() {
	targets | while read -r h b; do
		printf '%-28s %-9s %s\n' "$h" "$b" "$(remote "$h" "/usr/local/bin/$b version 2>/dev/null | head -1; systemctl is-active $b" </dev/null | tr '\n' ' ')"
	done
}

if [ "$what" = status ]; then status; exit 0; fi
if [ "$what" = rollback ]; then
	what=all
	targets | while read -r h b; do
		remote "$h" "set -e; test -f /usr/local/bin/$b.prev; mv -f /usr/local/bin/$b.prev /usr/local/bin/$b; systemctl restart $b; sleep 1; systemctl is-active --quiet $b" </dev/null &&
			say "$h: $b rolled back" || echo "$h: $b rollback failed (no .prev?)" >&2
	done
	status
	exit 0
fi

# ---- build ----
src=$ROOT
if [ -n "$ref" ]; then
	src=$(mktemp -d "${TMPDIR:-/tmp}/sbp-deploy.XXXXXX")
	trap 'git -C "$ROOT" worktree remove --force "$src" >/dev/null 2>&1 || true' EXIT
	git worktree add --detach --quiet "$src" "$ref"
	# reuse installed frontend deps instead of a fresh pnpm install
	[ -d "$ROOT/web/node_modules" ] && ln -s "$ROOT/web/node_modules" "$src/web/node_modules"
fi
cd "$src"
sha=$(git rev-parse --short HEAD)
dirty=""
[ -z "$ref" ] && ! git diff --quiet HEAD -- . ':!web/dist' 2>/dev/null && dirty="-dirty"
VERSION="dev-$(date +%m%d.%H%M)-$sha$dirty"
if [ "$skip_web" = 0 ] && [ "$what" != nodes ]; then
	say "building web"
	if [ -e web/node_modules ]; then (cd web && pnpm -s build >/dev/null); else make -s web >/dev/null; fi
fi
out=$(mktemp -d "${TMPDIR:-/tmp}/sbp-bin.XXXXXX")
bins="sbmaster sbnode"
[ "$what" = master ] && bins=sbmaster
[ "$what" = nodes ] && bins=sbnode
SBVER=$(go list -m -f '{{.Version}}' github.com/sagernet/sing-box | sed 's/^v//')
LDFLAGS="-s -w -checklinkname=0 -X github.com/sagernet/sing-box/constant.Version=$SBVER -X sbpanel/internal/node.Version=$VERSION -X sbpanel/internal/master.Version=$VERSION"
for b in $bins; do
	say "building $b $VERSION (linux/amd64)"
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -tags with_quic,with_utls,with_acme -ldflags "$LDFLAGS" -o "$out/$b" "./cmd/$b"
	gzip -1 -k "$out/$b"
done
cd "$ROOT"

# ---- push: upload + atomic swap + restart, all hosts in parallel; keep .prev ----
deploy_one() {
	local h=$1 b=$2
	ssh -o BatchMode=yes "$h" "cat > /usr/local/bin/$b.new.gz" <"$out/$b.gz" &&
		remote "$h" "set -e; cd /usr/local/bin; gunzip -f $b.new.gz; chmod 0755 $b.new
			./$b.new version >/dev/null
			cp -f $b $b.prev 2>/dev/null || true
			mv -f $b.new $b
			systemctl restart $b
			for i in 1 2 3 4 5 6; do sleep 1; systemctl is-active --quiet $b && break; done
			systemctl is-active --quiet $b || { echo 'service failed, rolling back'; mv -f $b.prev $b; systemctl restart $b; exit 1; }" </dev/null &&
		say "$h: $b $VERSION" || { echo "$h: $b deploy FAILED" >&2; return 1; }
}
pids=() fails=0
while read -r h b; do
	deploy_one "$h" "$b" &
	pids+=($!)
done < <(targets)
for p in "${pids[@]}"; do wait "$p" || fails=$((fails + 1)); done
rm -rf "$out"
[ "$fails" = 0 ] || { echo "$fails deploy(s) failed" >&2; exit 1; }
say "done: $VERSION"
