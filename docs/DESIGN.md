# sbpanel 设计方案（v0.1 草案，2026-11-14）

> 代号 `sbpanel`，可以改名。这是一个以 sing-box 为内核、master 和 node 分离部署的代理管理面板，内置 Neko Master 那样的流量分析。
> 本文写的是调研结论和实施规划，带「❓」的地方需要你拍板。

---

## 0. 目标与非目标

**目标**
1. **master 和 node 是两个进程**，可以部署在同一台机器上，也可以分开。一个 master 管理 N 个 node。
2. **内核只用 sing-box 1.14.x**，以 Go 库的方式编进 node，不起子进程。
3. **流量统计内置**：每条连接都精确记账，维度包括用户、入站、出站、域名、目标 IP 和端口、来源 IP、规则。数据只从内核内部取，**不读日志，不用 conntrack**，然后汇总到 master。
4. **面板功能至少和 3x-ui 对齐**：用户、配额、到期、重置周期、订阅、节点、入站和出站配置、路由、DNS、内核参数、概览、在线 IP、限速、设备数限制、备份恢复、Telegram 通知。
5. **性能优先**：node 常驻内存 30–60 MB（主要是 sing-box 本身），每连接统计开销只有几次原子加；master 用一个 Go 二进制，前端静态资源编进去。
6. 界面风格参考 honk 的官方 Web UI **doona**（daeuniverse/honk 本身是 Rust eBPF 内核，没有 UI；README 里指向 doona）。

**非目标（v1 不做）**：Xray 和 mihomo 内核、计费商城、多租户代理商体系、TUN 透明代理。

---

## 1. 调研结论

### 1.1 sing-box 内核（已克隆 v1.14.4 源码，并写了 demo 实测）

| 问题 | 结论 | 依据 |
|---|---|---|
| 能否外部嵌入、挂自己的统计器 | **可以，不用 fork**。`box.New()` 之后 `inst.Router().AppendTracker(t)`，必须在 `Start()` 之前调用 | `adapter/router.go:108`、`route/router.go:239`、`box.go:243/438` |
| tracker 拿得到什么 | `InboundContext`：`User`、`Inbound`、`InboundType`、`Source`、`Destination`（Fqdn 或 IP）、`Domain`（嗅探出的 SNI 或 Host）、`Protocol`、`Outbound`、`OutboundChain`、`RouteRule`，外加命中的规则 | `adapter/inbound.go:47-119`、`route/route.go:161` |
| `User` 是否填充 | vless、vmess、trojan、hy2、tuic、ss 多用户、anytls、naive、shadowtls、socks、http **都会填**。**前提是用户的 `name` 非空** | 各 `protocol/*/inbound.go` |
| 实测 | vless→direct 通路，tracker 收到 `User=u1 Inbound=in Outbound=direct`；下行 100000 字节的 body 统计到 100138（含协议头），精确 | `scratchpad/embedtest/main.go` |
| 计数做法 | 参考 v2ray-api：每条连接只在建立时加一次锁查指针，之后用 `bufio.NewInt64CounterConn` 做**无锁原子加**，不破坏 splice/readv 快路径 | `experimental/v2rayapi/stats.go` |
| 热更新用户 | 只有 **Shadowsocks 多用户**有公开的 `UpdateUsers`（`adapter.ManagedSSMServer`）。vless、vmess、trojan、tuic、hy2 只在构造函数里设置一次用户，字段未导出 | `adapter/ssm.go`、`protocol/vless/inbound.go:63` |
| 单独重建一个入站 | `InboundManager` **没有 Remove**。实测可以绕开：用 `InboundRegistry.Create` 自己建入站，放进单独的 `adapter.Scope` 里启动，`scope.Close()` 只停这一个入站，其它入站不受影响 | demo 实测 |
| 限速和配额 | **内核没有**。要在 tracker 里自己包一层令牌桶 | — |
| 编译 | Go 1.25.5；tags：`with_quic`（hy2、tuic）、`with_utls`（Reality）、`with_clash_api`（可选）、`with_acme`、`with_gvisor`（TUN 用，不需要）；ldflags `-checklinkname=0` | `release/DEFAULT_BUILD_TAGS_OTHERS` |

