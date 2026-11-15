import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Host, type Inbound, type Node, type Settings } from '../lib/api'
import { useAction } from '../lib/actions'
import { Badge, Button, Callout, Card, Checkbox, Confirm, Empty, Field, IconButton, ModalDialog, PageHeader, Presence, Select, Skeleton, Switch, Tabs } from '../ui/kit'
import { go, useRoute } from '../lib/router'
import { SubPageTab } from './subscriptions/SubPage'
import { RoutingTab } from './subscriptions/Routing'
import { IconEdit, IconPlus, IconTrash } from '../ui/icons'
import { tr, useT } from '../i18n'
import { S } from '../i18n/subscriptions'

type SubTab = 'links' | 'routing' | 'hosts' | 'subpage'

/** Tab definitions in one place: a new tab is a one-line addition here. */
const SUB_TABS: { id: SubTab; readonly label: string; el: () => ReactNode }[] = [
  { id: 'links', get label() { return tr(S).tabLinks }, el: () => <LinksTab /> },
  { id: 'routing', get label() { return tr(S).tabRouting }, el: () => <RoutingTab /> },
  { id: 'hosts', get label() { return tr(S).tabHosts }, el: () => <HostsTab /> },
  { id: 'subpage', get label() { return tr(S).tabSubpage }, el: () => <SubPageTab /> },
]

export function SubscriptionsPage() {
  const { params } = useRoute()
  const t = useT(S)
  const tab = SUB_TABS.find((x) => x.id === params.get('tab')) ?? SUB_TABS[0]
  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle} />
      <Tabs value={tab.id} onChange={(x) => go('subscriptions', { tab: x })} tabs={SUB_TABS.map(({ id, label }) => ({ id, label }))} label={t.tabsLabel} />
      <div key={tab.id} className="animate-content-in">{tab.el()}</div>
    </>
  )
}

function LinksTab() {
  const t = useT(S)
  return (
    <div className="flex flex-col gap-4">
      <SubSettings />
      <Card title={t.fmtTitle}>
        <dl className="grid gap-x-4 gap-y-2 text-[13px] sm:grid-cols-[180px_1fr]">
          <dt className="text-subtle">{t.path}</dt><dd>{t.pathDd(<span className="font-mono">/s/&lt;{t.token}&gt;</span>, <span className="font-mono">/sub/&lt;subId&gt;</span>)}</dd>
          <dt className="text-subtle">{t.auto}</dt><dd>{t.autoDd}</dd>
          <dt className="text-subtle">{t.forceFmt}</dt><dd className="font-mono text-[12.5px]">?format=base64 · links · singbox · mihomo · surge · html · json</dd>
          <dt className="text-subtle">{t.profile}</dt><dd>{t.profileDd(<span className="font-mono">?profile=&lt;{t.slug}&gt;</span>, (l) => <a className="text-accent hover:underline" href="#/subscriptions?tab=routing">{l}</a>)}</dd>
          <dt className="text-subtle">{t.pageData}</dt><dd>{t.pageDataDd(<span className="font-mono">?format=json</span>)}</dd>
        </dl>
      </Card>
    </div>
  )
}

