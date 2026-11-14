package subgen

// Copied from sbpanel internal/master/sub.go (singboxOutbound, mihomoProxy).
func (e Endpoint) SingboxOutbound() map[string]any {
	o := map[string]any{"type": e.Type, "tag": e.Remark, "server": e.Address, "server_port": e.Port}
	tls := func() map[string]any {
		t := map[string]any{"enabled": true}
		if e.SNI != "" {
			t["server_name"] = e.SNI
		}
		if e.Insecure {
			t["insecure"] = true
		}
		if len(e.ALPN) > 0 {
			t["alpn"] = e.ALPN
		}
		if e.Security == "reality" {
			t["reality"] = map[string]any{"enabled": true, "public_key": e.PBK, "short_id": e.SID}
		}
		if e.FP != "" && (e.Security == "reality" || e.Type == "vless" || e.Type == "vmess" || e.Type == "trojan" || e.Type == "anytls") {
			t["utls"] = map[string]any{"enabled": true, "fingerprint": e.FP}
		}
		return t
	}
	transport := func() {
		switch e.Network {
		case "ws":
			t := map[string]any{"type": "ws", "path": e.Path}
			if e.Host != "" {
				t["headers"] = map[string]any{"Host": e.Host}
			}
			o["transport"] = t
		case "httpupgrade":
			o["transport"] = map[string]any{"type": "httpupgrade", "path": e.Path, "host": e.Host}
		case "http":
			t := map[string]any{"type": "http", "path": e.Path}
			if e.Host != "" {
				t["host"] = []string{e.Host}
			}
			o["transport"] = t
		case "grpc":
			o["transport"] = map[string]any{"type": "grpc", "service_name": e.Service}
		}
	}
	switch e.Type {
	case "vless":
		o["uuid"] = e.UUID
		if e.Flow != "" {
			o["flow"] = e.Flow
		}
		if e.Security != "" {
			o["tls"] = tls()
		}
		transport()
	case "vmess":
		o["uuid"], o["security"], o["alter_id"] = e.UUID, "auto", 0
		if e.Security != "" {
			o["tls"] = tls()
		}
		transport()
	case "trojan":
		o["password"] = e.Password
		o["tls"] = tls()
		transport()
	case "shadowsocks":
		o["method"], o["password"] = e.SSMethod, e.Password
	case "hysteria2":
		o["password"] = e.Password
		o["tls"] = tls()
	case "tuic":
		o["uuid"], o["password"], o["congestion_control"] = e.UUID, e.Password, e.CC
		o["tls"] = tls()
	case "anytls":
		o["password"] = e.Password
		o["tls"] = tls()
	}
	return o
}

func (e Endpoint) MihomoProxy() map[string]any {
	p := map[string]any{"name": e.Remark, "server": e.Address, "port": e.Port, "udp": true}
	tlsCommon := func() {
		if e.SNI != "" {
			p["servername"] = e.SNI
		}
		if e.Insecure {
			p["skip-cert-verify"] = true
		}
		if len(e.ALPN) > 0 {
			p["alpn"] = e.ALPN
		}
		if e.FP != "" {
			p["client-fingerprint"] = e.FP
		}
		if e.Security == "reality" {
			p["reality-opts"] = map[string]any{"public-key": e.PBK, "short-id": e.SID}
		}
	}
	network := func() {
		if e.Network != "" {
			p["network"] = e.Network
		}
		switch e.Network {
		case "ws", "httpupgrade":
			ws := map[string]any{"path": e.Path}
			if e.Host != "" {
				ws["headers"] = map[string]any{"Host": e.Host}
			}
			if e.Network == "httpupgrade" {
				p["network"] = "ws"
				ws["v2ray-http-upgrade"] = true
			}
			p["ws-opts"] = ws
		case "grpc":
			p["grpc-opts"] = map[string]any{"grpc-service-name": e.Service}
		case "http":
			p["network"] = "h2"
			h := map[string]any{"path": e.Path}
			if e.Host != "" {
				h["host"] = []string{e.Host}
			}
			p["h2-opts"] = h
		}
	}
	switch e.Type {
	case "vless":
		p["type"], p["uuid"] = "vless", e.UUID
		if e.Flow != "" {
			p["flow"] = e.Flow
		}
		if e.Security != "" {
			p["tls"] = true
			tlsCommon()
		}
		network()
	case "vmess":
		p["type"], p["uuid"], p["alterId"], p["cipher"] = "vmess", e.UUID, 0, "auto"
		if e.Security != "" {
			p["tls"] = true
			tlsCommon()
		}
		network()
	case "trojan":
		p["type"], p["password"] = "trojan", e.Password
		tlsCommon()
		if s, ok := p["servername"]; ok {
			delete(p, "servername")
			p["sni"] = s
		}
		network()
	case "shadowsocks":
		p["type"], p["cipher"], p["password"] = "ss", e.SSMethod, e.Password
	case "hysteria2":
		p["type"], p["password"] = "hysteria2", e.Password
		tlsCommon()
		delete(p, "client-fingerprint")
		if s, ok := p["servername"]; ok {
			delete(p, "servername")
			p["sni"] = s
		}
	case "tuic":
		p["type"], p["uuid"], p["password"], p["congestion-controller"] = "tuic", e.UUID, e.Password, e.CC
		tlsCommon()
		delete(p, "client-fingerprint")
		if s, ok := p["servername"]; ok {
			delete(p, "servername")
			p["sni"] = s
		}
	case "anytls":
		p["type"], p["password"] = "anytls", e.Password
		tlsCommon()
		if s, ok := p["servername"]; ok {
			delete(p, "servername")
			p["sni"] = s
		}
	}
	return p
}