**S-UI 的做法**：同样嵌入 sing-box、`AppendTracker`、每 10 秒 `Swap(0)` 收取计数。用户热更新是 **fork 了各协议的入站**，加上 `UpdateUsers` 实现的（`core/protocol/*`），失败时退回重建单个入站。这说明「打小补丁导出 UpdateUsers」这条路走得通。

### 1.2 master 和 node 架构对比

| 项目 | 谁发起连接 | 传输和认证 | 用户同步 | 流量上报 | 主要缺点 |
|---|---|---|---|---|---|
| **Remnawave** | master → node | HTTPS + **mTLS（面板自签 CA）** + RS256 JWT，一段 blob 完成接入 | 全量下发 + 增量增删用户；**按 hash 判断是否需要重启内核** | master 每 15 秒拉取，reset=true | 读取即清零，响应丢了流量就丢了 |
| **PasarGuard** | master → node | gRPC/REST，固定证书 + api-key | 声明式 `User{proxies, inbounds[]}`，支持分块流式同步 | 每 10 秒拉取，reset=true | 同上；另有 keep-alive 租约，超时就停内核 |
| **3x-ui nodes** | master → node | HTTPS，tls 支持 pin/mtls，分作用域 token | 标记脏数据 + `ReconcileNode` 对齐 | **拉取绝对值，与基线做差**；重置操作先存 pending，之后重放 | 每 5 秒轮询 |
| **V2bX ↔ Xboard** | **node → master** | URL 里带 token | 拉取用户列表，**ETag + 304**，本地做差后增删 | POST `{uid:[up,down]}` | 推送失败只记日志，流量丢失 |
| **Neko Master** | agent → master | Bearer token | — | **delta + requestId 去重**，gzip，失败后带同一个 id 重试，队列有上限 | 去重表只在内存里 |

**取长补短**：
- 采用 Neko 和 V2bX 的方向：**node 主动连 master**。node 可以在 NAT 后面，不需要开管理端口。
- 认证和加密用 Remnawave 的 **mTLS + 一段式接入**。
- 用户同步用 Remnawave 的 **hash 判定是否重启**，加上 PasarGuard 的**声明式期望状态**。
- 流量上报用 Neko 的 **requestId 幂等**，并且做成**持久化 seq + 确认后才删除**。这样就补上了所有现有方案都有的「reset-on-read 丢流量」问题。

---

## 2. 总体架构

```
             浏览器 (React SPA，编进 master)
                    │ HTTPS  /api/*  + SSE 推送
┌───────────────────▼────────────────────────────────────────┐
│ master (Go 单二进制)                                         │
│  ├ REST API (chi) + 鉴权 (session + 2FA + API token)        │
│  ├ 订阅服务 /s/<token>（可单独监听端口，和面板域名分开）        │
│  ├ NodeHub：gRPC server，维护每个 node 的长连接双向流          │
│  ├ Reconciler：为每个 node 计算 NodeSpec(revision)，下发期望状态 │
│  ├ Ingest：收 TrafficReport → 幂等落库 → 累加用量 → 判定配额    │
│  ├ Policy：到期 / 超额 / 重置周期 / 设备数 → 触发修订           │
│  ├ Rollup：分钟 → 小时 → 天 降采样，按保留期清理                │
│  ├ Notifier：Telegram / Webhook                             │
│  └ Store：SQLite(WAL, 默认) | PostgreSQL（可选）              │
└───────────────────▲────────────────────────────────────────┘
                    │ gRPC over TLS 1.3, mTLS（node 主动连 master）
       ┌────────────┴─────────────┬──────────────────┐
┌──────┴───────────────┐  ┌───────┴──────┐   ┌──────┴──────┐
│ node (Go 单二进制)    │  │ node ...     │   │ node ...    │
│  ├ Agent：连接、心跳、 │  └──────────────┘   └─────────────┘
│  │  断线重连、期望状态 │
│  ├ CoreManager：内嵌   │
│  │  sing-box，按入站   │
│  │  scope 管理热更新   │
│  ├ Tracker：每连接计数 │
│  │  + 限速 + 踢线      │
│  ├ Aggregator：10s 汇总│
│  ├ Spool (bbolt)：未确认│
│  │  的报告落盘         │
│  └ 本地只读状态页/CLI  │
└──────────────────────┘
```

