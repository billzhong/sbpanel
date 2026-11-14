import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Host, type Inbound, type Node, type Settings } from '../lib/api'
import { useAction } from '../lib/actions'
import { Badge, Button, Callout, Card, Checkbox, Confirm, Empty, Field, IconButton, ModalDialog, PageHeader, Presence, Select, Skeleton, Switch, Tabs } from '../ui/kit'
import { go, useRoute } from '../lib/router'
import { SubPageTab } from './subscriptions/SubPage'
import { RoutingTab } from './subscriptions/Routing'
import { IconEdit, IconPlus, IconTrash } from '../ui/icons'

type SubTab = 'links' | 'routing' | 'hosts' | 'subpage'

/** Tab definitions in one place: a new tab (e.g. 分流规则) is a one-line addition here. */
const SUB_TABS: { id: SubTab; label: string; el: () => ReactNode }[] = [
  { id: 'links', label: '订阅链接', el: () => <LinksTab /> },
  { id: 'routing', label: '分流规则', el: () => <RoutingTab /> },
  { id: 'hosts', label: '客户端地址', el: () => <HostsTab /> },
  { id: 'subpage', label: '订阅页', el: () => <SubPageTab /> },
]

export function SubscriptionsPage() {
  const { params } = useRoute()
  const tab = SUB_TABS.find((t) => t.id === params.get('tab')) ?? SUB_TABS[0]
  return (
    <>
      <PageHeader title="订阅" subtitle="订阅链接、分流规则、客户端地址（Host）与用户看到的订阅页外观" />
      <Tabs value={tab.id} onChange={(t) => go('subscriptions', { tab: t })} tabs={SUB_TABS.map(({ id, label }) => ({ id, label }))} label="订阅设置分区" />
      <div key={tab.id} className="animate-content-in">{tab.el()}</div>
    </>
  )
}

function LinksTab() {
  return (
    <div className="flex flex-col gap-4">
      <SubSettings />
      <Card title="格式与路径">
        <dl className="grid gap-x-4 gap-y-2 text-[13px] sm:grid-cols-[180px_1fr]">
          <dt className="text-subtle">路径</dt><dd><span className="font-mono">/s/&lt;令牌&gt;</span>，兼容 3x-ui 的 <span className="font-mono">/sub/&lt;subId&gt;</span></dd>
          <dt className="text-subtle">自动识别</dt><dd>按 User-Agent 返回 sing-box JSON、Clash / mihomo YAML、Surge 配置或 base64 节点列表；浏览器打开显示订阅页</dd>
          <dt className="text-subtle">指定格式</dt><dd className="font-mono text-[12.5px]">?format=base64 · links · singbox · mihomo · surge · html · json</dd>
          <dt className="text-subtle">分流配置</dt><dd><span className="font-mono">?profile=&lt;标识&gt;</span> 选择 <a className="text-accent hover:underline" href="#/subscriptions?tab=routing">分流规则</a> 里允许自选的配置；不带时用用户 → 分组 → 默认的分配</dd>
          <dt className="text-subtle">订阅页数据</dt><dd><span className="font-mono">?format=json</span> 返回结构化的用户、用量与节点信息，供订阅页主题使用</dd>
        </dl>
      </Card>
    </div>
  )
}

