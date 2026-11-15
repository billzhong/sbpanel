import { useMemo, useRef, useState } from 'react'
import { Dialog, Popover } from 'react-aria-components'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, apiRaw, type SeriesResp, type TopRow, type User, type Node } from '../lib/api'
import { bytes, num } from '../lib/fmt'
import { useRoute, go } from '../lib/router'
import { Button, Card, PageHeader, Segmented, Select, Skeleton, cx, popoverCls } from '../ui/kit'
import { TimeChart, ShareList, entitySlot, entityColor } from '../ui/charts'
import { IconSearch } from '../ui/icons'
import { tr } from '../i18n'
import { C } from '../i18n/common'
import { TR } from '../i18n/traffic'

const ranges = [
  { id: '1h', get label() { return tr(TR).r1h }, sec: 3600 },
  { id: '6h', get label() { return tr(TR).r6h }, sec: 6 * 3600 },
  { id: '24h', get label() { return tr(TR).r24h }, sec: 86400 },
  { id: '7d', get label() { return tr(TR).r7d }, sec: 7 * 86400 },
  { id: '30d', get label() { return tr(TR).r30d }, sec: 30 * 86400 },
] as const
type RangeID = (typeof ranges)[number]['id']

const STEPS = [60, 300, 900, 1800, 3600, 10800, 21600, 86400]
const MAX_POINTS = 2000
const KEEP = 30 * 86400
/** Smallest allowed step that keeps the series at ≤ 720 points (≥ 60 for any span over an hour). */
const autoStep = (span: number) => STEPS.find((st) => span / st <= 720) ?? 86400

const groupsOpts = [
  { id: 'total', get label() { return tr(TR).gTotal } }, { id: 'user', get label() { return tr(TR).gUser } }, { id: 'node', get label() { return tr(TR).gNode } },
  { id: 'inbound', get label() { return tr(TR).gInbound } }, { id: 'outbound', get label() { return tr(TR).gOutbound } },
] as const

const dims = [
  { id: 'domain', get label() { return tr(TR).dDomain } }, { id: 'host', get label() { return tr(TR).dHost } }, { id: 'src_ip', get label() { return tr(TR).dSrc } },
  { id: 'port', get label() { return tr(TR).dPort } }, { id: 'user', get label() { return tr(TR).dUser } }, { id: 'node', get label() { return tr(TR).dNode } },
  { id: 'inbound', get label() { return tr(TR).dInbound } }, { id: 'outbound', get label() { return tr(TR).dOutbound } }, { id: 'rule', get label() { return tr(TR).dRule } },
] as const
type DimID = (typeof dims)[number]['id']

