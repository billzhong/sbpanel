import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { ago } from '../lib/fmt'
import { Badge, Button, Callout, Drawer, Empty, Skeleton, Spinner, cx, useToast } from './kit'
import { IconCheck, IconRefresh, IconX } from './icons'

export const IconProbe = (p: { size?: number }) => <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>

export type ProbeStage = { name: string; label: string; ok: boolean; skip?: boolean; ms: number; detail?: string }
export type ProbeResult = {
  inbound_id: number; tag: string; node_id: string; node: string; endpoint: string; remark: string; type: string
  security: string; sni: string; ok: boolean; stage?: string; error?: string; raw?: string; stages: ProbeStage[] | null
  total_ms: number; url: string; ts: number
}
export type ProbeTarget = { inbound_id?: number; node_id?: string; all?: boolean }

export const useProbeResults = () => useQuery({ queryKey: ['probe'], queryFn: () => api<ProbeResult[]>('/probe/results'), staleTime: 10_000 })

/** Runs a probe and merges its results into the cached list. */
export function useRunProbe() {
  const qc = useQueryClient()
  const toast = useToast()
  return useMutation<ProbeResult[], Error, ProbeTarget>({
    mutationFn: (t) => api<ProbeResult[]>('/probe', { method: 'POST', body: t }),
    onSuccess: (rs, t) => {
      qc.setQueryData<ProbeResult[]>(['probe'], (old) => {
        const ids = new Set(rs.map((r) => r.inbound_id))
        const keep = (old ?? []).filter((r) => !(ids.has(r.inbound_id) || (t.node_id && r.node_id === t.node_id) || t.all))
        return [...keep, ...rs]
      })
      qc.invalidateQueries({ queryKey: ['events'] })
    },
    onError: (e) => toast('bad', e.message),
  })
}

export type Health = 'ok' | 'bad' | 'partial' | 'unknown'

export function healthOf(rs: ProbeResult[]): Health {
  if (!rs.length) return 'unknown'
  const ok = rs.filter((r) => r.ok).length
  return ok === rs.length ? 'ok' : ok === 0 ? 'bad' : 'partial'
}

const healthText: Record<Health, string> = { ok: '连通正常', bad: '不可达', partial: '部分地址不可达', unknown: '还没测试过' }

/** A compact health dot; a click opens the details. */
export function HealthDot({ results, onPress, running }: { results: ProbeResult[]; onPress?: () => void; running?: boolean }) {
  const h = healthOf(results)
  const latest = results.reduce((m, r) => Math.max(m, r.ts), 0)
  const ms = results.filter((r) => r.ok).map((r) => r.total_ms)
  const title = h === 'unknown' ? healthText[h] : `${healthText[h]}${ms.length ? ` · ${Math.min(...ms)} ms` : ''} · ${ago(latest)}`
  return (
    <button type="button" onClick={onPress} aria-label={title} title={title}
      className="inline-grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-full outline-none transition-colors duration-(--dur-1) hover:bg-overlay focus-visible:ring-2 focus-visible:ring-accent">
      {running ? <Spinner size={11} className="text-muted" /> : (
        <span className={cx('h-2 w-2 rounded-full transition-colors duration-(--dur-2)',
          h === 'ok' ? 'bg-good' : h === 'bad' ? 'bg-bad' : h === 'partial' ? 'bg-warn' : 'bg-hl-high')} />
      )}
    </button>
  )
}

/** The stages a full probe of this endpoint goes through, in order. */
function expected(r: ProbeResult): { name: string; label: string }[] {
  const udp = r.type === 'hysteria2' || r.type === 'tuic'
  const out = [{ name: 'dns', label: 'DNS' }, udp ? { name: 'quic', label: 'QUIC 握手' } : { name: 'tcp', label: 'TCP 连接' }]
  if (!udp && r.security === 'tls') out.push({ name: 'tls', label: 'TLS 握手' })
  out.push({ name: 'handshake', label: r.security === 'reality' ? 'REALITY 握手' : '握手 + 隧道' }, { name: 'proxy', label: '代理请求' })
  return out
}

