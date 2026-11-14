package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"
	_ "time/tzdata"

	"sbpanel/internal/master"
	"sbpanel/web"
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func main() {
	var cfg master.Config
	flag.StringVar(&cfg.DataDir, "data", env("SBM_DATA", "/var/lib/sbmaster"), "data directory")
	flag.StringVar(&cfg.WebListen, "web", env("SBM_WEB", "127.0.0.1:8080"), "web/API listen address")
	flag.StringVar(&cfg.GRPCListen, "grpc", env("SBM_GRPC", ":9443"), "node gRPC listen address")
	flag.StringVar(&cfg.PublicGRPCAddr, "public-grpc", env("SBM_PUBLIC_GRPC", ""), "host:port nodes dial (shown in enroll command)")
	flag.StringVar(&cfg.TZ, "tz", env("SBM_TZ", "Asia/Shanghai"), "time zone for day/month boundaries")
	flag.Parse()
	cfg.AdminPassword = os.Getenv("SBM_ADMIN_PASSWORD")
	cfg.Web = web.FS()
	m, err := master.New(cfg)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := m.Run(ctx); err != nil {
		log.Fatal(err)
	}
}
