TAGS    := with_quic,with_utls,with_acme
SBVER   := $(shell go list -m -f '{{.Version}}' github.com/sagernet/sing-box | sed 's/^v//')
LDFLAGS := -s -w -checklinkname=0 -X github.com/sagernet/sing-box/constant.Version=$(SBVER) -X sbpanel/internal/node.Version=$(shell git describe --always --dirty 2>/dev/null || echo dev)
GOFLAGS := -trimpath -tags $(TAGS)

.PHONY: all web master node linux test proto clean

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

test:
	go test -tags $(TAGS) -count=1 ./...

proto:
	PATH=$$HOME/go/bin:$$PATH buf generate

clean:
	rm -rf bin web/dist/assets web/dist/index.html
