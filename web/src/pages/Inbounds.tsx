import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Inbound, type Node } from '../lib/api'
import { Badge, Button, Card, Confirm, Empty, Field, IconButton, ModalDialog, PageHeader, Select, Skeleton, Switch, useToast } from '../ui/kit'
import { IconEdit, IconPlus, IconTrash } from '../ui/icons'

type Preset = { id: string; label: string; type: string; build: (o: PresetInput) => Promise<{ options: object; client: object }> }
type PresetInput = { port: number; sni: string; handshake: string; certPath: string; keyPath: string; path: string }

const randPort = () => 20000 + Math.floor(Math.random() * 40000)

const tlsFile = (o: PresetInput) => ({ enabled: true, server_name: o.sni, certificate_path: o.certPath, key_path: o.keyPath })

const presets: Preset[] = [
  {
    id: 'vless-reality', label: 'VLESS + REALITY（推荐）', type: 'vless',
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
    id: 'vmess-ws-tls', label: 'VMess + WebSocket + TLS', type: 'vmess',
    build: async (o) => ({
      options: { listen: '::', listen_port: o.port, tls: tlsFile(o), transport: { type: 'ws', path: o.path } },
      client: { security: 'tls', sni: o.sni, network: 'ws', path: o.path },
    }),
  },
  {
    id: 'trojan-tls', label: 'Trojan + TLS', type: 'trojan',
    build: async (o) => ({ options: { listen: '::', listen_port: o.port, tls: tlsFile(o) }, client: { security: 'tls', sni: o.sni } }),
  },
  {
    id: 'ss2022', label: 'Shadowsocks 2022', type: 'shadowsocks',
    build: async (o) => {
      const k = new Uint8Array(16); crypto.getRandomValues(k)
      return { options: { listen: '::', listen_port: o.port, network: 'tcp', method: '2022-blake3-aes-128-gcm', password: btoa(String.fromCharCode(...k)) }, client: {} }
    },
  },
  {
    id: 'hysteria2', label: 'Hysteria2', type: 'hysteria2',
    build: async (o) => ({ options: { listen: '::', listen_port: o.port, tls: { ...tlsFile(o), alpn: ['h3'] } }, client: { sni: o.sni } }),
  },
  {
    id: 'tuic', label: 'TUIC v5', type: 'tuic',
    build: async (o) => ({ options: { listen: '::', listen_port: o.port, congestion_control: 'bbr', tls: { ...tlsFile(o), alpn: ['h3'] } }, client: { sni: o.sni } }),
  },
  {
    id: 'anytls', label: 'AnyTLS', type: 'anytls',
    build: async (o) => ({ options: { listen: '::', listen_port: o.port, tls: tlsFile(o) }, client: { sni: o.sni } }),
  },
]

