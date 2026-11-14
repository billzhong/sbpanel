package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
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
	if len(os.Args) > 1 && os.Args[1] == "import-3xui" {
		import3xui(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "reset-admin" {
		resetAdmin(os.Args[2:])
		return
	}
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

// sbmaster import-3xui --data DIR --node ID (--db x-ui.db | --json export.json) [--dry-run]
func import3xui(args []string) {
	fs := flag.NewFlagSet("import-3xui", flag.ExitOnError)
	data := fs.String("data", env("SBM_DATA", "/var/lib/sbmaster"), "sbmaster data directory")
	node := fs.String("node", "", "target node id (see the Nodes page)")
	dbPath := fs.String("db", "", "3x-ui x-ui.db (SQLite)")
	jsonPath := fs.String("json", "", "3x-ui API export (GET /panel/api/inbounds/list)")
	dry := fs.Bool("dry-run", false, "only report what would be imported")
	usersOnly := fs.Bool("users-only", false, "import only users (into the default groups); no inbounds, no --node needed")
	fs.Parse(args)
	if (*node == "" && !*usersOnly) || (*dbPath == "") == (*jsonPath == "") {
		log.Fatal("usage: sbmaster import-3xui (--node ID | --users-only) (--db x-ui.db | --json export.json) [--dry-run]")
	}
	var ins []master.XUIInbound
	var err error
	if *dbPath != "" {
		ins, err = master.LoadXUIDB(*dbPath)
	} else {
		var b []byte
		if b, err = os.ReadFile(*jsonPath); err == nil {
			ins, err = master.ParseXUIExport(b)
		}
	}
	if err != nil {
		log.Fatal(err)
	}
	m, err := master.New(master.Config{DataDir: *data})
	if err != nil {
		log.Fatal(err)
	}
	var rep *master.ImportReport
	if *usersOnly {
		rep, err = m.Import3XUIUsers(ins, *dry)
	} else {
		rep, err = m.Import3XUI(*node, ins, *dry)
	}
	if err != nil {
		log.Fatal(err)
	}
	out, _ := json.MarshalIndent(rep, "", "  ")
	fmt.Println(string(out))
}

// sbmaster reset-admin --data DIR --password NEW (also clears 2FA)
func resetAdmin(args []string) {
	fs := flag.NewFlagSet("reset-admin", flag.ExitOnError)
	data := fs.String("data", env("SBM_DATA", "/var/lib/sbmaster"), "sbmaster data directory")
	user := fs.String("user", "admin", "admin username")
	pw := fs.String("password", "", "new password (min 8 chars)")
	fs.Parse(args)
	if len(*pw) < 8 {
		log.Fatal("--password must be at least 8 characters")
	}
	m, err := master.New(master.Config{DataDir: *data})
	if err != nil {
		log.Fatal(err)
	}
	if err := m.ResetAdmin(*user, *pw); err != nil {
		log.Fatal(err)
	}
	fmt.Println("password reset and 2FA cleared for", *user)
}
