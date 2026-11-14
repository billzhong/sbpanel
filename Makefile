TAGS    := with_quic,with_utls,with_acme
SBVER   := $(shell go list -m -f '{{.Version}}' github.com/sagernet/sing-box | sed 's/^v//')
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -checklinkname=0 -X github.com/sagernet/sing-box/constant.Version=$(SBVER) -X sbpanel/internal/node.Version=$(VERSION) -X sbpanel/internal/master.Version=$(VERSION)
GOFLAGS := -trimpath -tags $(TAGS)
ARCHES  := amd64 arm64

.PHONY: all web master node linux dist test test-race proto clean

all: web master node

web:
	cd web && pnpm install --frozen-lockfile && pnpm build

master:
	go build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o bin/sbmaster ./cmd/sbmaster

node:
	go build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o bin/sbnode ./cmd/sbnode

linux:
	for a in amd64 arm64; do \
	  CGO_ENABLED=0 GOOS=linux GOARCH=$$a go build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o bin/sbmaster-linux-$$a ./cmd/sbmaster && \
	  CGO_ENABLED=0 GOOS=linux GOARCH=$$a go build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o bin/sbnode-linux-$$a ./cmd/sbnode; \
	done

# release archives: dist/sbpanel_<ver>_linux_<arch>.tar.gz + checksums.txt + NOTES.md
dist: web
	go run ./tools/dist -version $(VERSION) -singbox $(SBVER) -ldflags '$(LDFLAGS)' -tags $(TAGS) -arches '$(ARCHES)'

test:
	go test -tags $(TAGS) -count=1 ./...

# checkptr is disabled: upstream XTLS Vision does pointer arithmetic that trips it
test-race:
	go test -race -gcflags=all=-d=checkptr=0 -tags $(TAGS) -count=1 ./...

proto:
	PATH=$$HOME/go/bin:$$PATH buf generate

clean:
	rm -rf bin web/dist/assets web/dist/index.html
