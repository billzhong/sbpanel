import { dict } from '.'

const s = (n: number) => (n === 1 ? '' : 's')

export const TR = dict({
  r1h: '1 hour', r6h: '6 hours', r24h: '24 hours', r7d: '7 days', r30d: '30 days',
  gTotal: 'Total', gUser: 'By user', gNode: 'By node', gInbound: 'By inbound', gOutbound: 'By outbound',
  dDomain: 'Domain', dHost: 'Full host', dSrc: 'Source IP', dPort: 'Port', dUser: 'User', dNode: 'Node', dInbound: 'Inbound', dOutbound: 'Outbound', dRule: 'Routing rule',
  prec5m: 'Detail at 5-minute precision', prec1h: 'Detail at 1-hour precision', down: 'Down', up: 'Up',
  title: 'Traffic', subtitle: 'Exact bytes per user, node, inbound, outbound, domain and source IP, counted by the core for every connection',
  range: 'Time range', custom: 'Custom', customRange: 'Custom time range', step: 'Resolution', auto: (x: string) => `Auto (${x})`,
  group: 'Split', user: 'User', node: 'Node', allUsers: 'All users', allNodes: 'All nodes',
  trend: 'Traffic trend', perPoint: (x: string) => `${x} per point`, share: 'Breakdown', filter: 'Filter',
  detail: (n: string) => `Details (${n})`, conns: 'Conns', usersCol: 'Users', empty: 'No data in this time range',
  day: (n: number) => `${n} day${s(n)}`, hour: (n: number) => `${n} hour${s(n)}`, min: (n: number) => `${n} min`,
  errFill: 'Enter a start and end time', errMin: 'The start can be at most 30 days ago', errMax: 'The end can’t be in the future', errOrder: 'The start must be before the end',
  qToday: 'Today', qYesterday: 'Yesterday', qWeek: 'This week', q3d: 'Last 3 days', q30d: 'Last 30 days',
  start: 'Start', end: 'End', spanX: (r: string, d: string) => `${r} · ${d} total`,
}, {
  r1h: '1 小时', r6h: '6 小时', r24h: '24 小时', r7d: '7 天', r30d: '30 天',
  gTotal: '总量', gUser: '按用户', gNode: '按节点', gInbound: '按入站', gOutbound: '按出站',
  dDomain: '域名', dHost: '完整主机', dSrc: '来源 IP', dPort: '端口', dUser: '用户', dNode: '节点', dInbound: '入站', dOutbound: '出站', dRule: '路由规则',
  prec5m: '明细精度 5 分钟', prec1h: '明细精度 1 小时', down: '下行', up: '上行',
  title: '流量分析', subtitle: '按用户、节点、入站、出站、域名、来源 IP 拆分的精确字节数（来自内核每条连接的计数）',
  range: '时间范围', custom: '自定义', customRange: '自定义时间范围', step: '粒度', auto: (x) => `自动（${x}）`,
  group: '分组', user: '用户', node: '节点', allUsers: '全部用户', allNodes: '全部节点',
  trend: '流量趋势', perPoint: (x) => `每点 ${x}`, share: '分布', filter: '过滤',
  detail: (n) => `明细（${n} 项）`, conns: '连接', usersCol: '用户数', empty: '此时间范围内没有数据',
  day: (n) => `${n} 天`, hour: (n) => `${n} 小时`, min: (n) => `${n} 分钟`,
  errFill: '请填写开始和结束时间', errMin: '开始时间最早为 30 天前', errMax: '结束时间不能晚于现在', errOrder: '开始时间必须早于结束时间',
  qToday: '今天', qYesterday: '昨天', qWeek: '本周', q3d: '最近 3 天', q30d: '最近 30 天',
  start: '开始', end: '结束', spanX: (r, d) => `${r} · 共 ${d}`,
})
