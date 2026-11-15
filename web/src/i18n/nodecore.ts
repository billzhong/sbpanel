import { dict } from '.'

export const NC = dict({
  core: 'sing-box core', coreHint: 'Applied to every node. Saving redeploys all nodes: a new log level restarts the core (connections drop for a moment), listener options restart the inbounds they change.',
  logLevel: 'Log level', logTemplate: 'As in the route template', logHint: 'error keeps the journal quiet; info / debug log every connection and cost CPU on busy nodes',
  tfo: 'TCP Fast Open', tfoHint: 'Saves a round trip on repeat connections from clients that use it. Needs net.ipv4.tcp_fastopen=3 (set by tcpfit)',
  mptcp: 'Multipath TCP', mptcpHint: 'Lets MPTCP clients spread one connection over several paths. Harmless for others; needs kernel 5.6+',
  udpTimeout: 'UDP session timeout', udpTimeoutHint: 'Idle time before a UDP NAT mapping closes (sing-box default 5m), e.g. 2m or 10m',
  rt: 'sbnode runtime', rtHint: 'sbnode runs sing-box in its own process; these tune its Go garbage collector.',
  gogc: 'GOGC', gogcHint: 'GC target percent. Higher = less GC CPU, more memory. Empty = 100',
  memLimit: 'Memory limit (MB)', memLimitHint: 'Soft limit: the GC works harder as the process nears it. Empty = none; on a 1 GB VPS 256–400 is reasonable',
  status: 'Nodes now', node: 'Node', version: 'sing-box', rss: 'RSS', heap: 'Go heap', goroutines: 'Goroutines', threads: 'Threads', conns: 'Connections',
  offline: 'offline', saved: 'Saved; nodes are being redeployed',
}, {
  core: 'sing-box 内核', coreHint: '作用于所有节点。保存后会重新下发所有节点：改日志级别会重启内核（连接短暂中断），监听参数只会重启受影响的入站。',
  logLevel: '日志级别', logTemplate: '跟随路由模板', logHint: 'error 最安静；info / debug 会记录每条连接，繁忙节点上耗 CPU',
  tfo: 'TCP Fast Open', tfoHint: '支持 TFO 的客户端复连时省一个往返。需要 net.ipv4.tcp_fastopen=3（tcpfit 已设置）',
  mptcp: '多路径 TCP（MPTCP）', mptcpHint: '支持 MPTCP 的客户端可把一条连接分到多条路径上，对其他客户端无影响；需要内核 5.6+',
  udpTimeout: 'UDP 会话超时', udpTimeoutHint: 'UDP NAT 映射空闲多久后关闭（sing-box 默认 5m），例如 2m、10m',
  rt: 'sbnode 运行时', rtHint: 'sing-box 运行在 sbnode 进程内，这里调它的 Go 垃圾回收。',
  gogc: 'GOGC', gogcHint: 'GC 目标百分比。越大 GC 占 CPU 越少、内存越多。留空为 100',
  memLimit: '内存上限（MB）', memLimitHint: '软上限：接近时 GC 会更积极。留空为不限；1 GB 内存的机器 256–400 比较合适',
  status: '节点当前状态', node: '节点', version: 'sing-box', rss: '常驻内存', heap: 'Go 堆', goroutines: '协程', threads: '线程', conns: '连接',
  offline: '离线', saved: '已保存，正在重新下发节点',
})
