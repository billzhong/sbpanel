# 域名、证书与连通性测试

面板页面：**节点与内核 → 域名与证书**（⌘K 搜「证书」，快捷键 `g c`）。首次使用有四步向导，每一步都可以跳过。

## 1. 三种证书来源

| 来源 | 谁签发 / 续期 | 证书放在哪 | 面板能做什么 |
|---|---|---|---|
| **ACME 自动**（`acme`） | master 用 ACME DNS-01（Cloudflare）向 Let's Encrypt / ZeroSSL 申请；到期前 30 天自动续期 | 加密存在 master；随期望状态下发到用到它的节点 | 签发、续期、下载、单域名或通配符、staging 测试 |
| **上传 PEM**（`upload`） | 你自己；到期前提醒 | 同上 | 校验私钥是否匹配、是否过期，展示 SAN 和到期；可「替换为新证书」 |
| **节点文件**（`node`） | 节点上的 certbot（或你的脚本） | 节点本地，例如 `/etc/letsencrypt/live/<名称>/fullchain.pem` | 只引用路径；节点读取文件并上报 SAN / 到期 / 指纹，快到期时提醒 |

入站通过面板提示键引用证书：`options._cert = "<证书 id>"`（和 `_flow`、`_proxy_protocol` 一样，以 `_` 开头的键不会下发给 sing-box）。
入站编辑器 TLS 部分的「证书来源」：**面板证书**（选择）/ **节点文件**（路径）/ **节点自动申请**（sing-box 自带 ACME，需要 80/443 可达）。
需要 TLS 的模板会在已有面板证书覆盖 SNI 时默认选中它；向导第 2 步配置过的域名会自动填为 SNI。

## 2. 数据模型（master，schema v6）

```
dns_providers(id, kind='cloudflare', name, token_enc, zones_json, verified_at, last_error)
domains(id, fqdn, provider_id, zone_id, zone, node_id, record_type, record_id, record_content, proxied, synced_at)
certs(id, name, source, sans_json, issuer, not_before, not_after, fingerprint, cert_pem, key_enc,
      auto_renew, acme_json{provider_id, ca, staging, email, domains}, node_id, cert_path, key_path,
      last_error, attempts, next_attempt, warned_at, renewed_at, reported_at)
probe_results(inbound_id, endpoint, ts, ok, result_json)
```

**静态加密**：Cloudflare 令牌、证书私钥、ACME 账户私钥用 AES-256-GCM 加密（`v1:` + base64(nonce‖密文)，附加数据绑定用途和行号，密文不能挪到别的行）。
密钥是 `{DataDir}/secret.key`（32 字节，0600），**不在数据库里**：只拿到数据库或备份无法解密。备份时要**同时备份 `secret.key`**，否则恢复后需要重新粘贴令牌、重新签发/上传证书。
API 永远不返回令牌明文，只有 `token_set` 和令牌能访问的区域。

## 3. 下发与轮换（不重建入站）

```
master buildSpec(node)
  inbound 有 _cert=c1（acme/upload）→ InboundSpec.cert_id = "c1"；tls 里的 certificate_path/key_path/acme 被去掉
                                    → NodeSpec.certs += CertBundle{id:"c1", hash}（只发给用到它的节点）
  inbound 有 _cert=c2（node）        → tls.certificate_path / key_path 直接写成节点上的路径
  节点的 node 证书                  → NodeSpec.watch_certs（节点读取并上报）
数据库里存的 spec_pb 只有 id + hash；FetchSpec 时才解密并填入 PEM。
```

节点应用 spec 时先写证书：`{节点目录}/certs/<id>.key` 再 `<id>.crt`，都是 0600、同目录写临时文件后 rename（原子替换）；然后启动入站时把 `certificate_path/key_path` 指向这两个绝对路径。

**续期 / 替换只改变 CertBundle 的 hash**：入站的 `options_hash` 只包含证书 id，不包含证书内容，所以入站不会重建；节点只替换文件，sing-box 的 `common/tls` 用 fswatch 监视证书目录，检测到 Create/Write 后重新加载证书（`STDServerConfig.certificateUpdated`），新的 TLS 握手立刻使用新证书，已有连接不断。
E2E 测试 `TestPanelCertRotation` 验证了：文件被替换、`CoreStats()` 的重建次数不变、新握手出示新证书指纹、流量继续。

## 4. 续期调度

master 每分钟运行一次 `certManager.tick`（时钟和签发器都可注入，单元测试用假时钟和假签发器）：

- ACME 证书：还没签发，或 `auto_renew` 且剩余 ≤30 天，并且已过 `next_attempt` → 签发。
- 失败：`attempts+1`，按 10 分钟、20、40 … 最长 24 小时退避；记录 `last_error`；事件 `cert_renew_failed`。
- 成功：保存新证书（清空错误和退避），事件 `cert_renewed`，对用到它的节点 reconcile（只换文件）。
- 所有来源：剩余 ≤14 天（或已过期）每天一次 `cert_expiring` 事件（上传的提示手动替换，节点文件的提示检查 certbot）。
- 「立即续期」：ACME 证书后台签发；节点文件证书会请节点立刻重新读取文件。

