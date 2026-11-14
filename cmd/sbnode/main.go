package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"sbpanel/internal/node"
)

func usage() {
	fmt.Fprintln(os.Stderr, `usage:
  sbnode enroll --master host:port --token T --ca-sha256 FP [--dir D]
  sbnode run [--dir D]
  sbnode status [--dir D]
  sbnode version`)
	os.Exit(2)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	fs := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	dir := fs.String("dir", envOr("SBN_DIR", "/var/lib/sbnode"), "state directory")
	masterAddr := fs.String("master", "", "master gRPC address host:port")
	token := fs.String("token", "", "one-time enrollment token")
	ca := fs.String("ca-sha256", "", "master CA fingerprint")
	fs.Parse(os.Args[2:])
	switch os.Args[1] {
	case "enroll":
		if *masterAddr == "" || *token == "" || *ca == "" {
			usage()
		}
		if err := node.Enroll(*dir, *masterAddr, *token, *ca); err != nil {
			log.Fatal(err)
		}
		fmt.Println("enrolled; start with: sbnode run --dir", *dir)
	case "run":
		a, err := node.NewAgent(node.Config{Dir: *dir})
		if err != nil {
			log.Fatal(err)
		}
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer stop()
		if err := a.Run(ctx); err != nil {
			log.Fatal(err)
		}
	case "status":
		s, err := node.Status(*dir)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Print(s)
	case "version":
		fmt.Printf("sbnode %s (sing-box %s)\n", node.Version, node.SingboxVersion())
	default:
		usage()
	}
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
