import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Node, type Enroll, type Template } from '../lib/api'
import { bytes, parseSize, dateTime } from '../lib/fmt'
import { useRoute, go, replace } from '../lib/router'
import { useAction } from '../lib/actions'
import { ActionMenu, Button, Callout, Card, Confirm, CopyText, Empty, Field, ModalDialog, PageHeader, Presence, Segmented, Select, Skeleton, cx, useSticky } from '../ui/kit'
import { IconCheck, IconPlus } from '../ui/icons'
import { NodeCard } from './Overview'
import { HealthDot, ProbeDrawer, useProbeResults, useRunProbe } from '../ui/probe'

export function NodesPage() {
  const { params } = useRoute()
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<Node[]>('/nodes'), refetchInterval: 5000 })
  const [wizard, setWizard] = useState<{ enroll?: Enroll; name?: string } | null>(() => (params.get('add') === '1' ? {} : null))
  useEffect(() => { if (params.get('add')) replace('nodes') }, [params])
  const [editing, setEditing] = useState<Node | null>(null)
  const [deleting, setDeleting] = useState<Node | null>(null)
  const delSticky = useSticky(deleting)
  const [specOf, setSpecOf] = useState<Node | null>(null)
  const probes = useProbeResults()
  const runProbe = useRunProbe()
  const [probeNode, setProbeNode] = useState<Node | null>(null)
  const probeSticky = useSticky(probeNode)
  const probeOf = (id: string) => (probes.data ?? []).filter((r) => r.node_id === id)
  const testNode = (n: Node) => { runProbe.mutate({ node_id: n.id }); setProbeNode(n) }

  const token = useAction({
    fn: (n: Node) => api<Enroll>(`/nodes/${n.id}/token`, { method: 'POST' }),
    onSuccess: (e, n) => setWizard({ enroll: e, name: n.name }),
  })
  const del = useAction({
    fn: (id: string) => api(`/nodes/${id}`, { method: 'DELETE' }),
    success: '节点已删除', invalidate: [['nodes'], ['inbounds'], ['overview']],
  })

  return (
    <>
      <PageHeader title="节点" subtitle="节点进程主动连接 master（mTLS），离线时按最后一次配置继续服务，流量在本地落盘后补传"
        actions={<Button variant="primary" onPress={() => setWizard({})}><IconPlus size={16} />添加节点</Button>} />
      {nodes.isPending && !nodes.data && <div className="grid gap-4 md:grid-cols-2"><Skeleton className="h-64" /><Skeleton className="h-64" /></div>}
      {nodes.data?.length === 0 && (
        <Card><Empty title="还没有节点" hint="添加节点后会得到一行接入命令，在服务器上执行即可完成 mTLS 证书签发并上线"
          action={<Button variant="primary" onPress={() => setWizard({})}>添加节点</Button>} /></Card>
      )}
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {nodes.data?.map((n) => (
          <NodeCard key={n.id} n={n} actions={<div className="flex shrink-0 items-center gap-0.5">
            {n.inbounds > 0 && <HealthDot results={probeOf(n.id)} running={runProbe.isPending && runProbe.variables?.node_id === n.id}
              onPress={() => probeOf(n.id).length ? setProbeNode(n) : testNode(n)} />}
            <ActionMenu label="节点操作" onAction={(k) => {
              if (k === 'probe') testNode(n)
              if (k === 'edit') setEditing(n)
              if (k === 'token') token.mutate(n)
              if (k === 'spec') setSpecOf(n)
              if (k === 'inbound') go('inbounds', { new: 1, node: n.id })
              if (k === 'delete') setDeleting(n)
            }} items={[
              { id: 'probe', label: '测试连通性', isDisabled: n.inbounds === 0 }, { id: 'edit', label: '编辑' }, { id: 'inbound', label: '为它创建入站' },
              { id: 'token', label: n.enrolled ? '重新接入（换证书）' : '生成接入命令' }, { id: 'spec', label: '查看下发配置' }, 'sep',
              { id: 'delete', label: '删除节点', danger: true },
            ]} />
          </div>} />
        ))}
      </div>

      <ProbeDrawer isOpen={!!probeNode} onClose={() => setProbeNode(null)} title={`${probeSticky?.name ?? ''} · 入站连通性`}
        results={probeSticky ? probeOf(probeSticky.id) : []} running={runProbe.isPending} onRetry={() => probeSticky && runProbe.mutate({ node_id: probeSticky.id })} />
      <Presence value={wizard}>
        {(w, open) => <AddNodeWizard isOpen={open} initial={w} onClose={() => setWizard(null)} />}
      </Presence>
      <Presence value={editing}>{(n, open) => <EditNode isOpen={open} n={n} onClose={() => setEditing(null)} />}</Presence>
      <Presence value={specOf}>{(n, open) => <SpecView isOpen={open} n={n} onClose={() => setSpecOf(null)} />}</Presence>
      <Confirm isOpen={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} danger title="删除节点"
        confirmLabel="删除节点" onConfirm={() => deleting && del.mutate(deleting.id)}
        body={<>删除 <b className="text-text">{delSticky?.name}</b> 会同时删除它的 {delSticky?.inbounds ?? 0} 个入站，并立刻吊销节点证书。历史流量保留。此操作不可撤销。</>} />
    </>
  )
}

