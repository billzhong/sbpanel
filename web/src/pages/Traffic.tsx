import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type SeriesResp, type TopRow, type User, type Node } from '../lib/api'
import { bytes, num } from '../lib/fmt'
import { useRoute, go } from '../lib/router'
import { Card, PageHeader, Segmented, Select, Skeleton, cx } from '../ui/kit'
import { TimeChart, ShareList, seriesColor } from '../ui/charts'
import { IconSearch } from '../ui/icons'

const ranges = [
  { id: '1h', label: '1 小时', sec: 3600, step: 60 },
  { id: '6h', label: '6 小时', sec: 6 * 3600, step: 300 },
  { id: '24h', label: '24 小时', sec: 86400, step: 900 },
  { id: '7d', label: '7 天', sec: 7 * 86400, step: 3600 },
  { id: '30d', label: '30 天', sec: 30 * 86400, step: 86400 },
] as const
type RangeID = (typeof ranges)[number]['id']

const steps = [
  { id: 'auto', label: '自动' }, { id: '60', label: '1 分钟' }, { id: '300', label: '5 分钟' },
  { id: '900', label: '15 分钟' }, { id: '3600', label: '1 小时' }, { id: '86400', label: '1 天' },
] as const

const groupsOpts = [
  { id: 'total', label: '总量' }, { id: 'user', label: '按用户' }, { id: 'node', label: '按节点' },
  { id: 'inbound', label: '按入站' }, { id: 'outbound', label: '按出站' },
] as const

const dims = [
  { id: 'domain', label: '域名' }, { id: 'host', label: '完整主机' }, { id: 'src_ip', label: '来源 IP' },
  { id: 'port', label: '端口' }, { id: 'user', label: '用户' }, { id: 'node', label: '节点' },
  { id: 'inbound', label: '入站' }, { id: 'outbound', label: '出站' }, { id: 'rule', label: '路由规则' },
] as const
type DimID = (typeof dims)[number]['id']

