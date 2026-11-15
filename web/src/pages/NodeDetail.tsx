import { useState, type ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, type Inbound, type Node, type NodeMetrics } from '../lib/api'
import { href } from '../lib/router'
import { ago, bytes, dateTime, duration, pct, rate } from '../lib/fmt'
import { Badge, Card, Drawer, Empty, IconButton, Segmented, Skeleton, Tabs } from '../ui/kit'
import { NodeRouting } from './NodeRoute'
import { NR } from '../i18n/noderoute'
import { TimeChart, type ChartSeries } from '../ui/charts'
import { IconChevron } from '../ui/icons'
import { NodeQuota, nodeStatus, pctText, procParts, PROC_COLOR, UsageBar } from './Overview'
import { tr } from '../i18n'
import { O } from '../i18n/overview'
import { NM } from '../i18n/nodedetail'

type Range = '1h' | '6h' | '24h'
const RANGES: Record<Range, { sec: number; step: number }> = { '1h': { sec: 3600, step: 60 }, '6h': { sec: 6 * 3600, step: 120 }, '24h': { sec: 86400, step: 300 } }

const C_NODE = PROC_COLOR.sbnode, C_MASTER = PROC_COLOR.sbmaster

/** Second-level view of one node: live machine/process health, 1–24 h history, config and quota. */
export type NodeTab = 'status' | 'route'

export function NodeDrawer({ n, isOpen, ids, onNav, onClose, menu, tab, onTab }: {
  n: Node | undefined; isOpen: boolean; ids: string[]; onNav: (id: string) => void; onClose: () => void; menu?: ReactNode
  tab: NodeTab; onTab: (t: NodeTab) => void
}) {
  const m = tr(NM)
  const [range, setRange] = useState<Range>('1h')
  const at = n ? ids.indexOf(n.id) : -1
  const prev = at > 0 ? ids[at - 1] : undefined
  const next = at >= 0 && at < ids.length - 1 ? ids[at + 1] : undefined
  const st = n ? nodeStatus(n) : null
  const title = n
    ? <span className="flex min-w-0 items-center gap-2"><span className="truncate">{n.name}</span>{st && <Badge tone={st.tone} dot>{st.text}</Badge>}</span>
    : m.details
  return (
    <Drawer isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={title} label={n ? m.detailX(n.name) : m.details} contentKey={n?.id}
      actions={<>
        {menu}
        <IconButton label={m.prev} isDisabled={prev === undefined} onPress={() => prev && onNav(prev)}><IconChevron dir="up" /></IconButton>
        <IconButton label={m.next} isDisabled={next === undefined} onPress={() => next && onNav(next)}><IconChevron dir="down" /></IconButton>
      </>}>
      {!n ? <div className="flex flex-col gap-4"><Skeleton className="h-24" /><Skeleton className="h-48" /><Skeleton className="h-48" /></div> : (
        <div className="flex flex-col gap-5">
          {n.apply_error && <div className="rounded-[10px] bg-warn/10 px-3 py-2 font-mono text-xs break-all text-warn">{n.apply_error}</div>}
          <div className="-mb-5">
            <Tabs label={tr(NR).tabs} value={tab} onChange={onTab} tabs={[{ id: 'status', label: tr(NR).tStatus }, { id: 'route', label: tr(NR).tRouting }]} />
          </div>
          {tab === 'route' ? <NodeRouting n={n} /> : <>
          <Now n={n} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[15px] font-semibold">{m.history}</h3>
            <Segmented label={m.range} value={range} onChange={setRange} options={[{ id: '1h', label: m.h1 }, { id: '6h', label: m.h6 }, { id: '24h', label: m.h24 }]} />
          </div>
          <History id={n.id} range={range} />
          <Info n={n} />
          <Inbounds id={n.id} />
          </>}
        </div>
      )}
    </Drawer>
  )
}

/** Live tiles: machine bars with the process share, and the processes in detail. */
function Now({ n }: { n: Node }) {
  const m = tr(NM)
  const pr = procParts(n)
  const cpu = n.sys?.cpu_pct ?? 0
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-3 rounded-[12px] border bg-base p-3">
        <div className="text-xs font-medium text-subtle">{m.machine}</div>
        <UsageBar label={m.cpu} online={n.online} total={cpu} parts={pr.cpu} value={cpu.toFixed(0) + '%'} />
        <UsageBar label={m.memory} online={n.online} total={pct(n.sys?.mem_used ?? 0, n.sys?.mem_total ?? 0)}
          parts={pr.mem} value={`${bytes(n.sys?.mem_used ?? 0, 0)} / ${bytes(n.sys?.mem_total ?? 0, 0)}`} />
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="col-span-2"><KV k={m.down + ' / ' + m.up} v={n.online ? `${rate(n.rate_down)} / ${rate(n.rate_up)}` : '—'} /></div>
          <KV k={m.conns} v={n.online ? n.active_conns : '—'} />
          <KV k={m.onlineUsers} v={n.online ? n.online_users : '—'} />
        </div>
      </div>
      <div className="flex flex-col gap-2 rounded-[12px] border bg-overlay/50 p-3">
        <div className="text-xs font-medium text-subtle">{m.procs}</div>
        <Proc name={m.sbnode} color={C_NODE} p={n.online ? n.proc : undefined} missing={n.online && !n.proc} />
        {n.master && <Proc name={m.sbmaster} color={C_MASTER} p={n.master} />}
      </div>
    </div>
  )
}

