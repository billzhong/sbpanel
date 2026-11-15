import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Group, type Inbound, type Node } from '../lib/api'
import { useAction, useApplyTracker } from '../lib/actions'
import { useRoute, replace } from '../lib/router'
import { Badge, Button, Card, CheckList, Confirm, Empty, Field, IconButton, ModalDialog, PageHeader, Presence, Segmented, Select, Skeleton, Switch, cx, useSticky } from '../ui/kit'
import { IconEdit, IconPlus, IconTrash } from '../ui/icons'
import { HealthDot, IconProbe, ProbeDrawer, useProbeResults, useRunProbe, type ProbeTarget } from '../ui/probe'
import { certLabel, covers, matchCert, useCerts, useDomains, type Cert } from '../lib/certs'
import { href } from '../lib/router'
import { tr } from '../i18n'
import { C } from '../i18n/common'
import { IB } from '../i18n/inbounds'

const T = () => tr(IB)

type Preset = { id: string; label: string; type: string; desc: string; tags: string[]; build: (o: PresetInput) => Promise<{ options: object; client: object }> }
type PresetInput = { port: number; sni: string; handshake: string; path: string } & CertChoice

/** Where an inbound's TLS certificate comes from. */
export type CertChoice = { src: 'panel' | 'path' | 'acme'; certId: string; certPath: string; keyPath: string; email: string }

const randPort = () => 20000 + Math.floor(Math.random() * 40000)

// TLS from a panel certificate (distributed by the master, renewed without rebuilding the inbound),
// certificate files on the node (e.g. certbot), or node-side ACME for the SNI domain.
const tlsFile = (o: PresetInput) => o.src === 'acme'
  ? { enabled: true, server_name: o.sni, acme: { domain: [o.sni], email: o.email, data_directory: '/var/lib/sbnode/acme' } }
  : o.src === 'panel' ? { enabled: true, server_name: o.sni }
    : { enabled: true, server_name: o.sni, certificate_path: o.certPath, key_path: o.keyPath }

/** Rewrites inbound options for a certificate choice (the panel hint _cert lives at the top level). */
export function applyCertChoice(opts: Record<string, any>, c: CertChoice): Record<string, any> {
  const o: Record<string, any> = { ...opts, tls: { ...(opts.tls ?? {}), enabled: true } }
  delete o._cert
  delete o.tls.certificate_path; delete o.tls.key_path; delete o.tls.acme; delete o.tls.certificate; delete o.tls.key
  if (c.src === 'panel') o._cert = c.certId
  else if (c.src === 'path') { o.tls.certificate_path = c.certPath; o.tls.key_path = c.keyPath }
  else o.tls.acme = { domain: [o.tls.server_name ?? ''], email: c.email, data_directory: '/var/lib/sbnode/acme' }
  return o
}

function choiceOf(opts: Record<string, any>): CertChoice {
  const t = opts.tls ?? {}
  if (opts._cert) return { src: 'panel', certId: opts._cert, certPath: '', keyPath: '', email: '' }
  if (t.acme) return { src: 'acme', certId: '', certPath: '', keyPath: '', email: t.acme.email ?? '' }
  return { src: 'path', certId: '', certPath: t.certificate_path ?? '', keyPath: t.key_path ?? '', email: '' }
}