**进程边界**
- master 不运行任何代理流量。
- node 不保存业务数据，只缓存「最后一次成功应用的期望状态」和「还没被确认的流量报告」。
- master 宕机时 node **按最后一份已知可用的配置继续服务**，流量在本地落盘，master 恢复后补传。
- 单机部署：同一台机器上跑 master 和 node，node 通过 `127.0.0.1` 连 master，流程完全一样，没有特殊分支。

---

## 3. node 设计

### 3.1 CoreManager：内嵌 sing-box，尽量不重启

把 sing-box 配置拆成两部分：
- **骨架**：log、dns、route、outbounds、endpoints、experimental。
- **入站**：每个入站带自己的用户列表。

node 维护：
```
box        *box.Box              // 骨架实例（不含入站，或只含静态入站）
inbounds   map[tag]*inboundSlot  // 每个入站一个 slot
inboundSlot{ scope adapter.Scope; in adapter.Inbound; specHash, usersHash string }
```

收到新的期望状态时，比较 hash，决定动作：

| 变化 | 动作 | 影响 |
|---|---|---|
| 骨架 hash 变了（路由、DNS、出站） | 重建整个 box，**蓝绿切换**：先建好新实例，再关旧实例 | 所有连接断开一次（同 3x-ui 重启 Xray） |
| 某个入站的配置变了（端口、TLS、传输层） | 只重建这一个入站的 scope | 只断这个入站的连接 |
| 只有用户集合变了 | **热更新**（见下），不断任何人 | 无感 |
| 用户被禁用、删除或超额 | 热更新之后，tracker **主动关闭该用户的存量连接** | 只断这个用户 |

**用户热更新怎么实现** ❓（决策 D1）
- **方案 A，推荐**：用 `go.mod replace` 指向一个**很薄的 sing-box 补丁分支**。补丁只给 vless、vmess、trojan、tuic、hysteria2、anytls、naive 加一个带锁的 `UpdateUsers()` 导出方法，每个协议约 20–40 行。S-UI 已经证明这条路可行。每次升级 sing-box 时 rebase 一次，补丁很小，冲突概率低。
- **方案 B**：不 fork，用户变化时**重建该入站的 scope**（demo 已验证）。代价是这个入站的连接全部断一次，而且有毫秒级的监听空窗。
- 落地方式：**先实现 B 作为通用兜底，再给常用协议补上 A**；Shadowsocks 直接用官方的 `UpdateUsers`。
- 用户变更做**合批**：500 ms 防抖，避免批量导入时反复重建。

### 3.2 Tracker：计数、限速、踢线，单一入口

`AppendTracker(t)`，在 `RoutedConnection` 和 `RoutedPacketConnection` 里：
1. 用 `metadata.User` 查到 `userState`（`sync.Map`，内含 `up/down *atomic.Int64`、限速桶、活跃连接集合）。
2. 生成 `connRecord{id, user, inbound, outbound, chain, rule, network, src, dstHost, dstIP, dstPort, start, up/down atomic}`，登记到活跃表。
3. 包装连接：
   - 计数用 `bufio.NewInt64CounterConn`，传入多个计数器（连接、用户、入站、出站），一次包装同时累计。
   - 用户配了限速时，再套一层 `rate.Limiter`（令牌桶，按用户共享，按上行和下行分开）。
   - 关闭时回调：从活跃表移到 `closed` 队列。