function Proc({ name, color, p, missing }: { name: string; color: string; p?: Node['proc']; missing?: boolean }) {
  const m = tr(NM)
  return (
    <div className="rounded-[10px] bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: color }} aria-hidden />
        <span className="font-mono text-[13px] font-medium">{name}</span>
        {p && <span className="ml-auto text-[13px] font-semibold tabular">{pctText(p.cpu_pct ?? 0)} · {bytes(p.rss ?? 0)}</span>}
      </div>
      {p ? (
        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-muted tabular">
          <span>{m.heap} {bytes(p.heap ?? 0)}</span>
          <span>{m.goroutines} {p.goroutines ?? 0}</span>
          <span>{m.threads} {p.threads ?? 0}</span>
          {!!p.started && <span title={dateTime(p.started)}>{m.started} {ago(p.started)}</span>}
        </div>
      ) : <div className="mt-1 text-xs text-muted">{missing ? m.noProc : '—'}</div>}
    </div>
  )
}

function KV({ k, v }: { k: string; v: ReactNode }) {
  return <div className="min-w-0"><div className="truncate text-subtle">{k}</div><div className="mt-0.5 truncate text-[13px] text-text tabular">{v}</div></div>
}

function History({ id, range }: { id: string; range: Range }) {
  const m = tr(NM)
  const { sec, step } = RANGES[range]
  const [net, setNet] = useState<'proxy' | 'nic'>('proxy')
  const q = useQuery({
    queryKey: ['node-metrics', id, range],
    queryFn: () => api<NodeMetrics>(`/nodes/${id}/metrics?from=${Math.floor(Date.now() / 1000) - sec}&step=${step}`),
    refetchInterval: 60000, placeholderData: keepPreviousData,
  })
  const d = q.data
  if (!d) return <div className="flex flex-col gap-4"><Skeleton className="h-[200px]" /><Skeleton className="h-[200px]" /></div>
  if (d.points.length === 0 && d.traffic.length === 0) return <Card><Empty title={m.noData} /></Card>

  // One aligned time axis from the first sample on; buckets without a sample read as 0.
  const first = Math.min(d.points[0]?.ts ?? Infinity, d.traffic[0]?.[0] ?? Infinity)
  const end = d.to - (d.to % d.step)
  const times: number[] = []
  for (let t = first; t <= end; t += d.step) times.push(t)
  const pt = new Map(d.points.map((p) => [p.ts, p]))
  const tr_ = new Map(d.traffic.map((p) => [p[0], p]))
  const ms = new Map((d.master ?? []).map((p) => [p.ts, p]))
  const col = (f: (p: NodeMetrics['points'][number]) => number) => times.map((t) => { const p = pt.get(t); return p ? f(p) : 0 })
  const hasProc = d.points.some((p) => p.proc_cpu !== null)
  const hasMaster = ms.size > 0
  const busy = q.isPlaceholderData

  const machine: ChartSeries[] = [
    { key: 'cpu', label: m.cpu, values: col((p) => p.cpu), color: 'var(--s1)' },
    { key: 'mem', label: m.memory, values: col((p) => pct(p.mem_used, p.mem_total)), color: 'var(--s3)' },
  ]
  const cpu: ChartSeries[] = [], mem: ChartSeries[] = []
  if (hasProc) {
    cpu.push({ key: 'n', label: m.sbnode, values: col((p) => p.proc_cpu ?? 0), color: C_NODE })
    mem.push({ key: 'n', label: m.sbnode, values: col((p) => p.proc_rss ?? 0), color: C_NODE })
  }
  if (hasMaster) {
    cpu.push({ key: 's', label: m.sbmaster, values: times.map((t) => ms.get(t)?.cpu ?? 0), color: C_MASTER })
    mem.push({ key: 's', label: m.sbmaster, values: times.map((t) => ms.get(t)?.rss ?? 0), color: C_MASTER })
  }
  const thr: ChartSeries[] = net === 'proxy'
    ? [{ key: 'd', label: m.down, values: col((p) => p.rate_down), color: 'var(--s3)' }, { key: 'u', label: m.up, values: col((p) => p.rate_up), color: 'var(--s4)' }]
    : [{ key: 'rx', label: m.rx, values: col((p) => p.nic_rx), color: 'var(--s3)' }, { key: 'tx', label: m.tx, values: col((p) => p.nic_tx), color: 'var(--s4)' }]
  const traffic: ChartSeries[] = [
    { key: 'down', label: m.down, values: times.map((t) => tr_.get(t)?.[2] ?? 0), color: 'var(--s1)' },
    { key: 'up', label: m.up, values: times.map((t) => tr_.get(t)?.[1] ?? 0), color: 'var(--s2)' },
  ]
  const H = 160
  return (
    <div className="flex flex-col gap-4">
      <Card title={m.machineChart} busy={busy}><TimeChart unit="pct" height={H} step={d.step} times={times} series={machine} empty="—" /></Card>
      {cpu.length > 0 ? <>
        <Card title={m.procCpu} busy={busy}><TimeChart unit="pct" height={H} step={d.step} times={times} series={cpu} empty="—" /></Card>
        <Card title={m.procMem} busy={busy}><TimeChart unit="size" height={H} step={d.step} times={times} series={mem} empty="—" /></Card>
      </> : <div className="rounded-[12px] border border-dashed px-4 py-3 text-[13px] text-muted">{m.noProc}</div>}
      <Card title={m.throughput} busy={busy}
        action={<Segmented label={m.throughput} value={net} onChange={setNet} options={[{ id: 'proxy', label: m.proxy }, { id: 'nic', label: m.nic }]} />}>
        <TimeChart unit="rate" height={H} step={d.step} times={times} series={thr} />
      </Card>
      <Card title={m.traffic} busy={busy}><TimeChart height={H} step={d.step} times={times} series={traffic} /></Card>
    </div>
  )
}

