package master

import (
	"encoding/json"
	"strings"
	"testing"
)

const xuiExport = `{"success":true,"msg":"","obj":[
 {"id":1,"remark":"reality","enable":true,"listen":"","port":443,"protocol":"vless","tag":"inbound-443",
  "settings":"{\"clients\":[{\"id\":\"11111111-1111-1111-1111-111111111111\",\"email\":\"alice\",\"flow\":\"xtls-rprx-vision\",\"totalGB\":107374182400,\"expiryTime\":1893456000000,\"enable\":true,\"subId\":\"subalice123\",\"limitIp\":2},{\"id\":\"22222222-2222-2222-2222-222222222222\",\"email\":\"bob\",\"flow\":\"xtls-rprx-vision\",\"totalGB\":0,\"expiryTime\":0,\"enable\":false,\"subId\":\"subbob456\"}],\"decryption\":\"none\"}",
  "streamSettings":"{\"network\":\"tcp\",\"security\":\"reality\",\"realitySettings\":{\"dest\":\"www.microsoft.com:443\",\"serverNames\":[\"www.microsoft.com\"],\"privateKey\":\"6PA7Cv0PWmrqgZZnuUp-ApqPpLqjYUjQsiKbUL_eFHM\",\"shortIds\":[\"ab12\",\"\"]}}",
  "clientStats":[{"email":"alice","up":100,"down":2000},{"email":"bob","up":1,"down":2}]},
 {"id":2,"remark":"ws","enable":true,"listen":"0.0.0.0","port":8443,"protocol":"vmess","tag":"inbound-8443",
  "settings":"{\"clients\":[{\"id\":\"11111111-1111-1111-1111-111111111111\",\"email\":\"alice\",\"subId\":\"subalice123\"}]}",
  "streamSettings":"{\"network\":\"ws\",\"security\":\"tls\",\"wsSettings\":{\"path\":\"/v\",\"host\":\"cdn.example.com\"},\"tlsSettings\":{\"serverName\":\"v.example.com\",\"certificates\":[{\"certificateFile\":\"/etc/c.pem\",\"keyFile\":\"/etc/k.pem\"}],\"alpn\":[\"http/1.1\"]}}"},
 {"id":3,"remark":"tj","enable":true,"listen":"","port":4433,"protocol":"trojan","tag":"in-4433",
  "settings":"{\"clients\":[{\"password\":\"trojanpw\",\"email\":\"carol\",\"subId\":\"\"}]}",
  "streamSettings":"{\"network\":\"grpc\",\"security\":\"tls\",\"grpcSettings\":{\"serviceName\":\"gun\"},\"tlsSettings\":{\"serverName\":\"t.example.com\",\"certificates\":[{\"certificate\":[\"-----BEGIN CERTIFICATE-----\",\"x\"],\"key\":[\"k\"]}]}}"},
 {"id":4,"remark":"xhttp","enable":true,"listen":"","port":18443,"protocol":"vless","tag":"in-x",
  "settings":"{\"clients\":[{\"id\":\"33333333-3333-3333-3333-333333333333\",\"email\":\"dave\"}]}",
  "streamSettings":"{\"network\":\"xhttp\",\"security\":\"none\"}"},
 {"id":5,"remark":"sock","enable":true,"listen":"/dev/shm/x.sock","port":0,"protocol":"vless","tag":"in-s","settings":"{}","streamSettings":"{}"}
]}`