4. `KickUser(user)`：遍历这个用户的活跃连接并 `Close()`。用户禁用、超额、超过设备数时由 master 触发。
5. 设备数限制：node 本地按「用户 → 活跃来源 IP 集合」统计。超出时新连接直接拒绝（返回已关闭的 conn），同时把在线 IP 上报给 master，由 master 做跨节点判定。

`host` 维度的取值顺序：`metadata.Domain`（嗅探结果）→ `Destination.Fqdn` → 目标 IP。所以**骨架配置里必须默认加 sniff 路由动作**。

### 3.3 Aggregator 与 Spool：流量一字节都不丢

每 10 秒（可配置）执行一次：
- 对**活跃连接**取当前计数，减去上次快照，得到 delta。
- 对**已关闭连接**取最终计数，减去上次快照，然后从表里删除。
- 按维度键累加：
  - `UserStat{user, inbound, outbound, up, down, conns}`：精确值，用于计费。
  - `DimStat{user, inbound, outbound, host, dst_port, src_ip, network, rule, up, down, conns}`：用于分析。
- **控制基数**：每个周期内每个用户只保留按字节排名前 200 的 host，其余合并为 `(other)`。src_ip 同理。可配置。
- 打包成 `TrafficReport{node_id, seq, boot_id, window_start, window_end, users[], dims[], online[]}`。
  - `seq` 单调递增，持久化保存。
  - 写入 **bbolt spool**，**先落盘，再发送**。
- 发送：按 seq 顺序推送尚未确认的报告。master 回 `Ack{seq}` 之后才删除本地记录。
- 断线期间 spool 持续积累。超过上限（默认 200 MB 或 7 天）时，把最老的报告**合并成更粗的时间窗**，不直接丢弃。
- 进程重启：读取 spool 中最后一个 seq 接着递增；内存计数归零是正常的，因为每份报告都是 delta。

> 和 xmon 的根本区别：所有数据都来自内核里的连接对象，字节、用户、域名在同一条记录里，不需要 join 日志，也不需要 conntrack。

### 3.4 实时视图（按需开启）

master 页面打开「实时连接」时，向 node 下发 `WatchConnections{filter}`，node 每秒推送活跃连接快照（类似 Clash `/connections`，多了 user 字段）。页面关闭后停止，平时不占带宽。也支持从页面直接断开某条连接。

### 3.5 node 本地能力
- `sbnode status`：显示连接状态、applied revision、spool 积压、内核版本。
- `sbnode enroll <master-url> <token>`：首次接入。
- `sbnode check-config`：用 sing-box 校验当前期望状态。
- 系统指标：CPU、内存、网卡速率、连接数、负载，每 10 秒随心跳上报，概览页用。

---

## 4. master ⇄ node 协议

**传输**：gRPC，TLS 1.3，mTLS。

**接入流程（enrollment）**
1. 在面板上「添加节点」，生成一次性 token（15 分钟有效），连同 master 地址和 CA 指纹拼成一行安装命令。
2. node 执行 `sbnode enroll`：本地生成 ed25519 密钥，向 master 发送 CSR 和 token。
3. master 用自签 CA 签发证书，有效期 90 天，SAN 为 `node:<id>`。node 到期前自动续签。
4. 之后所有连接都用这张证书做 mTLS。吊销节点等于把证书序列号加入黑名单。

**接口**（`proto/node/v1/node.proto` 草案）
```proto
service NodeHub {
  // node 发起，长连接双向流；控制面的全部交互都走这里
  rpc Connect(stream NodeMsg) returns (stream MasterMsg);
  // 大块数据走单独的一元调用，避免阻塞控制流
  rpc PushTraffic(TrafficReport) returns (Ack);
  rpc FetchSpec(FetchSpecReq) returns (stream SpecChunk);
}
message NodeMsg { oneof m {
  Hello hello;            // node_id, boot_id, version, singbox_version, applied_revision, hashes
  Heartbeat hb;           // sys metrics, applied_revision, spool_backlog
  ApplyResult apply;      // revision, ok, error, per-inbound result
  OnlineSnapshot online;  // user -> [ip], TTL 60s（软状态，不进 spool）
  ConnSnapshot conns;     // 仅在 Watch 时推送
}}
message MasterMsg { oneof m {
  SpecAvailable spec;     // revision + hashes，node 自行 FetchSpec（全量或增量）
  UserDelta delta;        // revision, upserts[], removes[]（小改动直接推送）
  Kick kick;              // users[] / conn_ids[]
  Watch watch; Unwatch unwatch;
  Ping ping;
}}
```

