package master

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admins(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS nodes(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '',
  cert_serial TEXT NOT NULL DEFAULT '', cert_expire INTEGER NOT NULL DEFAULT 0,
  skeleton_json TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0, spec_hash TEXT NOT NULL DEFAULT '', spec_pb BLOB,
  applied_revision INTEGER NOT NULL DEFAULT 0, apply_error TEXT NOT NULL DEFAULT '',
  last_seen INTEGER NOT NULL DEFAULT 0, info_json TEXT NOT NULL DEFAULT '{}',
  traffic_limit INTEGER NOT NULL DEFAULT 0, reset_day INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS enroll_tokens(
  token_hash TEXT PRIMARY KEY, node_id TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS inbounds(
  id INTEGER PRIMARY KEY, node_id TEXT NOT NULL, tag TEXT NOT NULL, type TEXT NOT NULL,
  port INTEGER NOT NULL, options_json TEXT NOT NULL, client_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1, remark TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
  UNIQUE(node_id, tag));
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, sub_token TEXT UNIQUE NOT NULL,
  uuid TEXT NOT NULL, password TEXT NOT NULL, flow TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', enabled INTEGER NOT NULL DEFAULT 1,
  traffic_limit INTEGER NOT NULL DEFAULT 0, expire_at INTEGER NOT NULL DEFAULT 0,
  reset_strategy TEXT NOT NULL DEFAULT 'none', note TEXT NOT NULL DEFAULT '',
  used_up INTEGER NOT NULL DEFAULT 0, used_down INTEGER NOT NULL DEFAULT 0,
  life_up INTEGER NOT NULL DEFAULT 0, life_down INTEGER NOT NULL DEFAULT 0,
  last_reset_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS report_seen(
  node_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY(node_id, seq)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS traffic_minute(
  ts INTEGER NOT NULL, node_id TEXT NOT NULL, user_id INTEGER NOT NULL, inbound TEXT NOT NULL, outbound TEXT NOT NULL,
  up INTEGER NOT NULL, down INTEGER NOT NULL, conns INTEGER NOT NULL,
  PRIMARY KEY(ts, node_id, user_id, inbound, outbound)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS traffic_hour(
  ts INTEGER NOT NULL, node_id TEXT NOT NULL, user_id INTEGER NOT NULL, inbound TEXT NOT NULL, outbound TEXT NOT NULL,
  up INTEGER NOT NULL, down INTEGER NOT NULL, conns INTEGER NOT NULL,
  PRIMARY KEY(ts, node_id, user_id, inbound, outbound)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS dim_hour(
  ts INTEGER NOT NULL, node_id TEXT NOT NULL, user_id INTEGER NOT NULL, inbound TEXT NOT NULL, outbound TEXT NOT NULL,
  host TEXT NOT NULL, port INTEGER NOT NULL, src_ip TEXT NOT NULL, network TEXT NOT NULL, rule TEXT NOT NULL,
  up INTEGER NOT NULL, down INTEGER NOT NULL, conns INTEGER NOT NULL,
  PRIMARY KEY(ts, node_id, user_id, inbound, outbound, host, port, src_ip, network, rule)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS dim_hour_user ON dim_hour(user_id, ts);
CREATE TABLE IF NOT EXISTS online_ip(
  user_id INTEGER NOT NULL, node_id TEXT NOT NULL, ip TEXT NOT NULL,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY(user_id, node_id, ip)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, user_id INTEGER NOT NULL DEFAULT 0,
  node_id TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
`

func openDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(10000)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	// One writer connection avoids SQLITE_BUSY storms; reads go through the same pool
	// but WAL lets them run alongside.
	db.SetMaxOpenConns(4)
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("schema: %w", err)
	}
	return db, nil
}

func getSetting(db *sql.DB, k string) (string, bool) {
	var v string
	if err := db.QueryRow(`SELECT v FROM settings WHERE k=?`, k).Scan(&v); err != nil {
		return "", false
	}
	return v, true
}

func setSetting(db *sql.DB, k, v string) error {
	_, err := db.Exec(`INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, k, v)
	return err
}

func now() int64 { return time.Now().Unix() }

func addEvent(db *sql.DB, kind string, userID int64, nodeID, detail string) {
	db.Exec(`INSERT INTO events(ts,kind,user_id,node_id,detail) VALUES(?,?,?,?,?)`, now(), kind, userID, nodeID, detail)
}
