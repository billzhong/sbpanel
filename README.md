# sbpanel

基于 **sing-box** 的代理管理面板：master 与 node 分离部署，内置按连接计数的流量统计（相当于自带 Neko Master）。
设计文档见 [docs/DESIGN.md](docs/DESIGN.md)。

## 功能

| 模块 | 能力 |
|---|---|
| 节点 | 一行命令接入（一次性令牌 + CSR，面板自签 CA 签发证书，mTLS / TLS 1.3）；节点主动连接 master，可以在 NAT 后面；证书到期前自动续签；删除节点即吊销证书；显示 CPU、内存、实时速率、月流量配额（按重置日计算，80% / 100% 告警） |
| 内核 | sing-box 1.14 以 Go 库方式内嵌；骨架（路由、DNS、出站）与入站分开管理：只改用户时**原地热更新**（vless / vmess / trojan / shadowsocks），已有连接不断；其它入站只重建自身；骨架改动先校验再蓝绿重建，失败时旧配置继续服务 |
| 入站 | VLESS（REALITY / Vision、WS、gRPC、HTTPUpgrade）、VMess、Trojan、Shadowsocks 2022、Hysteria2、TUIC v5、AnyTLS；模板一键生成 REALITY 密钥对，支持 ACME 自动证书 |
| 用户 | 流量额度、到期时间、用量重置周期（日 / 周 / 月 / 按创建日滚动）、**限速**（按用户在所有连接间共享令牌桶）、**设备数**（来源 IP；节点本地拒绝 + master 跨节点校正）、批量创建、更换密钥、踢下线 |
| 分组 | 用户 ↔ 入站多对多映射；默认分组自动接纳新用户和新入站 |
| 订阅 | `/s/<令牌>`（兼容 3x-ui 的 `/sub/<subId>`）；根据 User-Agent 返回 sing-box JSON、Clash/mihomo YAML 或 base64 URI；浏览器打开显示自助页（用量、二维码、一键导入）；`subscription-userinfo` 等响应头；Host 层可覆盖地址、端口、SNI、Host、路径，用于 CDN、中转、多域名；记录订阅访问日志 |
| 路由模板 | 出站、路由规则、规则集、DNS 的结构化编辑和 JSON 编辑；改动先存为草稿，查看 diff 后再发布到使用该模板的节点 |
| 流量分析 | 精确到 用户 × 节点 × 入站 × 出站 × 域名 × 来源 IP × 端口 × 规则；粒度 1 分钟、5 分钟、15 分钟、1 小时、1 天；分组趋势图、占比、明细；实时连接列表，可以断开连接 |
| 运维 | 两步验证（TOTP）、带权限的 API 密钥、审计日志、Telegram / Webhook 通知、一键备份、`sbmaster reset-admin`、从 3x-ui 迁移（API JSON 或 `x-ui.db`） |
| API 与智能体 | 带权限范围的 API 密钥（read / users:write / nodes:write / settings:write / admin）、有效期、来源 IP 白名单、按密钥限流；OpenAPI 3.1 文档与面板内文档页；内置 MCP 服务器（`POST /mcp`），Claude Code 等智能体可直接查询和管理用户 |
| 界面 | React 19、react-aria-components、Tailwind v4；Rosé Pine 浅色和深色主题；⌘K 命令面板，`g`+字母 跳转页面；手机布局 |

### 流量不丢的设计
节点为每条连接计数，每 10 秒汇总成报告，**先写入本地 bbolt 再发送**；master 在同一个事务里按 `(节点, seq)` 去重并累加，确认后节点才删除。
master 宕机期间报告在节点上排队（超过上限时合并成更粗的时间窗，不直接丢弃）；重发不会重复计入。

## 构建与测试

```bash
make web          # 前端（pnpm）
make master node  # 本机二进制
make linux        # linux amd64/arm64 静态二进制（CGO=0）
make test         # 单元测试 + 端到端测试
make test-race    # 加上 race 检测
```

需要 Go 1.25+（go.mod 会自动拉取工具链）和 pnpm。