**期望状态同步（声明式，带修订号）**
- master 给每个 node 维护 `revision`（单调递增）和 `NodeSpec`：骨架、入站列表、每个入站的用户集合，以及对应的 hash。
- 有变化时 revision 加 1。
  - 如果只是少量用户变化，且 node 的 `applied_revision == revision-1`，直接推送 `UserDelta`。
  - 否则推送 `SpecAvailable`，由 node 拉取全量 spec（分块）。
- node 应用完成后回 `ApplyResult`。失败时保持旧状态，master 页面上把节点标红并展示错误。
- 断线重连时 `Hello` 会带上 `applied_revision` 和 hashes，master 比对后决定是补增量还是下发全量，**不需要额外的脏标记**。
- master 在一次事务里合并多处修改（比如批量改用户），只生成一个 revision。

**流量上报的幂等**
master 在**同一个事务**中执行：
```sql
INSERT INTO report_seen(node_id, boot_id, seq) ... ON CONFLICT DO NOTHING
-- 只有插入成功才继续：
UPDATE user_usage SET up=up+?, down=down+? ...
INSERT INTO traffic_minute ... ON CONFLICT DO UPDATE SET up=up+excluded.up ...
```
然后回 Ack。重复的报告直接回 Ack，不会重复计入。
`report_seen` 只保留 14 天，用 `(node_id, seq)` 做主键，同时记录 `max_seq`。

---

## 5. 数据模型（master）

```
admins(id, username, pass_hash, totp_secret, role, created_at)
api_tokens(id, name, hash, scopes, last_used_at)

nodes(id, name, address_hint, cert_serial, status, traffic_multiplier,
      traffic_limit, reset_day, applied_revision, last_seen, sys_json, tags)
node_templates(id, name, skeleton_json)          -- 路由/DNS/出站骨架，可多个 node 共用
inbounds(id, node_id|template_id, tag, type, listen_port, settings_json, enabled)
                                                 -- 服务端入站（真正监听的）
outbounds / route_rules / dns_servers / rule_sets -- 结构化存储，编辑器生成 skeleton

groups(id, name)                                 -- = Remnawave 的 squad：决定哪些用户上哪些入站
group_inbounds(group_id, inbound_id)
users(id, name, sub_token, status{active,disabled,limited,expired},
      traffic_limit, reset_strategy{none,day,week,month,month_rolling},
      reset_anchor, expire_at, device_limit, speed_up, speed_down,
      note, tg_chat_id, created_at, sub_revoked_at)
user_credentials(user_id, uuid, password, ss_key, flow)   -- 一个用户一套凭据，各协议共用
user_groups(user_id, group_id)
user_usage(user_id, period_start, up, down)       -- 当前计费周期
user_usage_lifetime(user_id, up, down)

hosts(id, inbound_id, remark, address, port, sni, host, path, alpn,
      fingerprint, reality_pbk_override, mux_json, sort, enabled, groups_filter)
                                                 -- 订阅里客户端看到的地址，和服务端入站解耦（CDN、中转、多域名）
sub_templates(id, client_kind{singbox,mihomo,xray,base64}, body)

report_seen(node_id, boot_id, seq, ts)
traffic_minute(ts, node_id, user_id, inbound, outbound, up, down, conns)  -- 精确值
traffic_hour  (同上，按小时)   traffic_day (同上，按天)
dim_hour(ts, node_id, user_id, inbound, outbound, host, port, src_ip, rule, up, down, conns)
online_ip(user_id, node_id, ip, first_seen, last_seen)   ipinfo(ip, asn, org, country, city)
events(ts, kind, user_id, node_id, ip, detail)   -- new_ip / quota / expire / rate / node_down
audit_log(ts, admin_id, action, target, diff)
settings(key, value)
```