const presets: Preset[] = [
  {
    id: 'vless-reality', label: 'VLESS + REALITY', type: 'vless', get desc() { return T().dReality }, tags: [],
    build: async (o) => {
      const kp = await api<{ private_key: string; public_key: string; short_id: string }>('/tools/reality-keypair', { method: 'POST' })
      const [hs, hp] = o.handshake.split(':')
      return {
        options: {
          listen: '::', listen_port: o.port, _flow: 'xtls-rprx-vision',
          tls: { enabled: true, server_name: o.sni, reality: { enabled: true, handshake: { server: hs || o.sni, server_port: Number(hp) || 443 }, private_key: kp.private_key, short_id: [kp.short_id] } },
        },
        client: { security: 'reality', sni: o.sni, public_key: kp.public_key, short_id: kp.short_id, flow: 'xtls-rprx-vision', fingerprint: 'chrome' },
      }
    },
  },
  {
    id: 'vmess-ws-tls', label: 'VMess + WS + TLS', type: 'vmess', get desc() { return T().dWs }, get tags() { return [T().needsCert, T().needsDomain] },
    build: async (o) => ({
      options: { listen: '::', listen_port: o.port, tls: tlsFile(o), transport: { type: 'ws', path: o.path } },
      client: { security: 'tls', sni: o.sni, network: 'ws', path: o.path },
    }),
  },
  {
    id: 'vless-ws-tls', label: 'VLESS + WS + TLS', type: 'vless', get desc() { return T().dWs }, get tags() { return [T().needsCert, T().needsDomain] },
    build: async (o) => ({
      options: { listen: '::', listen_port: o.port, tls: tlsFile(o), transport: { type: 'ws', path: o.path } },
      client: { security: 'tls', sni: o.sni, network: 'ws', path: o.path },
    }),
  },
  {
    id: 'vless-grpc-tls', label: 'VLESS + gRPC + TLS', type: 'vless', get desc() { return T().dGrpc }, get tags() { return [T().needsCert, T().needsDomain] },
    build: async (o) => ({
      options: { listen: '::', listen_port: o.port, tls: { ...tlsFile(o), alpn: ['h2'] }, transport: { type: 'grpc', service_name: o.path.replace(/^\//, '') || 'grpc' } },
      client: {},
    }),
  },
  {
    id: 'trojan-tls', label: 'Trojan + TLS', type: 'trojan', get desc() { return T().dTrojan }, get tags() { return [T().needsCert, T().needsDomain] },
    build: async (o) => ({ options: { listen: '::', listen_port: o.port, tls: tlsFile(o) }, client: { security: 'tls', sni: o.sni } }),
  },
  {
    id: 'ss2022', label: 'Shadowsocks 2022', type: 'shadowsocks', get desc() { return T().dSs }, tags: [],
    build: async (o) => {
      const k = new Uint8Array(16); crypto.getRandomValues(k)
      return { options: { listen: '::', listen_port: o.port, network: 'tcp', method: '2022-blake3-aes-128-gcm', password: btoa(String.fromCharCode(...k)) }, client: {} }
    },
  },
  {
    id: 'hysteria2', label: 'Hysteria2', type: 'hysteria2', get desc() { return T().dHy2 }, get tags() { return ['UDP', T().needsCert] },
    build: async (o) => ({ options: { listen: '::', listen_port: o.port, tls: { ...tlsFile(o), alpn: ['h3'] } }, client: { sni: o.sni } }),
  },
  {
    id: 'tuic', label: 'TUIC v5', type: 'tuic', get desc() { return T().dTuic }, get tags() { return ['UDP', T().needsCert] },
    build: async (o) => ({ options: { listen: '::', listen_port: o.port, congestion_control: 'bbr', tls: { ...tlsFile(o), alpn: ['h3'] } }, client: { sni: o.sni } }),
  },
  {
    id: 'anytls', label: 'AnyTLS', type: 'anytls', get desc() { return T().dAnytls }, get tags() { return [T().needsCert] },
    build: async (o) => ({ options: { listen: '::', listen_port: o.port, tls: tlsFile(o) }, client: { sni: o.sni } }),
  },
]

export function InboundsPage() {
  const { params } = useRoute()
  const inbounds = useQuery({ queryKey: ['inbounds'], queryFn: () => api<Inbound[]>('/inbounds') })
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<Node[]>('/nodes') })
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => api<Group[]>('/groups') })
  const [editing, setEditing] = useState<Inbound | 'new' | null>(() => (params.get('new') === '1' ? 'new' : null))
  const [preNode] = useState(() => params.get('node') ?? '')
  useEffect(() => { if (params.get('new')) replace('inbounds') }, [params])
  const [deleting, setDeleting] = useState<Inbound | null>(null)
  const delSticky = useSticky(deleting)
  const toggle = useAction({
    fn: (i: Inbound) => api(`/inbounds/${i.id}`, { method: 'PATCH', body: { enabled: !i.enabled } }),
    apply: true, success: (_, i) => T().toggled(i.tag, i.enabled), invalidate: [['inbounds'], ['nodes']],
  })
  const del = useAction({
    fn: (id: number) => api(`/inbounds/${id}`, { method: 'DELETE' }),
    apply: true, success: T().deleted, invalidate: [['inbounds'], ['nodes'], ['groups']],
  })

  const probes = useProbeResults()
  const runProbe = useRunProbe()
  const [probeView, setProbeView] = useState<{ title: string; target: ProbeTarget } | null>(null)
  const probeSticky = useSticky(probeView)
  const probeOf = (id: number) => (probes.data ?? []).filter((r) => r.inbound_id === id)
  const runningFor = (t: ProbeTarget) => runProbe.isPending && (runProbe.variables?.all || runProbe.variables?.inbound_id === t.inbound_id && !!t.inbound_id)
  const test = (title: string, target: ProbeTarget, open = true) => { runProbe.mutate(target); if (open) setProbeView({ title, target }) }
  const viewResults = (() => {
    const t = probeSticky?.target
    if (!t) return []
    return (probes.data ?? []).filter((r) => t.all || r.inbound_id === t.inbound_id)
  })()

  const byNode = new Map<string, Inbound[]>()
  for (const i of inbounds.data ?? []) byNode.set(i.node_id, [...(byNode.get(i.node_id) ?? []), i])

  return (
    <>
      <PageHeader title={T().title} subtitle={T().subtitle}
        actions={<>
          <Button isDisabled={!inbounds.data?.length} isPending={runProbe.isPending && !!runProbe.variables?.all} onPress={() => test(T().allTitle, { all: true })}>{T().testAll}</Button>
          <Button variant="primary" isDisabled={!nodes.data?.length} onPress={() => setEditing('new')}><IconPlus size={16} />{T().newInbound}</Button>
        </>} />
      {inbounds.isLoading && <Skeleton className="h-48" />}
      {inbounds.data?.length === 0 && (
        <Card><Empty title={T().empty} hint={nodes.data?.length ? T().emptyHint : T().emptyNoNode}
          action={nodes.data?.length ? <Button variant="primary" onPress={() => setEditing('new')}>{T().newInbound}</Button> : undefined} /></Card>
      )}
      <div className="flex flex-col gap-4">
        {(nodes.data ?? []).filter((n) => byNode.has(n.id)).map((n) => (
          <Card key={n.id} title={<span>{n.name} <span className="ml-1 text-[13px] font-normal text-subtle">{n.address}</span></span>} pad={false}>
            <div className="overflow-x-auto">
            <table className="w-full text-[13px] whitespace-nowrap">
              <thead className="text-left text-xs text-subtle">
                <tr className="border-b"><th className="w-0 py-2 pr-0 pl-3 font-medium"><span className="sr-only">{T().conn}</span></th><th className="px-3 py-2 font-medium">{T().colTag}</th><th className="px-3 py-2 font-medium">{T().colProto}</th>
                  <th className="px-3 py-2 font-medium">{T().colPort}</th><th className="hidden px-3 py-2 font-medium md:table-cell">{T().colTransport}</th>
                  <th className="px-3 py-2 font-medium">{T().colEnabled}</th><th className="px-5 py-2" /></tr>
              </thead>
              <tbody>
                {byNode.get(n.id)!.map((i) => (
                  <tr key={i.id} className="border-b last:border-0 hover:bg-hl-low">
                    <td className="py-2.5 pr-0 pl-3"><HealthDot results={probeOf(i.id)} running={runningFor({ inbound_id: i.id })} onPress={() => probeOf(i.id).length ? setProbeView({ title: T().connOf(i.tag), target: { inbound_id: i.id } }) : test(T().connOf(i.tag), { inbound_id: i.id })} /></td>
                    <td className="px-3 py-2.5 font-medium">{i.tag}{i.remark && <div className="text-xs font-normal text-muted">{i.remark}</div>}</td>
                    <td className="px-3 py-2.5"><Badge tone="accent">{i.type}</Badge></td>
                    <td className="px-3 py-2.5 font-mono tabular">{i.port}</td>
                    <td className="hidden px-3 py-2.5 text-subtle md:table-cell">{describe(i)}</td>
                    <td className="px-3 py-2.5"><Switch label={T().enableX(i.tag)} isSelected={i.enabled} isDisabled={toggle.isPending && toggle.variables?.id === i.id} onChange={() => toggle.mutate(i)} /></td>
                    <td className="px-5 py-2.5 text-right whitespace-nowrap">
                      <IconButton label={T().testX(i.tag)} isDisabled={!i.enabled} onPress={() => test(T().connOf(i.tag), { inbound_id: i.id })}><IconProbe /></IconButton>
                      <IconButton label={tr(C).edit} onPress={() => setEditing(i)}><IconEdit size={16} /></IconButton>
                      <IconButton label={tr(C).delete} onPress={() => setDeleting(i)}><IconTrash size={16} /></IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </Card>
        ))}
      </div>
      <Presence value={nodes.data ? editing : null}>
        {(e, open) => <InboundEditor isOpen={open} nodes={nodes.data ?? []} groups={groups.data ?? []} value={e === 'new' ? null : e} preNode={preNode} onClose={() => setEditing(null)} />}
      </Presence>
      <ProbeDrawer isOpen={!!probeView} onClose={() => setProbeView(null)} title={probeSticky?.title ?? ''} results={viewResults}
        running={!!probeSticky && runProbe.isPending} onRetry={() => probeSticky && runProbe.mutate(probeSticky.target)} />
      <Confirm isOpen={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} danger title={T().delTitle} confirmLabel={T().delTitle}
        onConfirm={() => deleting && del.mutate(deleting.id)} body={T().delBody(<b className="text-text">{delSticky?.tag}</b>, delSticky?.node ?? '', delSticky?.port ?? '')} />
    </>
  )
}

function describe(i: Inbound): string {
  const o = i.options as any
  const parts: string[] = []
  if (o.transport?.type) parts.push(o.transport.type + (o.transport.path ? ' ' + o.transport.path : ''))
  if (o.tls?.reality?.enabled) parts.push('REALITY · ' + (o.tls.server_name ?? ''))
  else if (o.tls?.enabled) parts.push('TLS' + (o.tls.server_name ? ' · ' + o.tls.server_name : ''))
  if (o.method) parts.push(o.method)
  return parts.join(' · ') || 'tcp'
}

function InboundEditor({ nodes, groups, value, onClose, isOpen, preNode }: { nodes: Node[]; groups: Group[]; value: Inbound | null; onClose: () => void; isOpen: boolean; preNode?: string }) {
  const qc = useQueryClient()
  const track = useApplyTracker()
  const [nodeId, setNodeId] = useState(value?.node_id ?? (nodes.some((n) => n.id === preNode) ? preNode! : nodes[0]?.id ?? ''))
  const [preset, setPreset] = useState(presets[0].id)
  const [tag, setTag] = useState(value?.tag ?? '')
  const [tagTouched, setTagTouched] = useState(!!value)
  const [remark, setRemark] = useState(value?.remark ?? '')
  const region0 = String((value?.options as Record<string, unknown> | undefined)?._region ?? '')
  const [region, setRegion] = useState(region0)
  const [port, setPort] = useState(String(value?.port ?? randPort()))
  const [sni, setSni] = useState('www.microsoft.com')
  const [handshake, setHandshake] = useState('www.microsoft.com:443')
  const [sniTouched, setSniTouched] = useState(false)
  const [path, setPath] = useState('/ws')
  const certs = useCerts()
  const domains = useDomains()
  const [cert, setCertRaw] = useState<CertChoice>({ src: 'path', certId: '', certPath: '/etc/sbnode/cert.pem', keyPath: '/etc/sbnode/key.pem', email: '' })
  const [certTouched, setCertTouched] = useState(false)
  const setCert = (c: CertChoice) => { setCertRaw(c); setCertTouched(true); setJsonTouched(false) }
  const [gids, setGids] = useState<number[]>(value?.group_ids ?? groups.filter((g) => g.is_default).map((g) => g.id))
  const [json, setJson] = useState(value ? JSON.stringify(value.options, null, 2) : '')
  const [client, setClient] = useState(value ? JSON.stringify(value.client, null, 2) : '{}')
  // For new inbounds the JSON is generated from the basic fields at save time unless the admin edited it by hand.
  const [jsonTouched, setJsonTouched] = useState(!!value)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const p = presets.find((x) => x.id === preset)!
  const [type, setType] = useState(value?.type ?? p.type)
  const portN = Number(port)
  const portErr = !Number.isInteger(portN) || portN < 1 || portN > 65535 ? T().portRange : ''

  useEffect(() => { if (!value && !tagTouched) setTag(`${p.id}-${port}`) }, [p, port, value, tagTouched])
  // TLS presets: suggest the node's domain as SNI, and a panel certificate that covers it
  const needsTLS = p.id !== 'vless-reality' && p.id !== 'ss2022'
  useEffect(() => {
    if (value || sniTouched) return
    const d = needsTLS ? domains.data?.find((x) => x.node_id === nodeId) : undefined
    setSni(d ? d.fqdn : 'www.microsoft.com')
  }, [value, sniTouched, needsTLS, nodeId, domains.data])
  useEffect(() => {
    if (value || certTouched || !certs.data) return
    const m = matchCert(certs.data, sni, nodeId)
    setCertRaw((c) => m ? { ...c, src: 'panel', certId: m.id } : { ...c, src: c.src === 'panel' ? 'path' : c.src, certId: '' })
  }, [value, certTouched, certs.data, sni, nodeId])
  useEffect(() => { if (!value && !jsonTouched) setType(p.type) }, [p, value, jsonTouched])

  const build = async () => {
    if (portErr) throw new Error(portErr)
    if (needsTLS && cert.src === 'panel' && !cert.certId) throw new Error(T().pickCert)
    const r = await p.build({ port: portN, sni, handshake, path, ...cert })
    const options = needsTLS && cert.src === 'panel' ? { ...r.options, _cert: cert.certId } : r.options
    return { options, client: r.client }
  }
  const preview = async () => {
    try { const r = await build(); setJson(JSON.stringify(r.options, null, 2)); setClient(JSON.stringify(r.client, null, 2)); setErr('') } catch (e) { setErr((e as Error).message) }
  }

  const save = async () => {
    setErr('')
    setBusy(true)
    try {
      let options: unknown, cl: unknown
      if (!value && !jsonTouched) { const r = await build(); options = r.options; cl = r.client }
      else {
        try { options = JSON.parse(json); cl = JSON.parse(client || '{}') } catch (e) { throw new Error(T().badJson((e as Error).message)) }
      }
      if (options && typeof options === 'object') {
        const o = options as Record<string, unknown>
        if (region) o._region = region; else delete o._region
      }
      if (value) await api(`/inbounds/${value.id}`, { method: 'PATCH', body: { tag, type, options, client: cl, remark, group_ids: gids } })
      else await api('/inbounds', { method: 'POST', body: { node_id: nodeId, tag, type, options, client: cl, remark, group_ids: gids } })
      for (const k of ['groups', 'inbounds', 'nodes', 'hosts']) qc.invalidateQueries({ queryKey: [k] })
      track({ text: value ? T().savedX(tag) : T().createdX(tag) })
      onClose()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const dirty = !value ? (jsonTouched || remark !== '') : (json !== JSON.stringify(value.options, null, 2) || tag !== value.tag || remark !== value.remark || region !== region0 || gids.join() !== value.group_ids.join())
  return (
    <ModalDialog wide isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={value ? T().editX(value.tag) : T().newInbound} dirty={dirty}
      footer={<>{err && <span className="mr-auto max-w-full self-center text-[13px] break-all text-bad">{err}</span>}<Button onPress={onClose}>{tr(C).cancel}</Button>
        <Button variant="primary" isPending={busy} isDisabled={!tag || (!value && !!portErr && !jsonTouched) || (!!value && !json)} onPress={save}>{T().saveDeploy}</Button></>}>
      <div className="flex flex-col gap-5">
        {!value && (
          <>
            <Select label={tr(C).node} className="sm:w-64" value={nodeId} onChange={setNodeId} options={nodes.map((n) => ({ id: n.id, label: n.name }))} />
            <fieldset>
              <legend className="mb-2 text-[13px] font-medium text-subtle">{T().protocol}</legend>
              <div role="radiogroup" aria-label={T().presets} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {presets.map((x) => (
                  <button key={x.id} type="button" role="radio" aria-checked={x.id === preset} onClick={() => { setPreset(x.id); setJsonTouched(false) }}
                    className={cx('flex cursor-pointer flex-col gap-1 rounded-[12px] border p-3 text-left outline-none transition-[border-color,background-color,box-shadow] duration-(--dur-1) focus-visible:ring-2 focus-visible:ring-accent',
                      x.id === preset ? 'border-accent bg-[color-mix(in_srgb,var(--accent)_8%,var(--surface))] shadow-[inset_0_0_0_1px_var(--accent)]' : 'bg-base hover:border-hl-high')}>
                    <span className="flex items-center gap-2">
                      <span className={cx('grid h-6 min-w-6 place-items-center rounded-[6px] px-1 font-mono text-[10px] font-semibold uppercase', x.id === preset ? 'bg-accent text-on-accent' : 'bg-overlay text-subtle')}>{x.type.slice(0, 2)}</span>
                      <span className="text-sm font-medium">{x.label}</span>
                    </span>
                    <span className="text-xs text-subtle">{x.desc}</span>
                    {x.tags.length > 0 && <span className="flex flex-wrap gap-1">{x.tags.map((t) => <span key={t} className={cx('rounded-full px-1.5 text-[11px]', t === 'UDP' ? 'bg-iris/15 text-iris' : 'bg-warn/12 text-warn')}>{t}</span>)}</span>}
                  </button>
                ))}
              </div>
            </fieldset>
            <div key={preset} className="grid animate-content-in gap-3 sm:grid-cols-2">
              <Field label={T().listenPort} value={port} onChange={(v) => { setPort(v); setJsonTouched(false) }} inputMode="numeric" isInvalid={!!portErr} errorMessage={portErr} />
              {p.id !== 'ss2022' && <Field label={T().sni} value={sni} onChange={(v) => { setSni(v); setSniTouched(true) }} description={p.id === 'vless-reality' ? T().sniReality : T().sniTls} />}
              {p.id === 'vless-reality' && <Field label={T().handshake} value={handshake} onChange={setHandshake} description={T().handshakeHint} />}
              {(p.id === 'vmess-ws-tls' || p.id === 'vless-ws-tls') && <Field label={T().wsPath} value={path} onChange={setPath} />}
              {p.id === 'vless-grpc-tls' && <Field label={T().grpcName} value={path} onChange={setPath} />}
              {needsTLS && <div className="sm:col-span-2"><CertSourcePicker value={cert} onChange={setCert} certs={certs.data ?? []} nodeId={nodeId} sni={sni} /></div>}
            </div>
          </>
        )}
        {value && <EditCertSource json={json} setJson={(j) => { setJson(j); setJsonTouched(true) }} certs={certs.data ?? []} nodeId={value.node_id} />}
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_9rem]">
          <Field label={T().tag} value={tag} onChange={(v) => { setTag(v); setTagTouched(true) }} mono />
          <Field label={T().remark} value={remark} onChange={setRemark} placeholder={T().optional} />
          <Field label={T().exitRegion} value={region} onChange={(v) => setRegion(v.toUpperCase().slice(0, 2))} placeholder={T().optional} description={T().exitRegionHint} />
        </div>
        <CheckList label={T().groups} value={gids} onChange={setGids}
          options={groups.map((g) => ({ id: g.id, label: g.name, hint: T().usersN(g.users) }))} />
        <details className="group rounded-[12px] border" onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open && !value && !jsonTouched) preview() }}>
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-[13px] font-medium text-subtle outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
            {T().advanced}{jsonTouched && !value && <span className="ml-2 text-xs font-normal text-warn">{T().manual}</span>}
            <span className="ml-auto transition-transform duration-(--dur-2) group-open:rotate-180">▾</span>
          </summary>
          <div className="flex animate-content-in flex-col gap-3 border-t p-4">
            <div className="grid gap-3 sm:grid-cols-3"><Field label={T().type} value={type} onChange={(v) => { setType(v); setJsonTouched(true) }} mono /></div>
            <Field label={T().options} multiline rows={14} mono value={json} onChange={(v) => { setJson(v); setJsonTouched(true) }}
              description={T().optionsHint} />
            <Field label={T().client} multiline rows={4} mono value={client} onChange={(v) => { setClient(v); setJsonTouched(true) }} />
            {!value && <div><Button size="sm" onPress={preview}>{T().regen}</Button></div>}
          </div>
        </details>
      </div>
    </ModalDialog>
  )
}

