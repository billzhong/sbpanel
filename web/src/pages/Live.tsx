import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, type Conn, type Node } from '../lib/api'
import { bytes, duration, num } from '../lib/fmt'
import { useRoute, go } from '../lib/router'
import { Badge, Busy, Button, Card, Confirm, Empty, IconButton, PageHeader, Select, Skeleton, Switch } from '../ui/kit'
import { useAction } from '../lib/actions'
import { IconSearch, IconX } from '../ui/icons'
import { tr, useT } from '../i18n'
import { D } from '../i18n/live'

function age(sec: number) {
  return sec < 60 ? tr(D).sec(Math.max(0, Math.floor(sec))) : duration(sec)
}

type ConnResp = { conns: Conn[]; total: number; ready: boolean }

export function LivePage() {
  const t = useT(D)
  const { params } = useRoute()
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<Node[]>('/nodes') })
  const online = (nodes.data ?? []).filter((n) => n.online)
  const nodeId = params.get('node') || online[0]?.id || ''
  const [paused, setPaused] = useState(false)
  const [q, setQ] = useState('')
  const conns = useQuery({
    queryKey: ['conns', nodeId],
    queryFn: () => api<ConnResp>(`/nodes/${nodeId}/conns`),
    enabled: !!nodeId,
    refetchInterval: paused ? false : 1000,
    retry: false,
    placeholderData: keepPreviousData,
  })
  const close = useAction({
    fn: (ids: number[]) => api(`/nodes/${nodeId}/conns/close`, { method: 'POST', body: { ids } }),
    success: (_, ids) => t.closed(ids.length),
  })
  const [bulk, setBulk] = useState<number[] | null>(null)
  const rows = useMemo(() => (conns.data?.conns ?? []).filter((c) => !q ||
    [c.username, c.host, c.src_ip, c.inbound, c.outbound, c.rule].some((x) => x?.toLowerCase().includes(q.toLowerCase()))), [conns.data, q])
  const now = Date.now() / 1000
  return (
    <>
      <Confirm isOpen={!!bulk} onOpenChange={(v) => !v && setBulk(null)} danger title={t.closeN(bulk?.length ?? 0)} confirmLabel={t.close}
        onConfirm={() => bulk && close.mutate(bulk)} body={t.closeBody(q, bulk?.length ?? 0)} />
      <PageHeader title={t.title} subtitle={t.subtitle} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Select hideLabel label={t.node} className="w-48" value={nodeId} onChange={(v) => go('live', { node: v })}
          options={online.map((n) => ({ id: n.id, label: n.name }))} />
        <label className="relative">
          <IconSearch size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.filterPh} aria-label={t.filter}
            className="h-9 w-64 rounded-full border bg-surface pr-3 pl-9 text-sm outline-none focus:border-accent" />
        </label>
        <Switch isSelected={!paused} onChange={(v) => setPaused(!v)}>{t.live}</Switch>
        {rows.length > 0 && q && <Button variant="danger" isPending={close.isPending} onPress={() => setBulk(rows.map((r) => r.id))}>{t.closeFiltered(rows.length)}</Button>}
        <span className="ml-auto text-[13px] text-subtle tabular">{conns.data ? t.count(num(rows.length), num(conns.data.total)) : ''}</span>
      </div>
      {nodes.isLoading ? <Skeleton className="h-64" /> : online.length === 0 ? (
        <Card><Empty title={t.noOnline} hint={t.noOnlineHint} /></Card>
      ) : conns.isError ? (
        <Card><Empty title={t.offline} hint={(conns.error as Error).message} /></Card>
      ) : conns.isPending && !conns.data ? (
        <Skeleton className="h-64" />
      ) : !conns.data?.ready ? (
        <Card><Empty title={t.connecting} hint={t.connectingHint} /></Card>
      ) : rows.length === 0 ? (
        <Card><Empty title={q ? t.noMatch : t.none} /></Card>
      ) : (
        <Card pad={false}>
          <Busy busy={conns.isPlaceholderData} className="max-h-[calc(100vh-260px)] overflow-auto">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 z-10 bg-surface text-left text-xs text-subtle">
                <tr className="border-b">
                  <th className="px-5 py-2 font-medium">{t.user}</th><th className="px-3 py-2 font-medium">{t.target}</th>
                  <th className="hidden px-3 py-2 font-medium md:table-cell">{t.source}</th><th className="hidden px-3 py-2 font-medium lg:table-cell">{t.inOut}</th>
                  <th className="px-3 py-2 text-right font-medium">↓ / ↑</th><th className="px-3 py-2 text-right font-medium">{t.dur}</th><th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-b last:border-0 hover:bg-hl-low">
                    <td className="px-5 py-2">{c.username || <span className="text-muted">{c.user || '—'}</span>}</td>
                    <td className="max-w-[280px] px-3 py-2">
                      <div className="truncate font-mono text-[12.5px]" title={`${c.host}:${c.port}`}>{c.host}<span className="text-muted">:{c.port}</span></div>
                      <div className="truncate text-xs text-muted" title={c.rule}>{c.network} · {c.rule}</div>
                    </td>
                    <td className="hidden px-3 py-2 font-mono text-[12.5px] md:table-cell">{c.src_ip}</td>
                    <td className="hidden px-3 py-2 lg:table-cell"><Badge>{c.inbound}</Badge> → <Badge tone="accent">{c.outbound}</Badge></td>
                    <td className="px-3 py-2 text-right whitespace-nowrap tabular">{bytes(c.down)} / {bytes(c.up)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap text-subtle tabular">{age(now - c.start)}</td>
                    <td className="px-3 py-2 text-right"><IconButton label={t.closeOne} onPress={() => close.mutate([c.id])}><IconX size={15} /></IconButton></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Busy>
        </Card>
      )}
    </>
  )
}