const stepNames = ['名称和地址', '接入命令', '检测连接']

/** Add-node wizard: name → commands → live detection, all in one dialog. */
function AddNodeWizard({ isOpen, initial, onClose }: { isOpen: boolean; initial: { enroll?: Enroll; name?: string }; onClose: () => void }) {
  const qc = useQueryClient()
  const [step, setStep] = useState(initial.enroll ? 2 : 1)
  const [name, setName] = useState(initial.name ?? '')
  const [pubAddr, setPubAddr] = useState('')
  const [enroll, setEnroll] = useState<Enroll | null>(initial.enroll ?? null)
  const [how, setHow] = useState<'script' | 'manual'>('script')
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => { const t = setInterval(() => setNow(Date.now() / 1000), 1000); return () => clearInterval(t) }, [])
  const create = useAction({
    fn: () => api<Enroll>('/nodes', { method: 'POST', body: { name, public_address: pubAddr } }),
    invalidate: [['nodes']], onSuccess: (e) => { setEnroll(e); setStep(2) },
  })
  const regen = useAction({ fn: () => api<Enroll>(`/nodes/${enroll!.node_id}/token`, { method: 'POST' }), success: '已生成新的接入令牌', onSuccess: setEnroll })
  // Snapshot of the node before enrolling, so "re-enroll" of an existing node waits for a fresh certificate.
  const [baseline] = useState(() => initial.enroll ? qc.getQueryData<Node[]>(['nodes'])?.find((n) => n.id === initial.enroll!.node_id)?.cert_expire ?? 0 : 0)
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<Node[]>('/nodes'), refetchInterval: step >= 2 && isOpen ? 2000 : 5000 })
  const n = enroll ? nodes.data?.find((x) => x.id === enroll.node_id) : undefined
  const enrolled = !!n?.enrolled && (n.cert_expire !== baseline || !baseline)
  const online = enrolled && !!n?.online
  const applied = online && n!.applied_revision >= n!.revision && !n!.apply_error
  useEffect(() => { if (step === 2 && enrolled) setStep(3) }, [step, enrolled])
  const expired = !!enroll && now > enroll.expires_at && !enrolled
  const dir = '/var/lib/sbnode'
  const scriptCmd = enroll ? `sudo bash deploy/install-node.sh ./sbnode-linux-amd64 "${enroll.command}"` : ''
  const manualCmd = enroll ? `sbnode ${enroll.command.replace(/^sbnode /, '')} --dir ${dir}\nsbnode run --dir ${dir}` : ''

  const footer = step === 1 ? <>
    <Button onPress={onClose}>取消</Button>
    <Button variant="primary" isPending={create.isPending} isDisabled={!name.trim()} onPress={() => create.mutate()}>下一步：生成接入命令</Button>
  </> : step === 2 ? <>
    <Button variant="ghost" className="mr-auto" onPress={onClose}>稍后再接入</Button>
    <Button variant="primary" onPress={() => setStep(3)}>我已执行，开始检测</Button>
  </> : <>
    {!applied && <Button variant="ghost" className="mr-auto" onPress={() => setStep(2)}>查看接入命令</Button>}
    {applied ? <>
      <Button onPress={onClose}>完成</Button>
      <Button variant="primary" onPress={() => { onClose(); go('inbounds', { new: 1, node: enroll!.node_id }) }}>为它创建入站</Button>
    </> : <Button onPress={onClose}>关闭（后台继续）</Button>}
  </>

  return (
    <ModalDialog wide isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={initial.enroll ? `接入 ${initial.name ?? '节点'}` : '添加节点'} footer={footer}>
      <ol className="mb-5 flex items-center gap-2 text-[13px]" aria-label="步骤">
        {stepNames.map((s, i) => {
          const k = i + 1
          const done = k < step || (k === 3 && applied)
          return (
            <li key={s} className="flex min-w-0 items-center gap-2" aria-current={k === step ? 'step' : undefined}>
              {i > 0 && <span className={cx('h-px w-4 shrink-0 transition-colors duration-(--dur-2) sm:w-8', k <= step ? 'bg-accent' : 'bg-hl-med')} />}
              <span className={cx('grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold transition-colors duration-(--dur-2)',
                done ? 'bg-good text-on-accent' : k === step ? 'bg-accent text-on-accent' : 'bg-overlay text-muted')}>
                {done ? <IconCheck size={13} strokeWidth={3} className="animate-check" /> : k}
              </span>
              <span className={cx('truncate', k === step ? 'font-medium text-text' : 'hidden text-muted sm:inline')}>{s}</span>
            </li>
          )
        })}
      </ol>
      <div key={step} className="animate-content-in">
        {step === 1 && (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate() }}>
            <Field label="节点名称" value={name} onChange={setName} placeholder="例如 la-01" autoFocus />
            <Field label="公网地址（可选）" value={pubAddr} onChange={setPubAddr} placeholder="la.example.com 或 IP" description="订阅里客户端连接的地址，之后也可以修改" />
            <button type="submit" hidden />
          </form>
        )}
        {step === 2 && enroll && (
          <div className="flex flex-col gap-4 text-[13px]">
            <Segmented label="接入方式" value={how} onChange={setHow} options={[{ id: 'script', label: '一键安装脚本（推荐）' }, { id: 'manual', label: '手动 enroll + run' }]} />
            {how === 'script' ? (
              <div key="s" className="flex animate-content-in flex-col gap-2">
                <p className="text-subtle">把 <span className="font-mono">sbnode</span> 二进制和仓库里的 <span className="font-mono">deploy/</span> 目录传到服务器，然后执行：</p>
                <Code text={scriptCmd} />
                <p className="text-xs text-muted">脚本会安装到 /usr/local/bin、签发证书并以 systemd 服务 <span className="font-mono">sbnode</span> 启动。</p>
              </div>
            ) : (
              <div key="m" className="flex animate-content-in flex-col gap-2">
                <p className="text-subtle">签发 mTLS 证书，然后前台运行（或自己写 systemd 单元）：</p>
                <Code text={manualCmd} />
              </div>
            )}
            {expired ? (
              <Callout tone="bad"><span className="flex flex-wrap items-center justify-between gap-2">接入令牌已过期，需要重新生成。<Button size="sm" variant="primary" isPending={regen.isPending} onPress={() => regen.mutate()}>重新生成</Button></span></Callout>
            ) : (
              <p className="text-xs text-muted">令牌一次性有效，{dateTime(enroll.expires_at)} 前使用（还剩 {Math.max(0, Math.round((enroll.expires_at - now) / 60))} 分钟）。节点生成自己的私钥，只把证书请求发给 master，并用 CA 指纹校验 master。</p>
            )}
            <div className="rounded-[10px] bg-overlay px-3 py-2 text-xs text-subtle">
              master 地址 <span className="font-mono text-text">{enroll.master}</span>，CA SHA-256 <span className="font-mono break-all text-text">{enroll.ca_sha256}</span>。
              如果节点要通过别的地址访问 master，启动 sbmaster 时加 <span className="font-mono">--public-grpc host:port</span>。
            </div>
            <div className="flex items-center gap-2 text-xs text-muted"><Pulse />正在等待节点接入，检测到后自动进入下一步</div>
          </div>
        )}
        {step === 3 && enroll && (
          <div className="flex flex-col gap-1">
            <Check state={enrolled ? 'done' : expired ? 'fail' : 'wait'} wait="等待节点接入…" done="已签发证书" fail="令牌已过期"
              action={expired ? <Button size="sm" variant="primary" isPending={regen.isPending} onPress={() => { regen.mutate(); setStep(2) }}>重新生成</Button> : undefined} />
            <Check state={online ? 'done' : enrolled ? 'wait' : 'idle'} wait="等待节点连接 master…" done={`已连接 · sing-box ${n?.info?.singbox ?? ''}`} />
            <Check state={applied ? 'done' : n?.apply_error && online ? 'fail' : online ? 'wait' : 'idle'} wait="正在下发配置…" done="完成，节点已就绪" fail={`配置下发失败：${n?.apply_error}`} />
            {applied && <p className="mt-3 animate-content-in text-[13px] text-subtle">节点还没有入站。为它创建一个入站后，分组里的用户就能通过它连接。</p>}
          </div>
        )}
      </div>
    </ModalDialog>
  )
}