**保留期**（默认值，可配置）
- `traffic_minute`：3 天
- `traffic_hour`：400 天
- `traffic_day`：永久
- `dim_hour`：90 天（每小时每用户只保留前 500 个 host，其余合并为 other）
- 估算：10 个用户、5 个节点时，dim_hour 一年约 20M 行以内，SQLite 能承受。规模再大时 ❓（决策 D2）可以切到 Postgres；ClickHouse 留作扩展点，Store 层抽象成接口。

---

## 6. 策略引擎（master）

- 每次收到流量报告后**增量判断**是否超额，不需要轮询。到期和重置周期由 30 秒一次的定时器检查。
- 状态切换：超额 → `limited`，到期 → `expired`，管理员禁用 → `disabled`。切换后在用户集合中移除该用户，生成新 revision，同时发送 `Kick`。
- 重置周期：日、周、月、按注册日滚动月。重置**只在 master 侧开启新的计费周期**，**从不向 node 下发 reset**，所以不存在「重置命令丢失」的问题。
- 设备数：master 汇总所有节点的在线 IP（60 秒 TTL）。超过限制时按策略处理（❓ 拒绝新 IP，或者踢掉最早的 IP），由 node 执行。
- 节点级配额：节点有自己的月流量上限和重置日，到 80% 和 100% 时通知（对应你在 dmit 上的 500 GB 场景）。
- 告警：新 IP 登录、持续高速率（xmon 里已有的逻辑迁移过来）、节点离线、证书即将过期、spool 积压。渠道：Telegram 和 Webhook。

---

## 7. 订阅

- 地址：`https://<sub-domain>/s/<sub_token>`，可以绑定**独立端口和域名**，和面板分开。sub_token 可以随时重置，即吊销旧链接。
- **根据 User-Agent 返回不同格式**，也可以用 `?format=` 强制指定：
  - sing-box JSON（SFA、SFI、Hiddify、NekoBox 等）
  - mihomo/Clash YAML（Clash Verge、Stash、OpenClash）
  - base64 URI 列表（v2rayN、Shadowrocket）
  - Xray JSON
- 响应头：`subscription-userinfo`（upload、download、total、expire）、`profile-update-interval`、`content-disposition`。
- 生成逻辑：用户 → 所属分组 → 分组包含的入站 → 这些入站的 hosts（按 sort 排序，可以按分组过滤）→ 用模板渲染。
- 订阅访问日志：记录 UA、IP 和时间，用来识别「谁在用这个订阅」。这正是前面排查 43.132.141.x 时缺少的能力。
- 用户自助页：浏览器打开订阅链接时显示一个精简页面，包含用量、到期时间、二维码和各客户端一键导入。

---

## 8. 前端

**技术栈**：React 19、Vite、TypeScript、**react-aria-components**（和 doona 一样，交互和无障碍有保证）、**Tailwind CSS v4**（把 doona 的 `--rp-*` token 映射成 Tailwind 主题变量，不照搬它 1 万行手写 CSS）、TanStack Router 和 Query、d3-shape 自绘 SVG 图表（和 doona 一样轻；需要热力图时再考虑 ECharts 按需引入）、CodeMirror 6（编辑原始 JSON）、i18n 中英。
API 类型从 OpenAPI 生成（openapi-typescript + openapi-fetch），后端是唯一的事实来源。实时数据用 SSE。

