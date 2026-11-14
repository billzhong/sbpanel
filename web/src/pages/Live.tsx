import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, type Conn, type Node } from '../lib/api'
import { bytes, duration, num } from '../lib/fmt'
import { useRoute, go } from '../lib/router'
import { Badge, Busy, Button, Card, Confirm, Empty, IconButton, PageHeader, Select, Skeleton, Switch } from '../ui/kit'
import { useAction } from '../lib/actions'
import { IconSearch, IconX } from '../ui/icons'

function age(sec: number) {
  return sec < 60 ? `${Math.max(0, Math.floor(sec))} 秒` : duration(sec)
}

type ConnResp = { conns: Conn[]; total: number; ready: boolean }

export function LivePage() {
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
    success: (_, ids) => `已断开 ${ids.length} 条连接`,
  })
  const [bulk, setBulk] = useState<number[] | null>(null)
  const rows = useMemo(() => (conns.data?.conns ?? []).filter((c) => !q ||
    [c.username, c.host, c.src_ip, c.inbound, c.outbound, c.rule].some((x) => x?.toLowerCase().includes(q.toLowerCase()))), [conns.data, q])
  const now = Date.now() / 1000
  return (
    <>
      <Confirm isOpen={!!bulk} onOpenChange={(v) => !v && setBulk(null)} danger title={`断开 ${bulk?.length ?? 0} 条连接`} confirmLabel="断开"
        onConfirm={() => bulk && close.mutate(bulk)} body={<>将断开当前筛选「<b className="text-text">{q}</b>」匹配的 {bulk?.length} 条连接。客户端通常会自动重连。</>} />
      <PageHeader title="实时连接" subtitle="当前正在转发的连接（每秒刷新，只在打开本页时由节点推送）" />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Select hideLabel label="节点" className="w-48" value={nodeId} onChange={(v) => go('live', { node: v })}
          options={online.map((n) => ({ id: n.id, label: n.name }))} />
        <label className="relative">
          <IconSearch size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="用户 / 域名 / IP / 规则" aria-label="过滤连接"
            className="h-9 w-64 rounded-full border bg-surface pr-3 pl-9 text-sm outline-none focus:border-accent" />
        </label>
        <Switch isSelected={!paused} onChange={(v) => setPaused(!v)}>实时刷新</Switch>
        {rows.length > 0 && q && <Button variant="danger" isPending={close.isPending} onPress={() => setBulk(rows.map((r) => r.id))}>断开筛选出的 {rows.length} 条</Button>}
        <span className="ml-auto text-[13px] text-subtle tabular">{conns.data ? `${num(rows.length)} / ${num(conns.data.total)} 条` : ''}</span>
      </div>
      {nodes.isLoading ? <Skeleton className="h-64" /> : online.length === 0 ? (
        <Card><Empty title="没有在线节点" hint="节点上线后可以查看实时连接" /></Card>
      ) : conns.isError ? (
        <Card><Empty title="节点离线" hint={(conns.error as Error).message} /></Card>
      ) : conns.isPending && !conns.data ? (
        <Skeleton className="h-64" />
      ) : !conns.data?.ready ? (
        <Card><Empty title="正在连接节点…" hint="第一帧数据大约 1 秒后到达" /></Card>
      ) : rows.length === 0 ? (
        <Card><Empty title={q ? '没有匹配的连接' : '当前没有连接'} /></Card>
      ) : (
        <Card pad={false}>
          <Busy busy={conns.isPlaceholderData} className="max-h-[calc(100vh-260px)] overflow-auto">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 z-10 bg-surface text-left text-xs text-subtle">
                <tr className="border-b">
                  <th className="px-5 py-2 font-medium">用户</th><th className="px-3 py-2 font-medium">目标</th>
                  <th className="hidden px-3 py-2 font-medium md:table-cell">来源</th><th className="hidden px-3 py-2 font-medium lg:table-cell">入站 → 出站</th>
                  <th className="px-3 py-2 text-right font-medium">↓ / ↑</th><th className="px-3 py-2 text-right font-medium">时长</th><th className="px-3 py-2" />
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
                    <td className="px-3 py-2 text-right"><IconButton label="断开连接" onPress={() => close.mutate([c.id])}><IconX size={15} /></IconButton></td>
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