export function InboundsPage() {
  const qc = useQueryClient()
  const toast = useToast()
  const inbounds = useQuery({ queryKey: ['inbounds'], queryFn: () => api<Inbound[]>('/inbounds') })
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<Node[]>('/nodes') })
  const [editing, setEditing] = useState<Inbound | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Inbound | null>(null)
  const toggle = useMutation({
    mutationFn: (i: Inbound) => api(`/inbounds/${i.id}`, { method: 'PATCH', body: { enabled: !i.enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inbounds'] }),
    onError: (e) => toast('bad', (e as Error).message),
  })
  const del = useMutation({
    mutationFn: (id: number) => api(`/inbounds/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast('good', '已删除'); qc.invalidateQueries({ queryKey: ['inbounds'] }) },
  })

  const byNode = new Map<string, Inbound[]>()
  for (const i of inbounds.data ?? []) byNode.set(i.node_id, [...(byNode.get(i.node_id) ?? []), i])

  return (
    <>
      <PageHeader title="入站" subtitle="节点上实际监听的协议端口。所有启用的用户都会下发到每个入站；保存后几秒内由节点热更新，不重启内核"
        actions={<Button variant="primary" isDisabled={!nodes.data?.length} onPress={() => setEditing('new')}><IconPlus size={16} />新建入站</Button>} />
      {inbounds.isLoading && <Skeleton className="h-48" />}
      {inbounds.data?.length === 0 && (
        <Card><Empty title="还没有入站" hint={nodes.data?.length ? '选一个协议模板，几秒钟就能在节点上监听' : '先添加并接入一个节点'}
          action={nodes.data?.length ? <Button variant="primary" onPress={() => setEditing('new')}>新建入站</Button> : undefined} /></Card>
      )}
      <div className="flex flex-col gap-4">
        {(nodes.data ?? []).filter((n) => byNode.has(n.id)).map((n) => (
          <Card key={n.id} title={<span>{n.name} <span className="ml-1 text-[13px] font-normal text-subtle">{n.address}</span></span>} pad={false}>
            <table className="w-full text-[13px]">
              <thead className="text-left text-xs text-subtle">
                <tr className="border-b"><th className="px-5 py-2 font-medium">标签</th><th className="px-3 py-2 font-medium">协议</th>
                  <th className="px-3 py-2 font-medium">端口</th><th className="hidden px-3 py-2 font-medium md:table-cell">传输 / 安全</th>
                  <th className="px-3 py-2 font-medium">启用</th><th className="px-5 py-2" /></tr>
              </thead>
              <tbody>
                {byNode.get(n.id)!.map((i) => (
                  <tr key={i.id} className="border-b last:border-0 hover:bg-hl-low">
                    <td className="px-5 py-2.5 font-medium">{i.tag}{i.remark && <div className="text-xs font-normal text-muted">{i.remark}</div>}</td>
                    <td className="px-3 py-2.5"><Badge tone="accent">{i.type}</Badge></td>
                    <td className="px-3 py-2.5 font-mono tabular">{i.port}</td>
                    <td className="hidden px-3 py-2.5 text-subtle md:table-cell">{describe(i)}</td>
                    <td className="px-3 py-2.5"><Switch isSelected={i.enabled} onChange={() => toggle.mutate(i)} /></td>
                    <td className="px-5 py-2.5 text-right whitespace-nowrap">
                      <IconButton label="编辑" onPress={() => setEditing(i)}><IconEdit size={16} /></IconButton>
                      <IconButton label="删除" onPress={() => setDeleting(i)}><IconTrash size={16} /></IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ))}
      </div>
      {editing && <InboundEditor nodes={nodes.data ?? []} value={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <Confirm isOpen={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} danger title="删除入站" confirmLabel="删除"
        onConfirm={() => deleting && del.mutate(deleting.id)} body={<>删除 <b className="text-text">{deleting?.tag}</b> 会立刻断开它上面的所有连接。</>} />
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

function InboundEditor({ nodes, value, onClose }: { nodes: Node[]; value: Inbound | null; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [nodeId, setNodeId] = useState(value?.node_id ?? nodes[0]?.id ?? '')
  const [preset, setPreset] = useState(presets[0].id)
  const [tag, setTag] = useState(value?.tag ?? '')
  const [remark, setRemark] = useState(value?.remark ?? '')
  const [port, setPort] = useState(String(value?.port ?? randPort()))
  const [sni, setSni] = useState('www.microsoft.com')
  const [handshake, setHandshake] = useState('www.microsoft.com:443')
  const [certPath, setCertPath] = useState('/etc/sbnode/cert.pem')
  const [keyPath, setKeyPath] = useState('/etc/sbnode/key.pem')
  const [path, setPath] = useState('/ws')
  const [json, setJson] = useState(value ? JSON.stringify(value.options, null, 2) : '')
  const [client, setClient] = useState(value ? JSON.stringify(value.client, null, 2) : '{}')
  const [busy, setBusy] = useState(false)
  const p = presets.find((x) => x.id === preset)!
  const [type, setType] = useState(value?.type ?? p.type)

  useEffect(() => { if (!value && !tag) setTag(p.id) }, [p, value, tag])

  const generate = async () => {
    try {
      const r = await p.build({ port: Number(port), sni, handshake, certPath, keyPath, path })
      setJson(JSON.stringify(r.options, null, 2))
      setClient(JSON.stringify(r.client, null, 2))
      setType(p.type)
      if (!value) setTag(p.id + '-' + port)
    } catch (e) { toast('bad', (e as Error).message) }
  }

  const save = async () => {
    let options: any, cl: any
    try { options = JSON.parse(json); cl = JSON.parse(client || '{}') } catch (e) { toast('bad', 'JSON 格式错误：' + (e as Error).message); return }
    setBusy(true)
    try {
      if (value) await api(`/inbounds/${value.id}`, { method: 'PATCH', body: { tag, type, options, client: cl, remark } })
      else await api('/inbounds', { method: 'POST', body: { node_id: nodeId, tag, type, options, client: cl, remark } })
      toast('good', '已保存，正在下发到节点')
      qc.invalidateQueries({ queryKey: ['inbounds'] })
      qc.invalidateQueries({ queryKey: ['nodes'] })
      onClose()
    } catch (e) { toast('bad', (e as Error).message) } finally { setBusy(false) }
  }

  const needsTLS = p.id !== 'vless-reality' && p.id !== 'ss2022'
  return (
    <ModalDialog wide isOpen onOpenChange={(v) => !v && onClose()} title={value ? `编辑入站 ${value.tag}` : '新建入站'}
      footer={<><Button onPress={onClose}>取消</Button><Button variant="primary" isDisabled={busy || !json || !tag} onPress={save}>保存并下发</Button></>}>
      <div className="flex flex-col gap-4">
        {!value && (
          <div className="rounded-[12px] border bg-base p-4">
            <div className="mb-3 text-[13px] font-medium">1 · 从模板生成</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Select label="节点" value={nodeId} onChange={setNodeId} options={nodes.map((n) => ({ id: n.id, label: n.name }))} />
              <Select label="协议模板" value={preset} onChange={setPreset} options={presets.map((x) => ({ id: x.id, label: x.label }))} />
              <Field label="监听端口" value={port} onChange={setPort} />
              {p.id !== 'ss2022' && <Field label="SNI / 域名" value={sni} onChange={setSni} />}
              {p.id === 'vless-reality' && <Field label="REALITY 握手目标" value={handshake} onChange={setHandshake} description="host:port，需支持 TLS 1.3" />}
              {p.id === 'vmess-ws-tls' && <Field label="WebSocket 路径" value={path} onChange={setPath} />}
              {needsTLS && <><Field label="证书路径（节点上）" value={certPath} onChange={setCertPath} mono /><Field label="私钥路径（节点上）" value={keyPath} onChange={setKeyPath} mono /></>}
            </div>
            <Button className="mt-3" onPress={generate}>{json ? '重新生成' : '生成配置'}</Button>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="标签（唯一）" value={tag} onChange={setTag} mono />
          <Field label="类型" value={type} onChange={setType} mono />
          <Field label="备注" value={remark} onChange={setRemark} />
        </div>
        <Field label="sing-box 入站选项（不含 users，由面板注入）" multiline rows={14} mono value={json} onChange={setJson}
          description="以 _ 开头的键只给面板用，例如 _flow 指定 VLESS 用户的 flow。" />
        <Field label="客户端参数（生成订阅用）" multiline rows={4} mono value={client} onChange={setClient} />
      </div>
    </ModalDialog>
  )
}