function Pulse() {
  return <span className="relative inline-flex h-2.5 w-2.5 shrink-0"><span className="absolute inset-0 animate-pulse-ring rounded-full" /><span className="relative h-2.5 w-2.5 rounded-full bg-accent" /></span>
}

function Check({ state, wait, done, fail, action }: { state: 'idle' | 'wait' | 'done' | 'fail'; wait: string; done: string; fail?: string; action?: React.ReactNode }) {
  return (
    <div className={cx('flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-sm transition-colors duration-(--dur-2)', state === 'wait' && 'bg-accent/6')}>
      <span className="grid h-6 w-6 shrink-0 place-items-center">
        {state === 'done' ? <span key="d" className="grid h-6 w-6 animate-check place-items-center rounded-full bg-good text-on-accent"><IconCheck size={14} strokeWidth={3} /></span>
          : state === 'fail' ? <span key="f" className="grid h-6 w-6 animate-check place-items-center rounded-full bg-bad/15 text-bad">!</span>
            : state === 'wait' ? <Pulse /> : <span className="h-2 w-2 rounded-full bg-hl-high" />}
      </span>
      <span key={state} className={cx('min-w-0 flex-1 animate-content-in break-all', state === 'idle' && 'text-muted', state === 'fail' && 'text-bad', state === 'done' && 'font-medium')}>
        {state === 'done' ? done : state === 'fail' ? fail : wait}
      </span>
      {action}
    </div>
  )
}