**沿用 doona 的视觉和交互**
- 色板：默认 Rosé Pine（Dawn 亮色 / Moon 暗色），token 角色分为 base、surface、overlay、text、subtle、accent，另保留 2–3 套备选色板。
- 卡片：16px 圆角、1px 细边、几乎不用阴影；控件高 32px；4px 网格；正文 14/20；按钮为胶囊形。
- 布局：顶栏（全局搜索 ⌘K、「待应用 N 项」按钮、主题、语言）加 240px 可折叠侧栏分组。手机上侧栏变成底部 Hub 栏，表格变成卡片。
- **修改先暂存，再统一应用**：对内核配置的修改先存为草稿，顶栏点「应用 (N)」时一次生成 revision 并下发，支持 diff 预览。离开页面前如有未应用的草稿会提示。用户增删改这类**即时生效**的操作不走草稿。
- 快捷键：`?` 打开帮助、`/` 聚焦过滤、`g` + 字母跳转页面。
- 详情用侧边面板：宽屏右侧滑出，窄屏改为抽屉。

**页面结构**

| 分组 | 页面 | 内容 |
|---|---|---|
| 观测 | **概览** | 全局 KPI（今日、本月流量，在线用户数，实时速率，节点健康）、流量趋势、Top 用户、Top 域名、节点卡片墙（CPU、内存、速率、配额进度） |
| | **流量分析** | 维度切换（用户、节点、入站、出站、域名、来源 IP、端口、规则）× 时间粒度（1m、5m、1h、1d）× 时间范围；堆叠面积图 + 占比条 + 可下钻的明细表；支持「用户 X 在节点 Y 访问了哪些域名」这种交叉筛选 |
| | **实时连接** | 选择节点后实时显示连接列表，可以过滤和断开 |
| | **事件** | 新 IP、超额、到期、节点上下线、审计日志 |
| 用户 | **用户** | 表格（状态、用量进度条、到期时间、在线设备数），批量创建、导入、编辑；详情面板显示用量曲线、在线 IP 及归属、订阅访问记录、Top 域名 |
| | **分组** | 分组和入站的映射 |
| | **订阅** | hosts 编辑（拖拽排序）、模板、订阅域名和端口、预览（模拟某个 UA 查看输出） |
| 节点 | **节点** | 节点卡片、接入向导（一行安装命令）、revision 和应用状态、版本、证书、配额 |
| | **入站** | 按协议分类的表单向导（Reality 一键生成密钥对和 shortId，ACME 和证书选择），高级模式可直接编辑 JSON |
| | **出站与路由** | 出站（直连、阻断、socks、ss、wg、selector、urltest 链式）、规则列表拖拽排序、rule-set 管理、规则测试（输入域名查看命中哪条规则） |
| | **DNS** | 服务器、规则、FakeIP 开关 |
| 系统 | **内核设置** | 日志级别、sniff、TCP fast open、多路复用默认值、sing-box 版本信息 |
| | **系统设置** | 管理员与 2FA、API token、通知渠道、备份恢复（一键导出 SQLite、定时备份到 TG）、保留期、面板路径和端口、证书 |

---

## 9. 与 3x-ui 的功能对齐清单

| 3x-ui 能力 | sbpanel 对应 | 版本 |
|---|---|---|
| 多协议入站（vless/vmess/trojan/ss/hy2/tuic/wg…） | sing-box 支持的全部服务端协议 + Reality、ShadowTLS、AnyTLS | M2 |
| 客户端：流量限额、到期、重置、启停 | 用户 + 策略引擎，状态机更完整 | M2 |
| 在线 IP、IP 数限制 | 跨节点设备数限制 | M3 |
| 订阅（含 JSON 订阅） | 多格式 + UA 识别 + hosts 抽象 + 自助页 | M2 |
| 多节点 | 原生 master/node，node 主动连接 | M1 |
| 流量统计 | 精确到用户 × 节点 × 入站 × 出站 × 域名 × 来源 IP | M1–M3 |
| 路由/出站/DNS 模板 | 结构化编辑器 + 原始 JSON | M3 |
| Telegram bot | 通知 + 查询指令（用量、到期） | M4 |
| 备份恢复、2FA、面板路径 | 有 | M4 |
| 证书（ACME） | sing-box 内置 ACME + 面板管理 | M3 |
| **3x-ui 没有的** | 域名级流量分析、实时连接、订阅访问审计、修改暂存+diff、按用户限速、流量不丢的上报链路 | — |

