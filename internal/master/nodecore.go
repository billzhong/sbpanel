package master

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"sbpanel/internal/pb"
)

// nodeCore is the panel-wide tuning of the sing-box core every node runs (setting
// "node_core"). Zero values leave the template / sing-box / Go defaults alone.
type nodeCore struct {
	LogLevel     string `json:"log_level"`      // overrides the template's log.level
	TCPFastOpen  bool   `json:"tcp_fast_open"`  // on every inbound listener
	TCPMultiPath bool   `json:"tcp_multi_path"` // MPTCP on every inbound listener
	UDPTimeout   string `json:"udp_timeout"`    // UDP NAT session idle timeout, e.g. "5m"
	GOGC         int    `json:"gogc"`           // sbnode GC target percent
	MemLimitMB   int    `json:"mem_limit_mb"`   // sbnode soft memory limit
}

var logLevels = map[string]bool{"": true, "trace": true, "debug": true, "info": true, "warn": true, "error": true, "fatal": true, "panic": true}

func (c nodeCore) validate() error {
	if !logLevels[c.LogLevel] {
		return fmt.Errorf("Unknown log level")
	}
	if c.UDPTimeout != "" {
		d, err := time.ParseDuration(c.UDPTimeout)
		if err != nil || d < 10*time.Second || d > 24*time.Hour {
			return fmt.Errorf("UDP timeout must be a duration between 10s and 24h, e.g. 5m")
		}
	}
	if c.GOGC != 0 && (c.GOGC < 25 || c.GOGC > 1000) {
		return fmt.Errorf("GOGC must be 25-1000 (0 = default)")
	}
	if c.MemLimitMB != 0 && (c.MemLimitMB < 32 || c.MemLimitMB > 1<<20) {
		return fmt.Errorf("Memory limit must be at least 32 MB (0 = none)")
	}
	return nil
}

func validateNodeCore(v string) (string, error) {
	if v == "" {
		return "", nil
	}
	var c nodeCore
	if err := json.Unmarshal([]byte(v), &c); err != nil {
		return "", fmt.Errorf("node_core: %w", err)
	}
	if err := c.validate(); err != nil {
		return "", err
	}
	b, _ := json.Marshal(c)
	return string(b), nil
}

func loadNodeCore(db *sql.DB) nodeCore {
	var c nodeCore
	json.Unmarshal([]byte(settingOr(db, "node_core", "{}")), &c)
	return c
}

func (c nodeCore) applySkeleton(sk map[string]any) {
	if c.LogLevel == "" {
		return
	}
	lg, _ := sk["log"].(map[string]any)
	if lg == nil {
		lg = map[string]any{"timestamp": true}
		sk["log"] = lg
	}
	lg["level"] = c.LogLevel
}

// applyInbound adds the listener options an inbound does not set itself.
func (c nodeCore) applyInbound(opts map[string]any) {
	set := func(k string, v any) {
		if _, ok := opts[k]; !ok {
			opts[k] = v
		}
	}
	if c.TCPFastOpen {
		set("tcp_fast_open", true)
	}
	if c.TCPMultiPath {
		set("tcp_multi_path", true)
	}
	if c.UDPTimeout != "" {
		set("udp_timeout", c.UDPTimeout)
	}
}

func (c nodeCore) runtime() *pb.NodeRuntime {
	if c.GOGC == 0 && c.MemLimitMB == 0 {
		return nil
	}
	return &pb.NodeRuntime{Gogc: int32(c.GOGC), MemoryLimit: int64(c.MemLimitMB) << 20}
}
