import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MenuTrigger, Menu, MenuItem, Popover } from 'react-aria-components'
import { api, type Node, type Enroll } from '../lib/api'
import { bytes, parseSize, dateTime } from '../lib/fmt'
import { Button, Card, Confirm, CopyText, Empty, Field, IconButton, ModalDialog, PageHeader, Skeleton, useToast } from '../ui/kit'
import { IconMore, IconPlus } from '../ui/icons'
import { NodeCard } from './Overview'

export function NodesPage() {
  const qc = useQueryClient()
  const toast = useToast()
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<Node[]>('/nodes'), refetchInterval: 5000 })
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [enroll, setEnroll] = useState<Enroll | null>(null)
  const [editing, setEditing] = useState<Node | null>(null)
  const [deleting, setDeleting] = useState<Node | null>(null)
  const [specOf, setSpecOf] = useState<Node | null>(null)

  const create = useMutation({
    mutationFn: () => api<Enroll>('/nodes', { method: 'POST', body: { name } }),
    onSuccess: (e) => { setAdding(false); setName(''); setEnroll(e); qc.invalidateQueries({ queryKey: ['nodes'] }) },
    onError: (e) => toast('bad', (e as Error).message),
  })
  const token = useMutation({
    mutationFn: (id: string) => api<Enroll>(`/nodes/${id}/token`, { method: 'POST' }),
    onSuccess: setEnroll,
  })
  const del = useMutation({
    mutationFn: (id: string) => api(`/nodes/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast('good', '节点已删除'); qc.invalidateQueries({ queryKey: ['nodes'] }) },
  })

  return (
    <>
      <PageHeader title="节点" subtitle="节点进程主动连接 master（mTLS），离线时按最后一次配置继续服务，流量在本地落盘后补传"
        actions={<Button variant="primary" onPress={() => setAdding(true)}><IconPlus size={16} />添加节点</Button>} />
      {nodes.isLoading && <div className="grid gap-4 md:grid-cols-2"><Skeleton className="h-64" /><Skeleton className="h-64" /></div>}
      {nodes.data?.length === 0 && (
        <Card><Empty title="还没有节点" hint="添加节点后会得到一行接入命令，在服务器上执行即可完成 mTLS 证书签发并上线"
          action={<Button variant="primary" onPress={() => setAdding(true)}>添加节点</Button>} /></Card>
      )}
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {nodes.data?.map((n) => (
          <NodeCard key={n.id} n={n} actions={
            <MenuTrigger>
              <IconButton label="节点操作"><IconMore /></IconButton>
              <Popover placement="bottom end" className="min-w-[180px] rounded-[12px] border bg-surface p-1 shadow-[0_8px_24px_rgb(0_0_0/0.12)] animate-pop">
                <Menu className="outline-none" onAction={(k) => {
                  if (k === 'edit') setEditing(n)
                  if (k === 'token') token.mutate(n.id)
                  if (k === 'spec') setSpecOf(n)
                  if (k === 'delete') setDeleting(n)
                }}>
                  <MenuItem id="edit" className="cursor-pointer rounded-[8px] px-3 py-1.5 text-sm outline-none focus:bg-overlay">编辑</MenuItem>
                  <MenuItem id="token" className="cursor-pointer rounded-[8px] px-3 py-1.5 text-sm outline-none focus:bg-overlay">{n.enrolled ? '重新接入（换证书）' : '生成接入命令'}</MenuItem>
                  <MenuItem id="spec" className="cursor-pointer rounded-[8px] px-3 py-1.5 text-sm outline-none focus:bg-overlay">查看下发配置</MenuItem>
                  <MenuItem id="delete" className="cursor-pointer rounded-[8px] px-3 py-1.5 text-sm text-love outline-none focus:bg-love/10">删除节点</MenuItem>
                </Menu>
              </Popover>
            </MenuTrigger>
          } />
        ))}
      </div>

      <ModalDialog isOpen={adding} onOpenChange={setAdding} title="添加节点"
        footer={<><Button onPress={() => setAdding(false)}>取消</Button>
          <Button variant="primary" isDisabled={!name.trim() || create.isPending} onPress={() => create.mutate()}>创建并生成接入命令</Button></>}>
        <Field label="节点名称" value={name} onChange={setName} placeholder="例如 dmit-la" autoFocus />
      </ModalDialog>

      <ModalDialog wide isOpen={!!enroll} onOpenChange={(v) => !v && setEnroll(null)} title="接入节点"
        footer={<Button variant="primary" onPress={() => setEnroll(null)}>完成</Button>}>
        {enroll && (
          <div className="flex flex-col gap-4 text-[13px]">
            <p className="text-subtle">在节点服务器上执行以下命令。令牌一次性有效，{dateTime(enroll.expires_at)} 前使用。节点会生成自己的私钥，只把证书请求发给 master；之后通过 CA 指纹校验 master 身份。</p>
            <Step n={1} title="接入（签发 mTLS 证书）"><Code text={enroll.command} /></Step>
            <Step n={2} title="启动节点"><Code text="sbnode run" /></Step>
            <div className="rounded-[10px] bg-overlay px-3 py-2 text-xs text-subtle">
              master 地址 <span className="font-mono text-text">{enroll.master}</span>，CA SHA-256 <span className="font-mono break-all text-text">{enroll.ca_sha256}</span>。
              如果节点要通过别的地址访问 master，启动 sbmaster 时加 <span className="font-mono">--public-grpc host:port</span>。
            </div>
          </div>
        )}
      </ModalDialog>

      {editing && <EditNode n={editing} onClose={() => setEditing(null)} />}
      {specOf && <SpecView n={specOf} onClose={() => setSpecOf(null)} />}
      <Confirm isOpen={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} danger title="删除节点"
        confirmLabel="删除" onConfirm={() => deleting && del.mutate(deleting.id)}
        body={<>删除 <b className="text-text">{deleting?.name}</b> 会同时删除它的入站，并立刻吊销节点证书。历史流量保留。</>} />
    </>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 font-medium"><span className="grid h-5 w-5 place-items-center rounded-full bg-accent text-[11px] text-on-accent">{n}</span>{title}</div>
      {children}
    </div>
  )
}

function Code({ text }: { text: string }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-[10px] border bg-base px-3 py-2.5">
      <code className="font-mono text-[12.5px] break-all">{text}</code>
      <CopyText text={text} display="复制" className="shrink-0" />
    </div>
  )
}

function EditNode({ n, onClose }: { n: Node; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [name, setName] = useState(n.name)
  const [limit, setLimit] = useState(n.traffic_limit ? (n.traffic_limit / 1024 ** 3).toString() : '')
  const [day, setDay] = useState(String(n.reset_day || 1))
  const save = useMutation({
    mutationFn: () => {
      const l = limit.trim() ? parseSize(limit) : 0
      if (Number.isNaN(l)) throw new Error('月流量格式不对，例如 500 或 1.5T')
      return api(`/nodes/${n.id}`, { method: 'PATCH', body: { name, traffic_limit: l, reset_day: Math.min(28, Math.max(1, Number(day) || 1)) } })
    },
    onSuccess: () => { toast('good', '已保存'); qc.invalidateQueries({ queryKey: ['nodes'] }); onClose() },
    onError: (e) => toast('bad', (e as Error).message),
  })
  return (
    <ModalDialog isOpen onOpenChange={(v) => !v && onClose()} title={`编辑 ${n.name}`}
      footer={<><Button onPress={onClose}>取消</Button><Button variant="primary" onPress={() => save.mutate()}>保存</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="名称" value={name} onChange={setName} />
        <div className="grid grid-cols-2 gap-4">
          <Field label="月流量上限（GB）" value={limit} onChange={setLimit} placeholder="不限" description={n.traffic_limit ? `当前 ${bytes(n.traffic_limit)}` : 'VPS 套餐流量，用于进度和告警'} />
          <Field label="每月重置日" value={day} onChange={setDay} description="1–28" />
        </div>
      </div>
    </ModalDialog>
  )
}

function SpecView({ n, onClose }: { n: Node; onClose: () => void }) {
  const spec = useQuery({ queryKey: ['spec', n.id], queryFn: () => api<unknown>(`/nodes/${n.id}/spec`) })
  return (
    <ModalDialog wide isOpen onOpenChange={(v) => !v && onClose()} title={`${n.name} · 下发配置 r${n.revision}`}>
      <pre className="max-h-[60vh] overflow-auto rounded-[10px] border bg-base p-3 font-mono text-[12px] leading-5">
        {spec.data ? JSON.stringify(decodeSpec(spec.data), null, 2) : '加载中…'}
      </pre>
    </ModalDialog>
  )
}

// protojson renders bytes as base64; decode the embedded sing-box JSON for display.
function decodeSpec(s: any) {
  const dec = (b?: string) => { try { return b ? JSON.parse(atob(b)) : undefined } catch { return b } }
  return {
    revision: s.revision,
    skeleton: dec(s.skeletonJson),
    inbounds: (s.inbounds ?? []).map((i: any) => ({ ...dec(i.optionsJson), type: i.type, tag: i.tag, users: dec(i.usersJson) })),
  }
}