export function TrafficPage() {
  const { params } = useRoute()
  const range = (params.get('range') as RangeID) || '24h'
  const stepSel = params.get('step') || 'auto'
  const group = params.get('group') || 'total'
  const user = params.get('user') || ''
  const node = params.get('node') || ''
  const dim = (params.get('dim') as DimID) || 'domain'
  const [q, setQ] = useState(params.get('q') || '')

  const set = (k: string, v: string) => {
    const next: Record<string, string> = Object.fromEntries(params.entries())
    next[k] = v
    if (k === 'range') delete next.step
    go('traffic', next)
  }

  const r = ranges.find((x) => x.id === range) ?? ranges[2]
  let step = stepSel === 'auto' ? r.step : Number(stepSel)
  if (r.sec / step > 2000) step = r.step
  const to = Math.floor(Date.now() / 1000 / 60) * 60 + 60
  const from = to - r.sec
  const filt = `${user ? `&user=${user}` : ''}${node ? `&node=${node}` : ''}`

  const users = useQuery({ queryKey: ['users'], queryFn: () => api<User[]>('/users') })
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<Node[]>('/nodes') })
  const series = useQuery({
    queryKey: ['series', range, step, group, user, node],
    queryFn: () => api<SeriesResp>(`/traffic/series?from=${from}&to=${to}&step=${step}&group=${group}${filt}`),
    refetchInterval: 30000,
  })
  const top = useQuery({
    queryKey: ['top', dim, range, user, node],
    queryFn: () => api<TopRow[]>(`/traffic/top?dim=${dim}&from=${from}&to=${to}&limit=500${filt}`),
    refetchInterval: 30000,
  })

  const chartSeries = useMemo(() => {
    const s = series.data?.series ?? []
    if (group === 'total') {
      const t = s[0]
      if (!t) return []
      return [
        { key: 'down', label: '下行', values: t.points.map((p) => p[2]), color: 'var(--s1)' },
        { key: 'up', label: '上行', values: t.points.map((p) => p[1]), color: 'var(--s2)' },
      ]
    }
    return s.map((x, i) => ({ key: x.key, label: x.label, values: x.points.map((p) => p[1] + p[2]), color: seriesColor(i) }))
  }, [series.data, group])
  const times = series.data?.series[0]?.points.map((p) => p[0]) ?? []
  const sumDown = (series.data?.series ?? []).reduce((a, s) => a + s.down, 0)
  const sumUp = (series.data?.series ?? []).reduce((a, s) => a + s.up, 0)

  const rows = (top.data ?? []).filter((x) => !q || x.label.toLowerCase().includes(q.toLowerCase()))
  const topTotal = (top.data ?? []).reduce((a, x) => a + x.up + x.down, 0)

  return (
    <>
      <PageHeader title="流量分析" subtitle="按用户、节点、入站、出站、域名、来源 IP 拆分的精确字节数（来自内核每条连接的计数）" />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Segmented label="时间范围" value={range} onChange={(v) => set('range', v)} options={ranges.map((x) => ({ id: x.id, label: x.label }))} />
        <Select label="粒度" className="w-28" value={stepSel} onChange={(v) => set('step', v)} options={steps.map((s) => ({ id: s.id, label: s.label }))} />
        <Select label="分组" className="w-32" value={group} onChange={(v) => set('group', v)} options={groupsOpts.map((s) => ({ id: s.id, label: s.label }))} />
        <Select label="用户" className="w-40" value={user || 'all'} onChange={(v) => set('user', v === 'all' ? '' : v)}
          options={[{ id: 'all', label: '全部用户' }, ...(users.data ?? []).map((u) => ({ id: String(u.id), label: u.username }))]} />
        <Select label="节点" className="w-40" value={node || 'all'} onChange={(v) => set('node', v === 'all' ? '' : v)}
          options={[{ id: 'all', label: '全部节点' }, ...(nodes.data ?? []).map((n) => ({ id: n.id, label: n.name }))]} />
      </div>

      <Card title={<span>流量趋势 <span className="ml-2 text-[13px] font-normal text-subtle tabular">↓ {bytes(sumDown)} · ↑ {bytes(sumUp)} · 每点 {stepLabel(series.data?.step ?? step)}</span></span>}>
        {series.isLoading ? <Skeleton className="h-[280px]" /> : (
          <TimeChart height={280} step={series.data?.step ?? step} times={times} series={chartSeries} stacked={group !== 'total'} />
        )}
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card title="分布" action={
          <label className="relative">
            <IconSearch size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="过滤" aria-label="过滤"
              className="h-8 w-40 rounded-full border bg-base pr-3 pl-8 text-[13px] outline-none focus:border-accent" />
          </label>
        }>
          <div className="-mx-1 mb-3 flex flex-wrap gap-1">
            {dims.map((d) => (
              <button key={d.id} type="button" onClick={() => set('dim', d.id)}
                className={cx('h-7 rounded-full px-3 text-[13px] transition-colors cursor-pointer', d.id === dim ? 'bg-accent text-on-accent' : 'bg-overlay text-subtle hover:text-text')}>
                {d.label}
              </button>
            ))}
          </div>
          {top.isLoading ? <Skeleton className="h-64" /> : (
            <ShareList mono={['domain', 'host', 'src_ip', 'port'].includes(dim)} total={topTotal}
              rows={rows.slice(0, 15).map((x) => ({ key: x.key, label: x.label, value: x.up + x.down }))}
              onSelect={dim === 'user' ? (k) => set('user', k) : dim === 'node' ? (k) => set('node', k) : undefined} />
          )}
        </Card>
        <Card title={`明细（${num(rows.length)} 项）`} pad={false}>
          <div className="max-h-[560px] overflow-auto">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-surface text-left text-xs text-subtle">
                <tr className="border-b">
                  <th className="px-5 py-2 font-medium">{dims.find((d) => d.id === dim)?.label}</th>
                  <th className="px-3 py-2 text-right font-medium">下行</th>
                  <th className="px-3 py-2 text-right font-medium">上行</th>
                  <th className="px-3 py-2 text-right font-medium">连接</th>
                  <th className="px-5 py-2 text-right font-medium">用户数</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.key} className="border-b last:border-0 hover:bg-hl-low">
                    <td className={cx('max-w-[320px] truncate px-5 py-2', ['domain', 'host', 'src_ip', 'port'].includes(dim) && 'font-mono text-[12.5px]')} title={x.label}>{x.label}</td>
                    <td className="px-3 py-2 text-right tabular">{bytes(x.down)}</td>
                    <td className="px-3 py-2 text-right tabular">{bytes(x.up)}</td>
                    <td className="px-3 py-2 text-right tabular">{num(x.conns)}</td>
                    <td className="px-5 py-2 text-right tabular">{x.users}</td>
                  </tr>
                ))}
                {rows.length === 0 && !top.isLoading && <tr><td colSpan={5} className="py-10 text-center text-muted">此时间范围内没有数据</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  )
}

function stepLabel(s: number) {
  return s >= 86400 ? '1 天' : s >= 3600 ? `${s / 3600} 小时` : `${s / 60} 分钟`
}