---

## 10. 仓库结构

```
sbpanel/
  cmd/sbmaster/  cmd/sbnode/
  proto/node/v1/*.proto           (buf 生成 Go 代码)
  internal/master/{api,hub,reconcile,ingest,policy,rollup,sub,notify,store}
  internal/node/{agent,core,tracker,aggregate,spool,sysinfo}
  internal/shared/{spec,hash,pki,version}
  third_party/sing-box -> go.mod replace 到补丁分支（D1 选方案 A 时）
  web/                            (React 应用，构建产物 embed 进 sbmaster)
  deploy/{systemd,docker,install.sh}
  docs/
```
构建：`make` 产出 `sbmaster` 和 `sbnode`（linux/amd64、arm64，CGO=0，纯 Go 的 SQLite 用 modernc）。前端构建产物在 `go:embed` 前生成。CI 跑 Go 测试、前端测试，以及一个**端到端测试**：本地起 master 和 node，用 sing-box 客户端发流量，断言用量精确。

---

## 11. 里程碑

| 阶段 | 交付 | 验收 |
|---|---|---|
| **M0 骨架**（约 1 周） | 仓库、proto、master/node 二进制、enrollment + mTLS、心跳 | 面板上能看到节点在线 |
| **M1 内核 + 统计闭环** | node 内嵌 sing-box、单入站 vless-reality、tracker、aggregator、spool、幂等 ingest、概览和流量页初版 | 端到端测试：发 100 MB，master 记账误差为 0；kill master 10 分钟再恢复，流量不丢 |
| **M2 用户与订阅** | 用户 CRUD、分组、凭据、配额、到期、重置、热更新（B + SS），多协议入站表单，hosts、订阅多格式 | 新建用户 → 5 秒内能连上；超额后立刻断线 |
| **M3 配置与分析** | 出站、路由、DNS 编辑器，暂存 + diff + 应用，蓝绿重建；域名、来源 IP 维度分析，实时连接，在线 IP 与设备数限制，ACME | 和 3x-ui 日常功能对齐 |
| **M4 运维** | 补丁版 UpdateUsers（方案 A）、限速、TG 通知、备份、2FA、审计、i18n、移动端 | 能在 dmit 上替换 3x-ui 试运行 |
| **M5 迁移** | 从 3x-ui 导入（用户、UUID、subId 保持不变，订阅链接不变） | 客户端无感切换 |

---

## 12. 风险与待决

| # | 问题 | 建议 |
|---|---|---|
| D1 | 用户热更新：打薄补丁（A）还是只做单入站重建（B） | 先做 B，M4 补上 A |
| D2 | 默认用 SQLite 还是 Postgres | 默认 SQLite（单文件、易备份），Store 接口同时支持 Postgres；dmit 上已有 Postgres，可以直接复用 |
| D3 | 设备数超限：拒绝新 IP，还是踢掉最早的 IP | 默认拒绝新 IP |
| D4 | 项目名、仓库位置（建议 `~/Code/sbpanel`，私有 GitHub 仓库） | 你定 |
| D5 | 迁移：是否要保留现有 3x-ui 的 UUID 和 subId，让客户端零改动 | 建议保留（M5） |
| R1 | sing-box 每个大版本都可能改内部 API（1.11 和 1.14 都改过 lifecycle） | 锁定小版本；补丁尽量小；e2e 测试覆盖入站热更新 |
| R2 | `name` 为空时 `metadata.User` 为空 | 下发时强制 `name = user_id` |
| R3 | 域名维度依赖嗅探 | 骨架配置强制加 sniff；嗅探不到的连接归到目标 IP |
| R4 | 嵌入 sing-box 后 node 二进制约 40–60 MB | 可接受 |
