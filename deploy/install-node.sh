#!/usr/bin/env bash
# Install sbnode from a local binary and enroll it.
#   ./install-node.sh ./sbnode-linux-amd64 "sbnode enroll --master host:9443 --token ... --ca-sha256 ..."
set -euo pipefail
bin=${1:?path to sbnode binary}
enroll=${2:?enroll command copied from the panel}
install -m 0755 "$bin" /usr/local/bin/sbnode
install -d -m 0700 /var/lib/sbnode
# shellcheck disable=SC2086
/usr/local/bin/sbnode ${enroll#sbnode } --dir /var/lib/sbnode
install -m 0644 "$(dirname "$0")/sbnode.service" /etc/systemd/system/sbnode.service
systemctl daemon-reload
systemctl enable --now sbnode
systemctl --no-pager status sbnode | head -5
