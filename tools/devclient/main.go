// devclient runs a sing-box client config (used by scripts/dev-demo.sh to generate
// real traffic through a local node).
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/include"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing/common/json"
)

func main() {
	b, err := os.ReadFile(os.Args[1])
	if err != nil {
		log.Fatal(err)
	}
	ctx := include.Context(context.Background())
	var opts option.Options
	if err := json.UnmarshalContext(ctx, b, &opts); err != nil {
		log.Fatal(err)
	}
	inst, err := box.New(box.Options{Context: ctx, Options: opts})
	if err != nil {
		log.Fatal(err)
	}
	if err := inst.Start(); err != nil {
		log.Fatal(err)
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	inst.Close()
}