function Info({ n }: { n: Node }) {
  const m = tr(NM)
  const o = tr(O)
  const rows: [string, ReactNode][] = [
    [m.address, <span className="font-mono">{n.address || '—'}</span>],
    [m.pubAddress, <span className="font-mono">{n.public_address || '—'}</span>],
    [m.version, n.info?.version || '—'],
    [m.singbox, n.info?.singbox || '—'],
    [m.os, [n.info?.os, n.info?.arch].filter(Boolean).join(' / ') || '—'],
    [m.uptime, n.online && n.sys?.uptime ? duration(n.sys.uptime) : '—'],
    [m.procUptime, n.online && n.proc?.started ? duration(Date.now() / 1000 - n.proc.started) : '—'],
    [m.revision, `r${n.applied_revision}${n.applied_revision !== n.revision ? ` → r${n.revision}` : ''}`],
    [m.lastSeen, n.last_seen ? <span title={dateTime(n.last_seen)}>{ago(n.last_seen)}</span> : '—'],
    [m.load, n.online && n.sys?.load1 !== undefined ? n.sys.load1.toFixed(2) : '—'],
    [m.disk, n.sys?.disk_total ? `${bytes(n.sys.disk_used ?? 0, 0)} / ${bytes(n.sys.disk_total, 0)}` : '—'],
    [m.backlog, String(n.spool_backlog)],
  ]
  return (
    <Card title={m.info}>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 text-[13px] sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex min-w-0 justify-between gap-3 border-b border-dashed pb-2 sm:block sm:border-0 sm:pb-0">
            <dt className="text-xs text-subtle">{k}</dt><dd className="truncate tabular sm:mt-0.5">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 border-t pt-3">
        <NodeQuota n={n} detail />
        <div className="mt-2 text-xs text-muted tabular">{o.todayX(bytes(n.today_down + n.today_up))}</div>
      </div>
    </Card>
  )
}

function Inbounds({ id }: { id: string }) {
  const m = tr(NM)
  const q = useQuery({ queryKey: ['inbounds'], queryFn: () => api<Inbound[]>('/inbounds') })
  const list = (q.data ?? []).filter((i) => i.node_id === id)
  return (
    <Card title={<span className="flex items-center gap-2">{m.inbounds}<Badge>{list.length}</Badge></span>}
      action={<a className="text-[13px] text-accent hover:underline" href={href('inbounds')}>{m.manage}</a>}>
      {!q.data ? <Skeleton className="h-16" /> : list.length === 0 ? <div className="text-[13px] text-muted">{m.noInbounds}</div> : (
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {list.map((i) => (
            <li key={i.id} className="flex min-w-0 items-center gap-2 rounded-[8px] bg-base px-2.5 py-1.5 text-[13px]">
              <span className={i.enabled ? 'h-1.5 w-1.5 shrink-0 rounded-full bg-good' : 'h-1.5 w-1.5 shrink-0 rounded-full bg-hl-high'} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{i.tag}</span>
              <span className="shrink-0 text-xs text-muted">{i.type} :{i.port}{i.enabled ? '' : ` · ${m.stopped}`}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
