# sbpanel

基于 **sing-box** 的代理管理面板，master 与 node 分离部署，内置按连接计数的流量统计。
设计见 [docs/DESIGN.md](docs/DESIGN.md)。

当前进度：**M0 + M1**（节点接入、内嵌内核、流量统计闭环、概览 / 流量分析 / 用户 / 节点 / 入站页面）。

## 组成

| 进程 | 作用 |
|---|---|
| `sbmaster` | Web 面板 + REST API + 节点 gRPC 中心，SQLite 存储，前端编进二进制 |
| `sbnode` | 内嵌 sing-box 1.14（库方式，不起子进程），统计每条连接、落盘上报、热更新入站 |

- **接入**：面板生成一次性令牌，节点本地生成私钥和 CSR，master 用自签 CA 签发客户端证书；之后全部走 mTLS（TLS 1.3），节点固定 master CA 指纹。
- **同步**：master 为每个节点维护带修订号的期望状态（骨架配置 + 入站 + 用户），节点比对 hash：骨架变了才重建内核，入站/用户变了只重建对应入站，被移除用户的连接立即断开。
- **流量**：节点挂 `ConnectionTracker`，每条连接原子计数（用户、入站、出站、域名、目标端口、来源 IP、规则），每 10 秒汇总成报告，**先写 bbolt 再发送**，master 在同一事务里按 `(node, seq)` 去重并累加，确认后节点才删除。master 宕机期间流量不丢、不重复。

## 构建

```bash
make web      # 前端 (pnpm)
make master node
make linux    # linux amd64/arm64 静态二进制
make test     # 含端到端测试：REALITY 100 MiB 精确计费、master 宕机补传、超额断线
```

需要 Go 1.25+、pnpm。sing-box 版本由 `go.mod` 锁定。

## 部署

```bash
# master
SBM_ADMIN_PASSWORD=... sbmaster --data /var/lib/sbmaster --web 127.0.0.1:8080 --grpc :9443 --public-grpc panel.example.com:9443
# 面板里添加节点，复制接入命令到节点机器执行：
sbnode enroll --master panel.example.com:9443 --token ... --ca-sha256 ...
sbnode run
```

Web 端口建议只监听本机，用 nginx/Caddy 反代 HTTPS。

## 本地演示

```bash
make web master node && go build -tags with_quic,with_utls -ldflags=-checklinkname=0 -o bin/devclient ./tools/devclient
scripts/dev-demo.sh start     # master + node + 两个用户 + VLESS REALITY 入站 + 两个客户端
scripts/dev-demo.sh traffic   # 通过两个用户访问一批网站
scripts/dev-demo.sh stop
```