function HostsTab() {
  const t = useT(S)
  const inbounds = useQuery({ queryKey: ['inbounds'], queryFn: () => api<Inbound[]>('/inbounds') })
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<Node[]>('/nodes') })
  const hosts = useQuery({ queryKey: ['hosts'], queryFn: () => api<Host[]>('/hosts') })
  const [editing, setEditing] = useState<Partial<Host> | null>(null)
  const [deleting, setDeleting] = useState<Host | null>(null)
  const toggle = useAction({
    fn: (h: Host) => api(`/hosts/${h.id}`, { method: 'PUT', body: { ...h, enabled: !h.enabled } }),
    invalidate: [['hosts']], success: (_, h) => t.hostToggled(h.enabled),
  })
  const del = useAction({
    fn: (id: number) => api(`/hosts/${id}`, { method: 'DELETE' }),
    success: t.hostDeleted, invalidate: [['hosts']],
  })
  const nodeOf = new Map((nodes.data ?? []).map((n) => [n.id, n]))
  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">{t.hostsTitle}</h2>
        <Button variant="primary" isDisabled={!inbounds.data?.length} onPress={() => setEditing({ inbound_id: inbounds.data?.[0]?.id, enabled: true, sort: 0 })}>
          <IconPlus size={16} />{t.addHost}
        </Button>
      </div>
      <Callout>{t.hostsIntro}</Callout>
      {inbounds.isLoading && <Skeleton className="mt-4 h-40" />}
      {inbounds.data?.length === 0 && <Card className="mt-4"><Empty title={t.noInbounds} hint={t.noInboundsHint} /></Card>}
      <div className="mt-4 flex flex-col gap-3">
        {inbounds.data?.map((i) => {
          const hs = (hosts.data ?? []).filter((h) => h.inbound_id === i.id)
          const n = nodeOf.get(i.node_id)
          const def = n?.public_address || n?.address || t.nodeOffline
          return (
            <Card key={i.id} pad={false} title={<span>{i.node} / {i.tag} <Badge tone="accent">{i.type}</Badge></span>}
              action={<Button size="sm" onPress={() => setEditing({ inbound_id: i.id, enabled: true, sort: hs.length })}><IconPlus size={14} />Host</Button>}>
              {hs.length === 0 ? (
                <div className="px-5 pt-1 pb-4 text-[13px] text-subtle">{t.defaultAddr}<span className="font-mono text-text">{def}:{i.port}</span>
                  {!n?.public_address && <span className="ml-2 text-xs text-warn">{t.setPublic}</span>}</div>
              ) : (
                <div className="overflow-x-auto">
                <table className="w-full text-[13px] whitespace-nowrap">
                  <thead className="text-left text-xs text-subtle"><tr className="border-b">
                    <th className="px-5 py-2 font-medium">{t.remark}</th><th className="px-3 py-2 font-medium">{t.address}</th>
                    <th className="hidden px-3 py-2 font-medium md:table-cell">SNI / Host / Path</th><th className="px-3 py-2 font-medium">{t.enabled}</th><th className="px-5 py-2" />
                  </tr></thead>
                  <tbody>
                    {hs.map((h) => (
                      <tr key={h.id} className="border-b last:border-0 hover:bg-hl-low">
                        <td className="px-5 py-2.5">{h.remark || <span className="text-muted">{t.inheritName}</span>}</td>
                        <td className="px-3 py-2.5 font-mono text-[12.5px]">{h.address || def}:{h.port || i.port}</td>
                        <td className="hidden px-3 py-2.5 font-mono text-xs text-subtle md:table-cell">{[h.sni, h.host, h.path].filter(Boolean).join(' · ') || '—'}</td>
                        <td className="px-3 py-2.5"><Switch label={t.enableX(h.remark || h.address || 'Host')} isSelected={h.enabled} onChange={() => toggle.mutate(h)} /></td>
                        <td className="px-5 py-2.5 text-right whitespace-nowrap">
                          <IconButton label={t.editHost} onPress={() => setEditing(h)}><IconEdit size={16} /></IconButton>
                          <IconButton label={t.deleteHost} onPress={() => setDeleting(h)}><IconTrash size={16} /></IconButton>
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
      <Confirm isOpen={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} danger title={t.deleteHost} confirmLabel={t.deleteHost}
        onConfirm={() => deleting && del.mutate(deleting.id)} body={t.deleteBody} />
    </>
  )
}

function SubSettings() {
  const t = useT(S)
  const s = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/settings') })
  const [base, setBase] = useState('')
  const [title, setTitle] = useState('')
  const [hours, setHours] = useState('12')
  useEffect(() => {
    if (s.data) { setBase(s.data.sub_base_url); setTitle(s.data.sub_title); setHours(s.data.sub_update_hours) }
  }, [s.data])
  const save = useAction({
    fn: () => api('/settings', { method: 'PUT', body: { sub_base_url: base, sub_title: title, sub_update_hours: hours } }),
    success: t.subSaved, invalidate: [['settings'], ['user']],
  })
  return (
    <Card title={t.subSettings} action={<Button size="sm" variant="primary" isPending={save.isPending} onPress={() => save.mutate()}>{t.save}</Button>}>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label={t.baseUrl} value={base} onChange={setBase} placeholder={location.origin} description={t.baseUrlDesc} />
        <Field label={t.subTitle} value={title} onChange={setTitle} description={t.subTitleDesc} />
        <Field label={t.hours} value={hours} onChange={setHours} description="Profile-Update-Interval" />
      </div>
    </Card>
  )
}

const fps = () => ['', 'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random', 'randomized'].map((x) => ({ id: x, label: x || tr(S).fpInherit }))

function HostForm({ h, inbounds, onClose, isOpen }: { h: Partial<Host>; inbounds: Inbound[]; onClose: () => void; isOpen: boolean }) {
  const [v, setV] = useState<Partial<Host>>({ remark: '', address: '', port: 0, sni: '', host: '', path: '', alpn: '', fingerprint: '', allow_insecure: false, sort: 0, ...h })
  const set = <K extends keyof Host>(k: K, x: Host[K]) => setV((o) => ({ ...o, [k]: x }))
  const t = useT(S)
  const save = useAction({
    fn: () => {
      const port = Number(v.port) || 0
      if (port < 0 || port > 65535) throw new Error(t.portErr)
      const body = { ...v, port, sort: Number(v.sort) || 0 }
      return h.id ? api(`/hosts/${h.id}`, { method: 'PUT', body }) : api('/hosts', { method: 'POST', body })
    },
    success: t.hostSaved, invalidate: [['hosts'], ['user']], onSuccess: onClose,
  })
  return (
    <ModalDialog wide isOpen={isOpen} onOpenChange={(x) => !x && onClose()} title={h.id ? t.editHost : t.addHost}
      footer={<><Button onPress={onClose}>{t.cancel}</Button><Button variant="primary" isPending={save.isPending} isDisabled={!v.inbound_id} onPress={() => save.mutate()}>{t.save}</Button></>}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label={t.inbound} value={String(v.inbound_id ?? '')} onChange={(x) => set('inbound_id', Number(x))}
            options={inbounds.map((i) => ({ id: String(i.id), label: `${i.node} / ${i.tag} (${i.type})` }))} />
          <Field label={t.hostRemark} value={v.remark ?? ''} onChange={(x) => set('remark', x)} placeholder={t.hostRemarkPh} />
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
          <Field label={t.address} value={v.address ?? ''} onChange={(x) => set('address', x)} placeholder={t.addrPh} description={t.addrDesc} />
          <Field label={t.port} value={v.port ? String(v.port) : ''} onChange={(x) => set('port', Number(x) || 0)} placeholder={t.inheritInbound} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="SNI" value={v.sni ?? ''} onChange={(x) => set('sni', x)} placeholder={t.inheritInbound} />
          <Field label={t.hostHeader} value={v.host ?? ''} onChange={(x) => set('host', x)} placeholder={t.hostHeaderPh} />
          <Field label={t.pathF} value={v.path ?? ''} onChange={(x) => set('path', x)} placeholder={t.inheritInbound} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="ALPN" value={v.alpn ?? ''} onChange={(x) => set('alpn', x)} placeholder="h2,http/1.1" />
          <Select label={t.utls} value={v.fingerprint ?? ''} onChange={(x) => set('fingerprint', x)} options={fps()} />
          <Field label={t.sort} value={String(v.sort ?? 0)} onChange={(x) => set('sort', Number(x) || 0)} />
        </div>
        <Checkbox isSelected={!!v.allow_insecure} onChange={(x) => set('allow_insecure', x)}>{t.insecure}</Checkbox>
      </div>
    </ModalDialog>
  )
}
