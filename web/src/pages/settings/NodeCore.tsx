import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Node, type Settings } from '../../lib/api'
import { useAction } from '../../lib/actions'
import { bytes } from '../../lib/fmt'
import { Button, Card, Field, Select, Switch } from '../../ui/kit'
import { useT } from '../../i18n'
import { C } from '../../i18n/common'
import { NC } from '../../i18n/nodecore'

type Core = { log_level: string; tcp_fast_open: boolean; tcp_multi_path: boolean; udp_timeout: string; gogc: number; mem_limit_mb: number }
const EMPTY: Core = { log_level: '', tcp_fast_open: false, tcp_multi_path: false, udp_timeout: '', gogc: 0, mem_limit_mb: 0 }

/** Panel-wide sing-box core and sbnode runtime tuning, pushed to every node. */
export function NodeCoreSettings() {
  const t = useT(NC)
  const c = useT(C)
  const s = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings & { node_core?: string }>('/settings') })
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<Node[]>('/nodes'), refetchInterval: 10_000 })
  const [f, setF] = useState<Core>(EMPTY)
  useEffect(() => {
    if (!s.data) return
    try { setF({ ...EMPTY, ...JSON.parse(s.data.node_core || '{}') }) } catch { setF(EMPTY) }
  }, [s.data])
  const up = <K extends keyof Core>(k: K, v: Core[K]) => setF((x) => ({ ...x, [k]: v }))
  const num = (v: string) => (v.trim() === '' ? 0 : Math.max(0, Math.round(Number(v)) || 0))
  const save = useAction({
    fn: () => api('/settings', { method: 'PUT', body: { node_core: JSON.stringify({ ...f, udp_timeout: f.udp_timeout.trim() }) } }),
    success: t.saved, invalidate: [['settings'], ['nodes']], apply: true,
  })
  const saveBtn = <Button size="sm" variant="primary" isPending={save.isPending} onPress={() => save.mutate()}>{c.save}</Button>
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title={t.core} action={saveBtn}>
        <div className="flex flex-col gap-4">
          <p className="text-xs text-muted">{t.coreHint}</p>
          <Select label={t.logLevel} value={f.log_level || 'template'} onChange={(v) => up('log_level', v === 'template' ? '' : v)} description={t.logHint}
            options={[{ id: 'template', label: t.logTemplate }, ...['error', 'warn', 'info', 'debug'].map((id) => ({ id, label: id }))]} />
          <div className="flex flex-col gap-1"><Switch isSelected={f.tcp_fast_open} onChange={(v) => up('tcp_fast_open', v)}>{t.tfo}</Switch><p className="text-xs text-muted">{t.tfoHint}</p></div>
          <div className="flex flex-col gap-1"><Switch isSelected={f.tcp_multi_path} onChange={(v) => up('tcp_multi_path', v)}>{t.mptcp}</Switch><p className="text-xs text-muted">{t.mptcpHint}</p></div>
          <Field label={t.udpTimeout} value={f.udp_timeout} onChange={(v) => up('udp_timeout', v)} placeholder="5m" description={t.udpTimeoutHint} />
        </div>
      </Card>
      <Card title={t.rt} action={saveBtn}>
        <div className="flex flex-col gap-4">
          <p className="text-xs text-muted">{t.rtHint}</p>
          <Field label={t.gogc} value={f.gogc ? String(f.gogc) : ''} onChange={(v) => up('gogc', num(v))} placeholder="100" inputMode="numeric" description={t.gogcHint} />
          <Field label={t.memLimit} value={f.mem_limit_mb ? String(f.mem_limit_mb) : ''} onChange={(v) => up('mem_limit_mb', num(v))} placeholder="—" inputMode="numeric" description={t.memLimitHint} />
        </div>
      </Card>
      <Card className="xl:col-span-2" title={t.status}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-[13px] tabular">
            <thead><tr className="text-left text-xs text-subtle">
              {[t.node, t.version, t.rss, t.heap, t.goroutines, t.threads, t.conns].map((h) => <th key={h} className="pb-2 pr-4 font-medium">{h}</th>)}
            </tr></thead>
            <tbody>
              {(nodes.data ?? []).map((n) => (
                <tr key={n.id} className="border-t">
                  <td className="py-2 pr-4 font-medium">{n.name}</td>
                  <td className="py-2 pr-4">{n.info?.singbox || '—'}</td>
                  {n.online && n.proc ? <>
                    <td className="py-2 pr-4">{bytes(n.proc.rss ?? 0)}</td>
                    <td className="py-2 pr-4">{bytes(n.proc.heap ?? 0)}</td>
                    <td className="py-2 pr-4">{n.proc.goroutines ?? '—'}</td>
                    <td className="py-2 pr-4">{n.proc.threads ?? '—'}</td>
                    <td className="py-2 pr-4">{n.active_conns}</td>
                  </> : <td colSpan={5} className="py-2 pr-4 text-muted">{t.offline}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