### 测试覆盖
- **单元测试**：TOTP（RFC 6238 向量）、PKI 与 CA 指纹校验、重置周期（含月末对齐）、REALITY 公钥推导、各协议用户 JSON、分享链接、sing-box 订阅（用 sing-box 解析并 `box.New` 校验）、mihomo YAML、User-Agent 识别、模板校验、报告并发重放只计一次、超额判定、分组与策略、从 v1 数据库迁移、3x-ui 导入（分组推导、失败回滚）、节点端增量统计、维度截断、spool 重启续号与压缩不丢字节、设备数与令牌桶限速
- **端到端测试**（真实 sing-box 客户端，配置取自用户自己的订阅）：
  - 11 种入站组合逐一传输并核对每个入站的计费
  - 经 REALITY 传输 100 MiB，master 与节点计数逐字节一致
  - master 宕机后补传数据，不丢失也不重复
  - 分组隔离
  - 热更新时其它用户的连接不断
  - 限速
  - 实时连接查看与断开
  - 到期后断线，续期后恢复
  - 模板发布；配置错误时自动保留旧配置
  - 节点证书吊销
  - 并发多用户计费
  - API 鉴权：401、API 令牌、两步验证、改密码、审计
  - 带权限的 API 密钥（权限、过期、IP 白名单、限流）与 MCP 端点（initialize、tools/list、读写工具）
  - 输入校验与冲突
  - 3x-ui 迁移后旧客户端和旧订阅链接继续可用

## API 与 AI 智能体

在「设置 → API 与智能体」创建密钥（只显示一次），按需勾选权限：

```bash
curl -H "Authorization: Bearer sbp_…" https://panel.example.com/api/overview
claude mcp add --transport http sbpanel https://panel.example.com/mcp --header "Authorization: Bearer sbp_…"
```

接口描述在 `GET /api/openapi.json`（面板内「API 文档」页可浏览）。权限、限流、MCP 工具和其它客户端的配置见 [docs/API.md](docs/API.md)。

## 一键安装

支持 Debian / Ubuntu、RHEL / CentOS 7+ / Rocky / Alma / Fedora、Alpine（OpenRC）、Arch、openSUSE，架构 amd64 / arm64。安装包会做 SHA256 校验。

**面板（master）**
```bash
curl -fsSL https://raw.githubusercontent.com/genguzzz/sbpanel/main/install.sh | sh -s -- master \
  --web 127.0.0.1:8080 --grpc :9443 --public-grpc panel.example.com:9443
```
安装完成后会打印初始管理员密码。Web 默认只监听本机，请用 nginx 或 Caddy 反代并配置 HTTPS；节点通过 gRPC 端口（默认 9443）连接 master，需要在防火墙放行。

**节点**：在面板「节点 → 添加节点」中复制命令，格式如下
```bash
curl -fsSL https://raw.githubusercontent.com/genguzzz/sbpanel/main/install.sh | sh -s -- node \
  --master panel.example.com:9443 --token <一次性令牌> --ca-sha256 <CA 指纹>
```

**升级 / 卸载 / 状态**
```bash
curl -fsSL https://raw.githubusercontent.com/genguzzz/sbpanel/main/install.sh | sh -s -- upgrade
curl -fsSL https://raw.githubusercontent.com/genguzzz/sbpanel/main/install.sh | sh -s -- uninstall node --purge
curl -fsSL https://raw.githubusercontent.com/genguzzz/sbpanel/main/install.sh | sh -s -- status
```
GitHub 访问不畅时，可以加 `--mirror https://<你的 GitHub 代理>/` 走镜像；用 `--version vX.Y.Z` 安装指定版本。

**从 3x-ui 迁移**
- 只迁移用户：`sbmaster import-3xui --users-only --json export.json`。用户名、UUID、密码、额度、到期时间、subId 都保持不变，原来的 `/sub/<subId>` 订阅链接继续可用。
- 连同入站一起迁移：`--node <ID> --db /etc/x-ui/x-ui.db`。
- 两种方式都可以先加 `--dry-run` 预览。

## 本地演示

```bash
make web master node && go build -tags with_quic,with_utls -ldflags=-checklinkname=0 -o bin/devclient ./tools/devclient
scripts/dev-demo.sh start     # master + node + 用户 + VLESS REALITY 入站 + 两个客户端
scripts/dev-demo.sh traffic   # 通过两个用户访问一批网站
scripts/dev-demo.sh stop
```

## 许可

sbpanel 以库的形式链接 sing-box（GPL-3.0-or-later），并在 `internal/node/hot/` 中包含修改过的 sing-box 源码，因此**分发二进制时整个项目须遵守 GPL-3.0-or-later**。
