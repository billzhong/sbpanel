package master

import (
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"

	"google.golang.org/protobuf/proto"

	"sbpanel/internal/pb"
)

// DefaultSkeleton is the sing-box config (minus inbounds) given to new nodes.
// The sniff rule must stay first: it fills metadata.Domain for traffic analysis.
const DefaultSkeleton = `{
  "log": {"level": "warn", "timestamp": true},
  "dns": {"servers": [{"type": "local", "tag": "local"}]},
  "route": {
    "rules": [{"action": "sniff"}],
    "final": "direct",
    "default_domain_resolver": "local"
  },
  "outbounds": [{"type": "direct", "tag": "direct"}]
}`

func shortHash(b ...[]byte) string {
	h := sha256.New()
	for _, x := range b {
		h.Write(x)
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}

type specUser struct {
	ID       int64
	UUID     string
	Password string
	Flow     string
}

// ssKey derives a per-user Shadowsocks 2022 key from the user's password, so the
// same key can be rebuilt for subscriptions without storing another secret.
func ssKey(password string, n int) string {
	h := sha256.Sum256([]byte("sbpanel-ss2022:" + password))
	return base64.StdEncoding.EncodeToString(h[:n])
}

func ssKeyLen(method string) int {
	switch method {
	case "2022-blake3-aes-128-gcm":
		return 16
	default:
		return 32
	}
}

// usersJSON renders the sing-box "users" array for an inbound type.
func usersJSON(typ string, opts map[string]any, us []specUser) ([]byte, error) {
	out := make([]map[string]any, 0, len(us))
	for _, u := range us {
		name := strconv.FormatInt(u.ID, 10)
		switch typ {
		case "vless":
			m := map[string]any{"name": name, "uuid": u.UUID}
			flow := u.Flow
			if f, ok := opts["_flow"].(string); ok {
				flow = f
			}
			if flow != "" {
				m["flow"] = flow
			}
			out = append(out, m)
		case "vmess":
			out = append(out, map[string]any{"name": name, "uuid": u.UUID, "alterId": 0})
		case "tuic":
			out = append(out, map[string]any{"name": name, "uuid": u.UUID, "password": u.Password})
		case "shadowsocks":
			method, _ := opts["method"].(string)
			out = append(out, map[string]any{"name": name, "password": ssKey(u.Password, ssKeyLen(method))})
		case "trojan", "hysteria2", "anytls", "naive", "shadowtls":
			out = append(out, map[string]any{"name": name, "password": u.Password})
		default:
			return nil, fmt.Errorf("inbound type %q has no user model", typ)
		}
	}
	return json.Marshal(out)
}

// buildSpec computes the desired state of one node from the database.
func buildSpec(db *sql.DB, nodeID string) (*pb.NodeSpec, error) {
	var skeleton string
	if err := db.QueryRow(`SELECT skeleton_json FROM nodes WHERE id=?`, nodeID).Scan(&skeleton); err != nil {
		return nil, err
	}
	if skeleton == "" {
		skeleton = DefaultSkeleton
	}
	var sk any
	if err := json.Unmarshal([]byte(skeleton), &sk); err != nil {
		return nil, fmt.Errorf("skeleton: %w", err)
	}
	skb, _ := json.Marshal(sk) // canonical
	spec := &pb.NodeSpec{SkeletonJson: skb, SkeletonHash: shortHash(skb)}

	var users []specUser
	rows, err := db.Query(`SELECT id, uuid, password, flow FROM users WHERE enabled=1 AND status='active' ORDER BY id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var u specUser
		rows.Scan(&u.ID, &u.UUID, &u.Password, &u.Flow)
		users = append(users, u)
	}
	rows.Close()

	rows, err = db.Query(`SELECT tag, type, options_json FROM inbounds WHERE node_id=? AND enabled=1 ORDER BY tag`, nodeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var tag, typ, optsJSON string
		rows.Scan(&tag, &typ, &optsJSON)
		var opts map[string]any
		if err := json.Unmarshal([]byte(optsJSON), &opts); err != nil {
			return nil, fmt.Errorf("inbound %s: %w", tag, err)
		}
		uj, err := usersJSON(typ, opts, users)
		if err != nil {
			return nil, fmt.Errorf("inbound %s: %w", tag, err)
		}
		// keys starting with "_" are panel-only hints
		for k := range opts {
			if len(k) > 0 && k[0] == '_' {
				delete(opts, k)
			}
		}
		delete(opts, "users")
		delete(opts, "type")
		delete(opts, "tag")
		ob, _ := json.Marshal(opts)
		names := make([]string, len(users))
		for i, u := range users {
			names[i] = strconv.FormatInt(u.ID, 10)
		}
		spec.Inbounds = append(spec.Inbounds, &pb.InboundSpec{
			Tag: tag, Type: typ,
			OptionsJson: ob, OptionsHash: shortHash([]byte(typ), ob),
			UsersJson: uj, UsersHash: shortHash(uj),
			UserNames: names,
		})
	}
	sort.Slice(spec.Inbounds, func(i, j int) bool { return spec.Inbounds[i].Tag < spec.Inbounds[j].Tag })
	return spec, nil
}

func specHash(s *pb.NodeSpec) string {
	parts := [][]byte{[]byte(s.SkeletonHash)}
	for _, in := range s.Inbounds {
		parts = append(parts, []byte(in.Tag), []byte(in.OptionsHash), []byte(in.UsersHash))
	}
	return shortHash(parts...)
}

// reconcile recomputes desired state for the given nodes (all when empty) and bumps
// the revision of every node whose spec changed. It returns the nodes that changed.
func (m *Master) reconcile(nodeIDs ...string) []string {
	m.specMu.Lock()
	defer m.specMu.Unlock()
	if len(nodeIDs) == 0 {
		rows, err := m.db.Query(`SELECT id FROM nodes`)
		if err != nil {
			return nil
		}
		for rows.Next() {
			var id string
			rows.Scan(&id)
			nodeIDs = append(nodeIDs, id)
		}
		rows.Close()
	}
	var changed []string
	for _, id := range nodeIDs {
		spec, err := buildSpec(m.db, id)
		if err != nil {
			m.log.Printf("reconcile %s: %v", id, err)
			continue
		}
		h := specHash(spec)
		var old string
		var rev uint64
		m.db.QueryRow(`SELECT spec_hash, revision FROM nodes WHERE id=?`, id).Scan(&old, &rev)
		if h == old {
			continue
		}
		rev++
		spec.Revision = rev
		blob, _ := proto.Marshal(spec)
		if _, err := m.db.Exec(`UPDATE nodes SET revision=?, spec_hash=?, spec_pb=? WHERE id=?`, rev, h, blob, id); err != nil {
			m.log.Printf("reconcile %s: %v", id, err)
			continue
		}
		changed = append(changed, id)
		m.hub.notifySpec(id, rev)
	}
	return changed
}

func (m *Master) loadSpec(nodeID string) (*pb.NodeSpec, error) {
	var blob []byte
	if err := m.db.QueryRow(`SELECT spec_pb FROM nodes WHERE id=?`, nodeID).Scan(&blob); err != nil {
		return nil, err
	}
	if len(blob) == 0 {
		m.reconcile(nodeID)
		if err := m.db.QueryRow(`SELECT spec_pb FROM nodes WHERE id=?`, nodeID).Scan(&blob); err != nil {
			return nil, err
		}
	}
	s := &pb.NodeSpec{}
	return s, proto.Unmarshal(blob, s)
}