/** Certificate source: panel certificate (select), files on the node, or node-side ACME. */
function CertSourcePicker({ value, onChange, certs, nodeId, sni }: { value: CertChoice; onChange: (c: CertChoice) => void; certs: Cert[]; nodeId: string; sni: string }) {
  const usable = certs.filter((c) => c.has_material && (c.source !== 'node' || c.node_id === nodeId) || c.id === value.certId)
  const sel = certs.find((c) => c.id === value.certId)
  const mismatch = value.src === 'panel' && sel && sni && !covers(sel.sans, sni)
  return (
    <fieldset className="flex flex-col gap-3 rounded-[12px] border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <legend className="text-[13px] font-medium text-subtle">{T().certSource}</legend>
        <Segmented label={T().certSource} value={value.src} onChange={(src) => onChange({ ...value, src, certId: src === 'panel' ? (value.certId || matchCert(certs, sni, nodeId)?.id || usable[0]?.id || '') : value.certId })}
          options={[{ id: 'panel', label: T().srcPanel }, { id: 'path', label: T().srcPath }, { id: 'acme', label: T().srcAcme }]} />
      </div>
      {value.src === 'panel' && (usable.length ? (
        <>
          <Select label={T().cert} value={value.certId} onChange={(certId) => onChange({ ...value, certId })} placeholder={T().chooseCert}
            options={usable.map((c) => ({ id: c.id, label: certLabel(c) }))}
            description={T().certHint} />
          {mismatch && <span className="text-xs text-warn">{T().certMismatch(sni)}</span>}
        </>
      ) : (
        <p className="text-[13px] text-subtle">{T().noCerts}<a className="text-accent underline-offset-2 hover:underline" href={href('certs')}>{T().goCerts}</a></p>
      ))}
      {value.src === 'path' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={T().certPath} value={value.certPath} onChange={(certPath) => onChange({ ...value, certPath })} mono placeholder="/etc/letsencrypt/live/example.com/fullchain.pem" />
          <Field label={T().keyPath} value={value.keyPath} onChange={(keyPath) => onChange({ ...value, keyPath })} mono placeholder="/etc/letsencrypt/live/example.com/privkey.pem" />
          <p className="text-xs text-muted sm:col-span-2">{T().pathNote}</p>
        </div>
      )}
      {value.src === 'acme' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={T().acmeEmail} value={value.email} onChange={(email) => onChange({ ...value, email })} placeholder={T().optional} />
          <p className="self-end text-xs text-muted">{T().acmeNote}</p>
        </div>
      )}
    </fieldset>
  )
}

/** For existing inbounds: edits the certificate part of the JSON in place. */
function EditCertSource({ json, setJson, certs, nodeId }: { json: string; setJson: (j: string) => void; certs: Cert[]; nodeId: string }) {
  let opts: Record<string, any> | null = null
  try { opts = JSON.parse(json) } catch { /* invalid JSON: the JSON editor shows it */ }
  if (!opts?.tls?.enabled || opts.tls.reality?.enabled) return null
  const cur = choiceOf(opts)
  const onChange = (c: CertChoice) => setJson(JSON.stringify(applyCertChoice(opts!, c), null, 2))
  return <CertSourcePicker value={cur} onChange={onChange} certs={certs} nodeId={nodeId} sni={opts.tls.server_name ?? ''} />
}