function Timeline({ r }: { r: ProbeResult }) {
  const got = new Map((r.stages ?? []).map((s) => [s.name, s]))
  const failedAt = r.ok ? -1 : expected(r).findIndex((e) => e.name === r.stage)
  const rows = expected(r).map((e, i) => {
    const s = got.get(e.name)
    if (s) return { ...s, state: s.ok ? 'ok' : 'bad' } as const
    if (r.ok) return null // e.g. the handshake time was folded into the request
    return { name: e.name, label: e.label, ms: 0, detail: i === failedAt ? undefined : '未执行', state: i === failedAt ? 'bad' : 'skip' } as const
  }).filter((x) => x !== null)
  return (
    <ol className="relative flex flex-col gap-0" aria-label="测试阶段">
      {rows.map((s, i) => (
        <li key={s.name} className="relative flex gap-3 pb-3 last:pb-0">
          {i < rows.length - 1 && <span aria-hidden className={cx('absolute top-6 left-[11px] h-[calc(100%-18px)] w-px', s.state === 'ok' ? 'bg-good/40' : 'bg-hl-med')} />}
          <span className={cx('relative z-[1] mt-0.5 grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full',
            s.state === 'ok' ? 'bg-good/15 text-good' : s.state === 'bad' ? 'bg-bad/15 text-bad' : 'bg-overlay text-muted')}>
            {s.state === 'ok' ? <IconCheck size={12} /> : s.state === 'bad' ? <IconX size={12} /> : <span className="h-1 w-1 rounded-full bg-current" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2 text-[13px]">
              <span className={cx('font-medium', s.state === 'skip' && 'text-muted')}>{s.label}</span>
              {s.state !== 'skip' && <span className="font-mono text-xs text-subtle tabular">{'skip' in s && s.skip ? '—' : `${s.ms} ms`}</span>}
            </div>
            {s.detail && <div className="mt-0.5 text-xs [overflow-wrap:anywhere] text-muted">{s.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  )
}

export function ProbeCard({ r }: { r: ProbeResult }) {
  return (
    <section className="animate-content-in rounded-[14px] border bg-base p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge tone={r.ok ? 'good' : 'bad'} dot>{r.ok ? '可用' : '失败'}</Badge>
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={r.remark}>{r.remark || r.tag}</span>
        <span className="font-mono text-xs text-subtle tabular">{r.total_ms} ms</span>
      </div>
      <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-subtle">
        <span>{r.endpoint}</span>
        <span>{r.type}{r.security ? ' · ' + r.security : ''}</span>
        {r.sni && <span>SNI {r.sni}</span>}
      </div>
      <Timeline r={r} />
      {!r.ok && r.error && <div className="mt-3"><Callout tone="bad">{r.error}</Callout></div>}
      {!r.ok && r.raw && (
        <details className="mt-2 text-xs text-muted">
          <summary className="cursor-pointer outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-accent">技术细节</summary>
          <pre className="mt-1 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">{r.raw}</pre>
        </details>
      )}
    </section>
  )
}

/** Drawer with per-endpoint timelines for a probe target. */
export function ProbeDrawer({ isOpen, onClose, title, results, running, onRetry }: {
  isOpen: boolean; onClose: () => void; title: string; results: ProbeResult[]; running: boolean; onRetry: () => void
}) {
  const ok = results.filter((r) => r.ok).length
  return (
    <Drawer isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={title} label="连通性测试结果"
      actions={<Button size="sm" isPending={running} onPress={onRetry}>{!running && <IconRefresh size={14} />}重新测试</Button>}>
      <p className="mb-4 text-[13px] text-subtle">
        master 以隐藏的探测用户，按订阅下发的地址逐个连接：DNS → TCP / QUIC → TLS / REALITY → 经入站发起真实的 HTTP 请求。
        探测流量不计入用户统计。
      </p>
      {running && results.length === 0 && <div className="flex flex-col gap-3"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>}
      {!running && results.length === 0 && <Empty title="还没有结果" hint="点「重新测试」开始" />}
      {results.length > 0 && (
        <>
          <div className="mb-3 text-[13px] text-subtle">{ok} / {results.length} 个地址可用{running && ' · 正在重新测试…'}</div>
          <div className={cx('flex flex-col gap-3 transition-opacity duration-150', running && 'opacity-60')}>
            {results.map((r) => <ProbeCard key={r.inbound_id + r.endpoint} r={r} />)}
          </div>
        </>
      )}
    </Drawer>
  )
}