export function TrafficPage() {
  const { params } = useRoute()
  const cFrom = Number(params.get('from')) || 0
  const cTo = Number(params.get('to')) || 0
  const custom = cFrom > 0 && cTo > cFrom
  const range: RangeID | 'custom' = custom ? 'custom' : ((params.get('range') as RangeID) || '24h')
  const stepSel = params.get('step') || 'auto'
  const group = params.get('group') || 'total'
  const user = params.get('user') || ''
  const node = params.get('node') || ''
  const dim = (params.get('dim') as DimID) || 'domain'
  const [q, setQ] = useState(params.get('q') || '')
  const t = tr(TR)

  const set = (k: string, v: string) => {
    const next: Record<string, string> = Object.fromEntries(params.entries())
    next[k] = v
    if (k === 'range') { delete next.step; delete next.from; delete next.to }
    go('traffic', next)
  }
  const setRange = (f: number, t: number) => {
    const next: Record<string, string> = Object.fromEntries(params.entries())
    delete next.range; delete next.step
    go('traffic', { ...next, from: String(f), to: String(t) })
  }
  const [picker, setPicker] = useState(false)
  const customRef = useRef<HTMLSpanElement>(null)

  const r = ranges.find((x) => x.id === range) ?? ranges[2]
  const to = custom ? cTo : Math.floor(Date.now() / 1000 / 60) * 60 + 60
  const from = custom ? cFrom : to - r.sec
  const span = to - from
  const auto = autoStep(span)
  const stepOpts = STEPS.filter((st) => span / st <= MAX_POINTS)
  const step = stepSel !== 'auto' && stepOpts.includes(Number(stepSel)) ? Number(stepSel) : auto
  const rangeKey = custom ? `${from}-${to}` : range
  const filt = `${user ? `&user=${user}` : ''}${node ? `&node=${node}` : ''}`

  const users = useQuery({ queryKey: ['users'], queryFn: () => api<User[]>('/users') })
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<Node[]>('/nodes') })
  const series = useQuery({
    queryKey: ['series', rangeKey, step, group, user, node],
    queryFn: () => api<SeriesResp>(`/traffic/series?from=${from}&to=${to}&step=${step}&group=${group}${filt}`),
    refetchInterval: custom ? false : 30000,
    placeholderData: keepPreviousData,
  })
  const top = useQuery({
    queryKey: ['top', dim, rangeKey, user, node],
    queryFn: async () => {
      const { data, headers } = await apiRaw<TopRow[] | { precision?: string; rows?: TopRow[]; items?: TopRow[] }>(`/traffic/top?dim=${dim}&from=${from}&to=${to}&limit=500${filt}`)
      if (Array.isArray(data)) return { rows: data, precision: headers.get('X-Precision') ?? '' }
      return { rows: data?.rows ?? data?.items ?? [], precision: data?.precision ?? headers.get('X-Precision') ?? '' }
    },
    refetchInterval: custom ? false : 30000,
    placeholderData: keepPreviousData,
  })
  const precision = top.data?.precision ?? ''
  const precisionHint = precision === '5m' ? t.prec5m : precision === '1h' ? t.prec1h : ''

  const chartSeries = useMemo(() => {
    const s = series.data?.series ?? []
    if (group === 'total') {
      const tot = s[0]
      if (!tot) return []
      return [
        { key: 'down', label: t.down, values: tot.points.map((p) => p[2]), color: 'var(--s1)' },
        { key: 'up', label: t.up, values: tot.points.map((p) => p[1]), color: 'var(--s2)' },
      ]
    }
    // Colour and stack order follow the entity (first-seen slot), never its rank, so they survive filters and refreshes.
    return s.map((x) => ({ key: x.key, label: x.label, values: x.points.map((p) => p[1] + p[2]), color: entityColor(group, x.key) }))
      .sort((a, b) => entitySlot(group, a.key) - entitySlot(group, b.key))
  }, [series.data, group])
  const times = series.data?.series[0]?.points.map((p) => p[0]) ?? []
  const sumDown = (series.data?.series ?? []).reduce((a, s) => a + s.down, 0)
  const sumUp = (series.data?.series ?? []).reduce((a, s) => a + s.up, 0)

  const topRows = top.data?.rows ?? []
  const rows = topRows.filter((x) => !q || x.label.toLowerCase().includes(q.toLowerCase()))
  const topTotal = topRows.reduce((a, x) => a + x.up + x.down, 0)

  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 max-w-full flex-col gap-1.5">
          <span className="text-[13px] font-medium text-subtle">{t.range}</span>
          <Segmented label={t.range} value={range} onChange={(v) => (v === 'custom' ? setPicker(true) : set('range', v))}
            options={[...ranges.map((x) => ({ id: x.id as RangeID | 'custom', label: x.label })), {
              id: 'custom', label: <span ref={customRef} className="tabular" onClick={() => custom && setPicker(true)}>{custom ? rangeLabel(from, to) : t.custom}</span>,
            }]} />
          <Popover triggerRef={customRef} isOpen={picker} onOpenChange={setPicker} placement="bottom" className={cx('w-[340px] max-w-[calc(100vw-24px)]', popoverCls)}>
            <Dialog aria-label={t.customRange} className="p-3 outline-none">
              <RangePicker from={custom ? from : to - r.sec} to={custom ? to : Math.floor(Date.now() / 60000) * 60}
                onApply={(f, t) => { setPicker(false); setRange(f, t) }} onCancel={() => setPicker(false)} />
            </Dialog>
          </Popover>
        </div>
        <Select label={t.step} className="w-40" value={stepOpts.includes(Number(stepSel)) ? stepSel : 'auto'} onChange={(v) => set('step', v)}
          options={[{ id: 'auto', label: t.auto(stepLabel(auto)) }, ...stepOpts.map((st) => ({ id: String(st), label: stepLabel(st) }))]} />
        <Select label={t.group} className="w-36" value={group} onChange={(v) => set('group', v)} options={groupsOpts.map((s) => ({ id: s.id, label: s.label }))} />
        <Select label={t.user} className="w-40" value={user || 'all'} onChange={(v) => set('user', v === 'all' ? '' : v)}
          options={[{ id: 'all', label: t.allUsers }, ...(users.data ?? []).map((u) => ({ id: String(u.id), label: u.username }))]} />
        <Select label={t.node} className="w-40" value={node || 'all'} onChange={(v) => set('node', v === 'all' ? '' : v)}
          options={[{ id: 'all', label: t.allNodes }, ...(nodes.data ?? []).map((n) => ({ id: n.id, label: n.name }))]} />
      </div>

      <Card busy={series.isPlaceholderData} title={<span>{t.trend} <span className="ml-2 text-[13px] font-normal text-subtle tabular">↓ {bytes(sumDown)} · ↑ {bytes(sumUp)} · {t.perPoint(stepLabel(series.data?.step ?? step))}</span></span>}>
        {series.isPending && !series.data ? <Skeleton className="h-[280px]" /> : (
          <TimeChart height={280} step={series.data?.step ?? step} times={times} series={chartSeries} stacked={group !== 'total'}
            onBrush={(f: number, t: number) => { const lo = Math.max(Math.floor(Date.now() / 1000) - KEEP, Math.floor(f / 60) * 60); const hi = Math.ceil(t / 60) * 60; if (hi - lo < 120) return false; setRange(lo, hi) }} />
        )}
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card title={<span>{t.share}{precisionHint && <span className="ml-2 text-xs font-normal text-muted">{precisionHint}</span>}</span>} busy={top.isPlaceholderData} action={
          <label className="relative">
            <IconSearch size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.filter} aria-label={t.filter}
              className="h-8 w-40 rounded-full border bg-base pr-3 pl-8 text-[13px] outline-none focus:border-accent" />
          </label>
        }>
          <div className="-mx-1 mb-3 flex flex-wrap gap-1">
            {dims.map((d) => (
              <button key={d.id} type="button" aria-pressed={d.id === dim} onClick={() => set('dim', d.id)}
                className={cx('h-7 cursor-pointer rounded-full px-3 text-[13px] outline-none transition-[background-color,color] duration-(--dur-1) focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface', d.id === dim ? 'bg-accent text-on-accent' : 'bg-overlay text-subtle hover:text-text')}>
                {d.label}
              </button>
            ))}
          </div>
          {top.isPending && !top.data ? <Skeleton className="h-64" /> : (
            <ShareList mono={['domain', 'host', 'src_ip', 'port'].includes(dim)} total={topTotal}
              rows={rows.slice(0, 15).map((x) => ({ key: x.key, label: x.label, value: x.up + x.down }))}
              onSelect={dim === 'user' ? (k) => set('user', k) : dim === 'node' ? (k) => set('node', k) : undefined} />
          )}
        </Card>
        <Card title={<span>{t.detail(num(rows.length))}{precisionHint && <span className="ml-2 text-xs font-normal text-muted">{precisionHint}</span>}</span>} pad={false} busy={top.isPlaceholderData}>
          <div className="max-h-[560px] overflow-auto">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-surface text-left text-xs text-subtle">
                <tr className="border-b">
                  <th className="px-5 py-2 font-medium">{dims.find((d) => d.id === dim)?.label}</th>
                  <th className="px-3 py-2 text-right font-medium">{t.down}</th>
                  <th className="px-3 py-2 text-right font-medium">{t.up}</th>
                  <th className="px-3 py-2 text-right font-medium">{t.conns}</th>
                  <th className="px-5 py-2 text-right font-medium">{t.usersCol}</th>
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
                {rows.length === 0 && !top.isPending && <tr><td colSpan={5} className="py-10 text-center text-muted">{t.empty}</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  )
}