签发流程：`acmez` + certmagic 的 `DNS01Solver`，DNS 提供者是面板自己的 Cloudflare 客户端（只添加/删除自己的 `_acme-challenge` TXT）。ACME 账户密钥按「目录 + 邮箱」加密保存在 settings。ZeroSSL 通过邮箱自动获取 EAB。staging 证书不受信任，只用来演练流程。

事件已加入「设置 → 通知」：证书即将过期、证书续期失败、证书已续期、入站不可达、入站恢复。

## 5. 域名与 DNS（Cloudflare）

令牌权限：**区域 · DNS · 编辑** + **区域 · 区域 · 读取**（Cloudflare 模板「编辑区域 DNS」），区域资源选需要的域名。
面板验证令牌（`/user/tokens/verify`，账户令牌回退为能列出区域即可）并列出区域。

- 添加域名不会修改 DNS。
- 「同步 DNS」= **预览**（`POST /api/dns/plan`，只读）→ 对话框列出新建 / 修改前后 / 同名其它记录（不动）→ **确认**（`POST /api/dns/apply`）。
- apply 会重新预览，记录在两次之间变化了就拒绝（409）；最多改一条 A/AAAA 记录；有 CNAME 或多条同类型记录时视为冲突，面板不处理。
- 橙色云朵（proxied）会提示：只有 WS / gRPC / HTTPUpgrade + TLS 能经过 Cloudflare；REALITY、Hysteria2、TUIC 会失效。
- 从面板移除域名不会删除 DNS 记录。

## 6. 连通性测试（面板 → 节点入站）

在「入站」页每行的健康点 / 脉冲按钮、「全部测试」，以及节点卡片菜单「测试连通性」。

- 端点和订阅完全一致：入站的每个 Host（地址、端口、SNI 覆盖），没有 Host 时用节点公网地址 + 端口。
- 探测用户：`buildSpec` 给每个入站注入名为 `__probe` 的用户（UUID / 密码按节点从 `probe_secret` 派生）。名字不是数字，不可能和面板用户冲突；节点 tracker 不计数、不算在线；master ingest、在线 IP、实时连接都会忽略它；订阅和用户列表里没有它。
- 阶段：DNS → TCP 连接（Hysteria2 / TUIC 改为 QUIC 握手）→ TLS 握手（校验证书链和 SNI；面板证书按指纹信任，自签名也可以；REALITY 跳过，因为普通握手只会到伪装站）→ 用 master 内嵌的 sing-box 客户端（与订阅相同的出站配置）经入站请求探测地址（默认 `https://www.gstatic.com/generate_204`，失败再试备用地址）。
- 错误解释：域名解析失败、端口未开放（拒绝连接）、连接超时（被过滤）、SNI 与证书不匹配、证书不受信任 / 过期、REALITY 认证失败、入站关闭连接（认证失败或协议不一致）、代理请求超时（节点出网受限）等。解析到 `198.18.0.0/15` 时提示 master 所在机器开着代理的 fake-ip 模式。
- 结果缓存在 `probe_results`；可选定时检查（关闭 / 5 / 15 / 60 分钟），入站整体状态变化时产生 `inbound_unreachable` / `inbound_recovered` 事件。

> master 因此链接了 sing-box（之前只有节点链接），二进制约大 20 MB。

## 7. API 一览

| 路由 | 权限 |
|---|---|
| `GET /api/certs`、`GET /api/certs/{id}`、`GET /api/certs/match?host=&node=`、`GET /api/certs/certbot?node=`、`GET /api/certs/{id}/download`（证书链） | read |
| `POST /api/certs/upload`（`dry_run` 只校验）、`POST /api/certs/acme`、`POST /api/certs/node`、`PATCH/DELETE /api/certs/{id}`、`POST /api/certs/{id}/renew` | nodes:write |
| `POST /api/certs/{id}/key`（下载私钥，记审计） | admin |
| `GET /api/dns/providers`、`GET /api/dns/records?domain_id=`、`POST /api/dns/plan` | read |
| `POST/PATCH/DELETE /api/dns/providers…`（令牌） | admin |
| `POST /api/dns/providers/{id}/verify`、`POST /api/dns/apply`、`POST/PATCH/DELETE /api/domains…` | nodes:write |
| `POST /api/probe {inbound_id | node_id | all}` | nodes:write |
| `GET /api/probe/results`、`GET /api/probe/settings` / `PUT`（settings:write） | read |

## 8. 测试

- 单元（`internal/master/certs_test.go`）：静态加密、PEM 校验（不匹配、过期、SAN、证书链顺序、通配符覆盖）、续期调度（假时钟 + 假签发器：首次签发、30 天窗口、退避、关闭自动续期、每日过期提醒）、探测用户不进统计和订阅、spec 证书分发（只发给用到的节点、spec_pb 不含私钥、续期不改 options_hash）、Cloudflare 客户端（httptest 假 API：分页、预览只读、更新只动选中的记录、过期 record_id 被拒、ACME TXT 增删）。
- E2E（`test/certs_test.go`）：上传自签证书 → trojan TLS 入站 → 走流量 → 替换证书：节点换文件、入站不重建、新握手是新证书；节点文件证书上报；探测 REALITY / TLS / Hysteria2 成功，关闭的端口、错误 SNI、REALITY 错误 SNI 给出明确解释；`inbound_unreachable` 事件。
