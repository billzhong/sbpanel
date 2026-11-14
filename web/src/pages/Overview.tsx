import { useQuery } from '@tanstack/react-query'
import { api, type Overview, type SeriesResp, type Node } from '../lib/api'
import { bytes, rate, pct, duration, ago } from '../lib/fmt'
import { go, href } from '../lib/router'
import { Badge, Card, PageHeader, Progress, Skeleton, Stat, Empty, Button, cx } from '../ui/kit'
import { TimeChart, ShareList } from '../ui/charts'
import { IconArrowDown, IconArrowUp, IconUsers, IconServer } from '../ui/icons'

export function OverviewPage() {
  const ov = useQuery({ queryKey: ['overview'], queryFn: () => api<Overview>('/overview'), refetchInterval: 5000 })
  const from = Math.floor(Date.now() / 1000) - 86400
  const series = useQuery({
    queryKey: ['series', 'overview'],
    queryFn: () => api<SeriesResp>(`/traffic/series?step=300&group=total&from=${from}`),
    refetchInterval: 30000,
  })
  const o = ov.data
  const s = series.data?.series[0]
  return (
    <>
      <PageHeader title="概览" subtitle="所有节点的实时状态与最近 24 小时流量" />
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {o ? (
          <>
            <Stat label="今日流量" value={bytes(o.today_down + o.today_up)}
              sub={<><IconArrowDown size={12} className="inline" /> {bytes(o.today_down)}　<IconArrowUp size={12} className="inline" /> {bytes(o.today_up)}</>} />
            <Stat label="本月流量" value={bytes(o.month_down + o.month_up)}
              sub={<><IconArrowDown size={12} className="inline" /> {bytes(o.month_down)}　<IconArrowUp size={12} className="inline" /> {bytes(o.month_up)}</>} />
            <Stat label="实时速率" value={rate(o.rate_down + o.rate_up)}
              sub={`↓ ${rate(o.rate_down)}　↑ ${rate(o.rate_up)}　${o.active_conns} 连接`} />
            <Stat label="在线" icon={<IconUsers size={14} />} value={<>{o.online_users}<span className="text-[15px] font-normal text-subtle"> / {o.active_users} 用户</span></>}
              sub={`${o.online_ips} 个设备 IP · 节点 ${o.nodes_online}/${o.nodes_total} 在线`} />
          </>
        ) : [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[112px]" />)}
      </div>

      <Card className="mt-4" title="24 小时流量" action={<a href={href('traffic')} className="text-[13px] text-accent hover:underline">流量分析 →</a>}>
        {s ? (
          <TimeChart
            step={series.data!.step}
            times={s.points.map((p) => p[0])}
            series={[
              { key: 'down', label: '下行', values: s.points.map((p) => p[2]), color: 'var(--s1)' },
              { key: 'up', label: '上行', values: s.points.map((p) => p[1]), color: 'var(--s2)' },
            ]}
          />
        ) : series.data ? <Empty title="还没有流量" hint="节点开始转发后，这里会显示每 5 分钟的流量" /> : <Skeleton className="h-[240px]" />}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="用户 Top（24h）">
          <ShareList rows={(o?.top_users ?? []).map((r) => ({ key: r.key, label: r.label, value: r.up + r.down }))}
            onSelect={(k) => go('users', { id: k })} emptyText="暂无用户流量" />
        </Card>
        <Card title="域名占比（24h）">
          <ShareList mono rows={(o?.top_domains ?? []).map((r) => ({ key: r.key, label: r.label, value: r.up + r.down }))}
            onSelect={(k) => go('traffic', { dim: 'domain', q: k })} emptyText="暂无域名数据" />
        </Card>
        <Card title="出站分布（24h）">
          <ShareList rows={(o?.top_outbounds ?? []).map((r) => ({ key: r.key, label: r.label, value: r.up + r.down }))} emptyText="暂无出站数据" />
        </Card>
      </div>

      <div className="mt-6 mb-3 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">节点</h2>
        <a href={href('nodes')} className="text-[13px] text-accent hover:underline">管理节点 →</a>
      </div>
      {o && o.nodes.length === 0 && (
        <Card><Empty title="还没有节点" hint="添加一个节点，在服务器上运行一行接入命令即可上线" action={<Button variant="primary" onPress={() => go('nodes')}>添加节点</Button>} /></Card>
      )}
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {o?.nodes.map((n) => <NodeCard key={n.id} n={n} />)}
      </div>
    </>
  )
}

export function nodeStatus(n: Node): { tone: 'good' | 'warn' | 'bad' | 'neutral'; text: string } {
  if (!n.enrolled) return { tone: 'neutral', text: '待接入' }
  if (!n.online) return { tone: 'bad', text: '离线' }
  if (n.apply_error) return { tone: 'warn', text: '配置异常' }
  if (n.applied_revision !== n.revision) return { tone: 'warn', text: '同步中' }
  return { tone: 'good', text: '在线' }
}

export function NodeCard({ n, actions }: { n: Node; actions?: React.ReactNode }) {
  const st = nodeStatus(n)
  const cpu = n.sys?.cpu_pct ?? 0
  const memP = pct(n.sys?.mem_used ?? 0, n.sys?.mem_total ?? 0)
  const month = n.month_up + n.month_down
  return (
    <section className="rounded-[16px] border bg-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <IconServer size={16} className="text-subtle" />
            <span className="truncate font-semibold">{n.name}</span>
            <Badge tone={st.tone} dot>{st.text}</Badge>
          </div>
          <div className="mt-1 truncate text-xs text-muted">
            {n.address || '—'}{n.info?.singbox ? ` · sing-box ${n.info.singbox}` : ''}{n.online ? ` · 运行 ${duration(n.sys?.uptime ?? 0)}` : n.last_seen ? ` · ${ago(n.last_seen)}` : ''}
          </div>
        </div>
        {actions}
      </div>
      {n.apply_error && <div className="mt-3 rounded-[10px] bg-warn/10 px-3 py-2 font-mono text-xs break-all text-warn">{n.apply_error}</div>}
      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 text-[13px]">
        <Metric label="下行 / 上行" value={n.online ? `${rate(n.rate_down)} / ${rate(n.rate_up)}` : '—'} />
        <Metric label="连接 / 在线用户" value={n.online ? `${n.active_conns} / ${n.online_users}` : '—'} />
        <div>
          <div className="mb-1 flex justify-between text-xs text-subtle"><span>CPU</span><span className="tabular">{n.online ? cpu.toFixed(0) + '%' : '—'}</span></div>
          <Progress value={n.online ? cpu : 0} />
        </div>
        <div>
          <div className="mb-1 flex justify-between text-xs text-subtle"><span>内存</span><span className="tabular">{n.online ? `${bytes(n.sys?.mem_used ?? 0, 0)} / ${bytes(n.sys?.mem_total ?? 0, 0)}` : '—'}</span></div>
          <Progress value={n.online ? memP : 0} />
        </div>
      </div>
      <div className="mt-4 border-t pt-3">
        <div className="mb-1 flex justify-between text-xs text-subtle">
          <span>本月（{n.reset_day} 日重置）</span>
          <span className="tabular">{bytes(month)}{n.traffic_limit > 0 ? ` / ${bytes(n.traffic_limit, 0)}` : ''}</span>
        </div>
        <Progress value={n.traffic_limit > 0 ? pct(month, n.traffic_limit) : 0} />
        <div className={cx('mt-2 flex justify-between text-xs text-muted tabular')}>
          <span>今日 {bytes(n.today_down + n.today_up)}</span>
          <span>{n.inbounds} 个入站 · r{n.applied_revision}{n.applied_revision !== n.revision ? `→${n.revision}` : ''}{n.spool_backlog > 0 ? ` · 待上报 ${n.spool_backlog}` : ''}</span>
        </div>
      </div>
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-subtle">{label}</div>
      <div className="mt-0.5 tabular">{value}</div>
    </div>
  )
}
