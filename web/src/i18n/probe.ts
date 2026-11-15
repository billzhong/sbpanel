import { dict } from '.'

export const P = dict({
  ok: 'Reachable', bad: 'Unreachable', partial: 'Some addresses unreachable', unknown: 'Not tested yet',
  quic: 'QUIC handshake', tcp: 'TCP connect', tls: 'TLS handshake', reality: 'REALITY handshake', handshake: 'Handshake + tunnel', proxy: 'Proxy request',
  notRun: 'Not run', stages: 'Test stages', pass: 'Working', fail: 'Failed', tech: 'Technical details',
  drawerLabel: 'Connectivity test results', retest: 'Test again',
  intro: 'The master connects to each address the subscription hands out, as a hidden probe user: DNS → TCP / QUIC → TLS / REALITY → a real HTTP request through the inbound. Probe traffic is not counted toward any user.',
  noResults: 'No results yet', noResultsHint: 'Click “Test again” to start',
  okOf: (ok: number, n: number) => `${ok} / ${n} address${n === 1 ? '' : 'es'} working`, retesting: ' · Testing again…',
}, {
  ok: '连通正常', bad: '不可达', partial: '部分地址不可达', unknown: '还没测试过',
  quic: 'QUIC 握手', tcp: 'TCP 连接', tls: 'TLS 握手', reality: 'REALITY 握手', handshake: '握手 + 隧道', proxy: '代理请求',
  notRun: '未执行', stages: '测试阶段', pass: '可用', fail: '失败', tech: '技术细节',
  drawerLabel: '连通性测试结果', retest: '重新测试',
  intro: 'master 以隐藏的探测用户，按订阅下发的地址逐个连接：DNS → TCP / QUIC → TLS / REALITY → 经入站发起真实的 HTTP 请求。探测流量不计入用户统计。',
  noResults: '还没有结果', noResultsHint: '点「重新测试」开始',
  okOf: (ok, n) => `${ok} / ${n} 个地址可用`, retesting: ' · 正在重新测试…',
})