function stepLabel(s: number) {
  const t = tr(TR)
  return s >= 86400 ? t.day(s / 86400) : s >= 3600 ? t.hour(s / 3600) : t.min(s / 60)
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const md = (d: Date) => `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
const dur = (sec: number) => {
  const c = tr(C), m = Math.round(sec / 60), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60)
  return m >= 1440 ? (h ? c.durDH(d, h) : c.unitD(d)) : m >= 60 ? (m % 60 ? c.durHM(h, m % 60) : c.unitH(h)) : c.unitM(m)
}
function rangeLabel(f: number, t: number) { return `${md(new Date(f * 1000))} – ${md(new Date(t * 1000))}` }
/** unix seconds ↔ the local "YYYY-MM-DDTHH:mm" value of <input type=datetime-local>. */
const toLocal = (ts: number) => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}` }
const fromLocal = (v: string) => (v ? Math.floor(new Date(v).getTime() / 1000) : NaN)

function RangePicker({ from, to, onApply, onCancel }: { from: number; to: number; onApply: (f: number, t: number) => void; onCancel: () => void }) {
  const [a, setA] = useState(toLocal(from))
  const [b, setB] = useState(toLocal(to))
  const now = Math.floor(Date.now() / 1000)
  const min = now - KEEP
  const f = fromLocal(a), t = fromLocal(b)
  const L = tr(TR)
  const err = Number.isNaN(f) || Number.isNaN(t) ? L.errFill
    : f < min - 60 ? L.errMin
      : t > now + 60 ? L.errMax
        : f >= t ? L.errOrder : ''
  const day0 = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return Math.floor(x.getTime() / 1000) }
  const quick = [
    { label: L.qToday, f: day0(), t: now },
    { label: L.qYesterday, f: day0() - 86400, t: day0() },
    { label: L.qWeek, f: (() => { const d = new Date(); const wd = (d.getDay() + 6) % 7; return day0() - wd * 86400 })(), t: now },
    { label: L.q3d, f: now - 3 * 86400, t: now },
    { label: L.q30d, f: min + 60, t: now },
  ]
  const inputCls = 'h-9 w-full rounded-[10px] border bg-base px-3 text-sm tabular outline-none transition-[border-color,box-shadow] duration-(--dur-1) focus:border-accent focus:ring-2 focus:ring-accent/25'
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (!err) onApply(f, t) }}>
      <div className="flex flex-wrap gap-1.5">
        {quick.map((x) => (
          <button key={x.label} type="button" onClick={() => { setA(toLocal(Math.max(x.f, min + 60))); setB(toLocal(x.t)) }}
            className="h-7 cursor-pointer rounded-full bg-overlay px-3 text-[13px] text-subtle outline-none transition-colors duration-(--dur-1) hover:text-text focus-visible:ring-2 focus-visible:ring-accent">{x.label}</button>
        ))}
      </div>
      <label className="flex flex-col gap-1.5 text-[13px] font-medium text-subtle">{L.start}
        <input type="datetime-local" step={60} value={a} min={toLocal(min)} max={toLocal(now)} onChange={(e) => setA(e.target.value)} className={inputCls} />
      </label>
      <label className="flex flex-col gap-1.5 text-[13px] font-medium text-subtle">{L.end}
        <input type="datetime-local" step={60} value={b} min={toLocal(min)} max={toLocal(now)} onChange={(e) => setB(e.target.value)} className={inputCls} />
      </label>
      <div className={cx('min-h-4 text-xs', err ? 'text-bad' : 'text-muted')}>{err || L.spanX(rangeLabel(f, t), dur(t - f))}</div>
      <div className="flex justify-end gap-2">
        <Button size="sm" onPress={onCancel}>{tr(C).cancel}</Button>
        <Button size="sm" variant="primary" type="submit" isDisabled={!!err}>{tr(C).apply}</Button>
      </div>
    </form>
  )
}