function Code({ text }: { text: string }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-[10px] border bg-base px-3 py-2.5">
      <code className="min-w-0 font-mono text-[12.5px] break-all whitespace-pre-wrap">{text}</code>
      <CopyText text={text} display="复制" className="shrink-0" />
    </div>
  )
}

function EditNode({ n, onClose, isOpen }: { n: Node; onClose: () => void; isOpen: boolean }) {
  const [name, setName] = useState(n.name)
  const [pub, setPub] = useState(n.public_address)
  const [tpl, setTpl] = useState(String(n.template_id))
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api<Template[]>('/templates') })
  const [limit, setLimit] = useState(n.traffic_limit ? (n.traffic_limit / 1024 ** 3).toString() : '')
  const [day, setDay] = useState(String(n.reset_day || 1))
  const save = useAction({
    fn: () => {
      const l = limit.trim() ? parseSize(limit) : 0
      if (Number.isNaN(l)) throw new Error('月流量格式不对，例如 500 或 1.5T')
      return api(`/nodes/${n.id}`, { method: 'PATCH', body: { name, public_address: pub, template_id: Number(tpl), traffic_limit: l, reset_day: Math.min(28, Math.max(1, Number(day) || 1)) } })
    },
    apply: Number(tpl) !== n.template_id, success: `已保存 ${name}`, invalidate: [['nodes'], ['templates']], onSuccess: onClose,
  })
  return (
    <ModalDialog isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={`编辑 ${n.name}`}
      footer={<><Button onPress={onClose}>取消</Button><Button variant="primary" isPending={save.isPending} onPress={() => save.mutate()}>保存</Button></>}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="名称" value={name} onChange={setName} />
          <Select label="路由模板" value={tpl} onChange={setTpl} options={(templates.data ?? []).map((t) => ({ id: String(t.id), label: t.name }))} />
        </div>
        <Field label="公网地址" value={pub} onChange={setPub} placeholder={n.address || '例如 la.example.com'} description="订阅里默认使用的地址；留空使用节点连接 master 时的来源 IP" />
        <div className="grid grid-cols-2 gap-4">
          <Field label="月流量上限（GB）" value={limit} onChange={setLimit} placeholder="不限" description={n.traffic_limit ? `当前 ${bytes(n.traffic_limit)}` : 'VPS 套餐流量，用于进度和告警'} />
          <Field label="每月重置日" value={day} onChange={setDay} description="1–28" />
        </div>
      </div>
    </ModalDialog>
  )
}

function SpecView({ n, onClose, isOpen }: { n: Node; onClose: () => void; isOpen: boolean }) {
  const spec = useQuery({ queryKey: ['spec', n.id], queryFn: () => api<unknown>(`/nodes/${n.id}/spec`) })
  return (
    <ModalDialog wide isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={`${n.name} · 下发配置 r${n.revision}`}>
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