func TestImport3XUI(t *testing.T) {
	m := newTestMaster(t)
	seedNode(t, m, "n1")
	ins, err := ParseXUIExport([]byte(xuiExport))
	if err != nil || len(ins) != 5 {
		t.Fatalf("parse: %v %d", err, len(ins))
	}
	// dry run writes nothing
	rep, err := m.Import3XUI("n1", ins, true)
	if err != nil {
		t.Fatal(err)
	}
	var n int
	m.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	if n != 0 || rep.Users != 3 || len(rep.Inbounds) != 3 || len(rep.Skipped) != 2 {
		t.Fatalf("dry run: users=%d rep=%+v", n, rep)
	}
	if _, err := m.Import3XUI("missing", ins, false); err == nil {
		t.Fatal("unknown node accepted")
	}
	rep, err = m.Import3XUI("n1", ins, false)
	if err != nil {
		t.Fatal(err)
	}
	type u struct {
		name, tok, uuid, pw, status string
		limit, exp, dl, up, down    int64
		enabled                     bool
	}
	get := func(name string) u {
		var x u
		m.db.QueryRow(`SELECT username, sub_token, uuid, password, status, traffic_limit, expire_at, device_limit, used_up, used_down, enabled FROM users WHERE username=?`, name).
			Scan(&x.name, &x.tok, &x.uuid, &x.pw, &x.status, &x.limit, &x.exp, &x.dl, &x.up, &x.down, &x.enabled)
		return x
	}
	a := get("alice")
	if a.tok != "subalice123" || a.uuid != "11111111-1111-1111-1111-111111111111" || a.limit != 107374182400 || a.exp != 1893456000 || a.dl != 2 || a.up != 100 || a.down != 2000 {
		t.Fatalf("alice %+v", a)
	}
	if b := get("bob"); b.enabled || b.tok != "subbob456" {
		t.Fatalf("bob %+v", b)
	}
	if c := get("carol"); c.pw != "trojanpw" || c.tok == "" {
		t.Fatalf("carol %+v", c)
	}
	// alice is on reality + ws, bob only reality, carol only trojan -> 3 groups
	var groups int
	m.db.QueryRow(`SELECT COUNT(*) FROM groups WHERE name LIKE '3x-ui%'`).Scan(&groups)
	if groups != 3 {
		t.Fatalf("groups = %d", groups)
	}
	spec, err := buildSpec(m.db, "n1")
	if err != nil {
		t.Fatal(err)
	}
	byTag := map[string]string{}
	for _, in := range spec.Inbounds {
		byTag[in.Tag] = strings.Join(in.UserNames, ",")
		var o map[string]any
		json.Unmarshal(in.OptionsJson, &o)
		if in.Tag == "inbound-443" {
			r := obj(obj(o, "tls"), "reality")
			if str(obj(r, "handshake"), "server") != "www.microsoft.com" || len(strs(r, "short_id")) != 2 {
				t.Fatalf("reality opts %v", o)
			}
		}
		if in.Tag == "inbound-8443" && str(obj(o, "transport"), "path") != "/v" {
			t.Fatalf("ws opts %v", o)
		}
	}
	// bob is disabled so only alice is on the reality inbound
	if byTag["inbound-443"] != "1" || byTag["inbound-8443"] != "1" || byTag["in-4433"] != "3" {
		t.Fatalf("membership %v", byTag)
	}
	// subscription entries keep the 3x-ui subId link working and use the derived reality key
	ua, _ := m.loadSubUser("subalice123")
	es, _ := m.subEntries(ua)
	if len(es) != 2 || es[0].PBK == "" || es[0].SID != "ab12" {
		t.Fatalf("entries %+v", es)
	}
	// importing again: port conflict rolls back everything
	if _, err := m.Import3XUI("n1", ins, false); err == nil || !strings.Contains(err.Error(), "端口") {
		t.Fatalf("expected port conflict, got %v", err)
	}
	m.db.QueryRow(`SELECT COUNT(*) FROM inbounds`).Scan(&n)
	if n != 3 {
		t.Fatalf("rollback failed: %d inbounds", n)
	}
}

func TestImport3XUIUsersOnly(t *testing.T) {
	m := newTestMaster(t)
	ins, _ := ParseXUIExport([]byte(xuiExport))
	rep, err := m.Import3XUIUsers(ins, false)
	if err != nil || rep.Users != 3 || len(rep.Inbounds) != 0 || !rep.UsersOnly {
		t.Fatalf("users-only: %+v %v", rep, err)
	}
	var inb, grp, ug int
	m.db.QueryRow(`SELECT COUNT(*) FROM inbounds`).Scan(&inb)
	m.db.QueryRow(`SELECT COUNT(*) FROM groups WHERE name LIKE '3x-ui%'`).Scan(&grp)
	m.db.QueryRow(`SELECT COUNT(*) FROM user_groups ug JOIN groups g ON g.id=ug.group_id WHERE g.is_default=1`).Scan(&ug)
	if inb != 0 || grp != 0 || ug != 3 {
		t.Fatalf("inbounds=%d import-groups=%d default-group members=%d", inb, grp, ug)
	}
	u, _ := m.loadSubUser("subalice123")
	if u.UUID != "11111111-1111-1111-1111-111111111111" || u.Limit != 107374182400 {
		t.Fatalf("alice %+v", u)
	}
}