function HostsTab() {
  const inbounds = useQuery({ queryKey: ['inbounds'], queryFn: () => api<Inbound[]>('/inbounds') })
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<Node[]>('/nodes') })
  const hosts = useQuery({ queryKey: ['hosts'], queryFn: () => api<Host[]>('/hosts') })
  const [editing, setEditing] = useState<Partial<Host> | null>(null)
  const [deleting, setDeleting] = useState<Host | null>(null)
  const toggle = useAction({
    fn: (h: Host) => api(`/hosts/${h.id}`, { method: 'PUT', body: { ...h, enabled: !h.enabled } }),
    invalidate: [['hosts']], success: (_, h) => `已${h.enabled ? '停用' : '启用'} Host`,
  })
  const del = useAction({
    fn: (id: number) => api(`/hosts/${id}`, { method: 'DELETE' }),
    success: 'Host 已删除', invalidate: [['hosts']],
  })
  const nodeOf = new Map((nodes.data ?? []).map((n) => [n.id, n]))
  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">客户端地址（Host）</h2>
        <Button variant="primary" isDisabled={!inbounds.data?.length} onPress={() => setEditing({ inbound_id: inbounds.data?.[0]?.id, enabled: true, sort: 0 })}>
          <IconPlus size={16} />添加 Host
        </Button>
      </div>
      <Callout>没有配置 Host 的入站，订阅里使用「节点公网地址 + 入站端口」。配置了 Host 后，每个 Host 生成一个节点，可覆盖地址、端口、SNI、Host 头和路径。</Callout>
      {inbounds.isLoading && <Skeleton className="mt-4 h-40" />}
      {inbounds.data?.length === 0 && <Card className="mt-4"><Empty title="还没有入站" hint="先在「入站」页创建入站" /></Card>}
      <div className="mt-4 flex flex-col gap-3">
        {inbounds.data?.map((i) => {
          const hs = (hosts.data ?? []).filter((h) => h.inbound_id === i.id)
          const n = nodeOf.get(i.node_id)
          const def = n?.public_address || n?.address || '（节点未上线）'
          return (
            <Card key={i.id} pad={false} title={<span>{i.node} / {i.tag} <Badge tone="accent">{i.type}</Badge></span>}
              action={<Button size="sm" onPress={() => setEditing({ inbound_id: i.id, enabled: true, sort: hs.length })}><IconPlus size={14} />Host</Button>}>
              {hs.length === 0 ? (
                <div className="px-5 pt-1 pb-4 text-[13px] text-subtle">默认：<span className="font-mono text-text">{def}:{i.port}</span>
                  {!n?.public_address && <span className="ml-2 text-xs text-warn">建议在「节点」里填写公网地址</span>}</div>
              ) : (
                <div className="overflow-x-auto">
                <table className="w-full text-[13px] whitespace-nowrap">
                  <thead className="text-left text-xs text-subtle"><tr className="border-b">
                    <th className="px-5 py-2 font-medium">备注</th><th className="px-3 py-2 font-medium">地址</th>
                    <th className="hidden px-3 py-2 font-medium md:table-cell">SNI / Host / Path</th><th className="px-3 py-2 font-medium">启用</th><th className="px-5 py-2" />
                  </tr></thead>
                  <tbody>
                    {hs.map((h) => (
                      <tr key={h.id} className="border-b last:border-0 hover:bg-hl-low">
                        <td className="px-5 py-2.5">{h.remark || <span className="text-muted">（沿用入站名）</span>}</td>
                        <td className="px-3 py-2.5 font-mono text-[12.5px]">{h.address || def}:{h.port || i.port}</td>
                        <td className="hidden px-3 py-2.5 font-mono text-xs text-subtle md:table-cell">{[h.sni, h.host, h.path].filter(Boolean).join(' · ') || '—'}</td>
                        <td className="px-3 py-2.5"><Switch label={`启用 ${h.remark || h.address || 'Host'}`} isSelected={h.enabled} onChange={() => toggle.mutate(h)} /></td>
                        <td className="px-5 py-2.5 text-right whitespace-nowrap">
                          <IconButton label="编辑 Host" onPress={() => setEditing(h)}><IconEdit size={16} /></IconButton>
                          <IconButton label="删除 Host" onPress={() => setDeleting(h)}><IconTrash size={16} /></IconButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </Card>
          )
        })}
      </div>
      <Presence value={editing}>{(h, open) => <HostForm isOpen={open} h={h} inbounds={inbounds.data ?? []} onClose={() => setEditing(null)} />}</Presence>
      <Confirm isOpen={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} danger title="删除 Host" confirmLabel="删除 Host"
        onConfirm={() => deleting && del.mutate(deleting.id)} body="客户端下次更新订阅时，这个地址会消失。此操作不可撤销。" />
    </>
  )
}

function SubSettings() {
  const s = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/settings') })
  const [base, setBase] = useState('')
  const [title, setTitle] = useState('')
  const [hours, setHours] = useState('12')
  useEffect(() => {
    if (s.data) { setBase(s.data.sub_base_url); setTitle(s.data.sub_title); setHours(s.data.sub_update_hours) }
  }, [s.data])
  const save = useAction({
    fn: () => api('/settings', { method: 'PUT', body: { sub_base_url: base, sub_title: title, sub_update_hours: hours } }),
    success: '订阅设置已保存', invalidate: [['settings'], ['user']],
  })
  return (
    <Card title="订阅设置" action={<Button size="sm" variant="primary" isPending={save.isPending} onPress={() => save.mutate()}>保存</Button>}>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="订阅地址前缀" value={base} onChange={setBase} placeholder={location.origin} description="对外的订阅域名，例如 https://sub.example.com；留空使用当前访问地址" />
        <Field label="订阅标题" value={title} onChange={setTitle} description="客户端里显示的配置名" />
        <Field label="更新间隔（小时）" value={hours} onChange={setHours} description="Profile-Update-Interval" />
      </div>
    </Card>
  )
}

const fps = ['', 'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random', 'randomized'].map((x) => ({ id: x, label: x || '沿用入站设置' }))

function HostForm({ h, inbounds, onClose, isOpen }: { h: Partial<Host>; inbounds: Inbound[]; onClose: () => void; isOpen: boolean }) {
  const [v, setV] = useState<Partial<Host>>({ remark: '', address: '', port: 0, sni: '', host: '', path: '', alpn: '', fingerprint: '', allow_insecure: false, sort: 0, ...h })
  const set = <K extends keyof Host>(k: K, x: Host[K]) => setV((o) => ({ ...o, [k]: x }))
  const save = useAction({
    fn: () => {
      const port = Number(v.port) || 0
      if (port < 0 || port > 65535) throw new Error('端口范围 1-65535，留空沿用入站端口')
      const body = { ...v, port, sort: Number(v.sort) || 0 }
      return h.id ? api(`/hosts/${h.id}`, { method: 'PUT', body }) : api('/hosts', { method: 'POST', body })
    },
    success: 'Host 已保存，客户端下次更新订阅时生效', invalidate: [['hosts'], ['user']], onSuccess: onClose,
  })
  return (
    <ModalDialog wide isOpen={isOpen} onOpenChange={(x) => !x && onClose()} title={h.id ? '编辑 Host' : '添加 Host'}
      footer={<><Button onPress={onClose}>取消</Button><Button variant="primary" isPending={save.isPending} isDisabled={!v.inbound_id} onPress={() => save.mutate()}>保存</Button></>}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="入站" value={String(v.inbound_id ?? '')} onChange={(x) => set('inbound_id', Number(x))}
            options={inbounds.map((i) => ({ id: String(i.id), label: `${i.node} / ${i.tag}（${i.type}）` }))} />
          <Field label="备注（客户端里的节点名）" value={v.remark ?? ''} onChange={(x) => set('remark', x)} placeholder="沿用「节点 · 入站」" />
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
          <Field label="地址" value={v.address ?? ''} onChange={(x) => set('address', x)} placeholder="沿用节点公网地址" description="域名或 IP，例如 CDN 域名、中转机地址" />
          <Field label="端口" value={v.port ? String(v.port) : ''} onChange={(x) => set('port', Number(x) || 0)} placeholder="沿用入站" />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="SNI" value={v.sni ?? ''} onChange={(x) => set('sni', x)} placeholder="沿用入站" />
          <Field label="Host 头" value={v.host ?? ''} onChange={(x) => set('host', x)} placeholder="ws/http 传输" />
          <Field label="路径" value={v.path ?? ''} onChange={(x) => set('path', x)} placeholder="沿用入站" />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="ALPN" value={v.alpn ?? ''} onChange={(x) => set('alpn', x)} placeholder="h2,http/1.1" />
          <Select label="uTLS 指纹" value={v.fingerprint ?? ''} onChange={(x) => set('fingerprint', x)} options={fps} />
          <Field label="排序" value={String(v.sort ?? 0)} onChange={(x) => set('sort', Number(x) || 0)} />
        </div>
        <Checkbox isSelected={!!v.allow_insecure} onChange={(x) => set('allow_insecure', x)}>允许不安全证书（自签证书时使用）</Checkbox>
      </div>
    </ModalDialog>
  )
}
