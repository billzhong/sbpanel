package master

import (
	"encoding/json"
	"testing"
)

func TestNodeCoreSpec(t *testing.T) {
	m := newTestMaster(t)
	seedNode(t, m, "n1")
	m.db.Exec(`INSERT INTO inbounds(node_id, tag, type, port, options_json, created_at) VALUES('n1','a','shadowsocks',1000,'{"listen_port":1000,"method":"2022-blake3-aes-128-gcm","password":"x","_static":true,"users":null}',0)`)
	m.db.Exec(`INSERT INTO inbounds(node_id, tag, type, port, options_json, created_at) VALUES('n1','b','shadowsocks',1001,'{"listen_port":1001,"method":"2022-blake3-aes-128-gcm","password":"x","_static":true,"tcp_fast_open":false}',0)`)
	before, err := buildSpec(m.db, "n1")
	if err != nil {
		t.Fatal(err)
	}
	if before.Runtime != nil {
		t.Fatal("runtime without settings")
	}
	if _, err := validateNodeCore(`{"udp_timeout":"1s"}`); err == nil {
		t.Fatal("udp_timeout 1s accepted")
	}
	v, err := validateNodeCore(`{"log_level":"info","tcp_fast_open":true,"tcp_multi_path":true,"udp_timeout":"5m","gogc":200,"mem_limit_mb":128}`)
	if err != nil {
		t.Fatal(err)
	}
	setSetting(m.db, "node_core", v)
	s, err := buildSpec(m.db, "n1")
	if err != nil {
		t.Fatal(err)
	}
	var sk map[string]any
	json.Unmarshal(s.SkeletonJson, &sk)
	if sk["log"].(map[string]any)["level"] != "info" {
		t.Fatalf("log: %v", sk["log"])
	}
	opts := map[string]map[string]any{}
	for _, in := range s.Inbounds {
		var o map[string]any
		json.Unmarshal(in.OptionsJson, &o)
		opts[in.Tag] = o
	}
	if opts["a"]["tcp_fast_open"] != true || opts["a"]["tcp_multi_path"] != true || opts["a"]["udp_timeout"] != "5m" {
		t.Fatalf("a: %v", opts["a"])
	}
	if opts["b"]["tcp_fast_open"] != false { // the inbound's own choice wins
		t.Fatalf("b: %v", opts["b"])
	}
	if s.Runtime.GetGogc() != 200 || s.Runtime.GetMemoryLimit() != 128<<20 {
		t.Fatalf("runtime: %v", s.Runtime)
	}
	if specHash(s) == specHash(before) {
		t.Fatal("hash unchanged")
	}
}
