import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type Inbound, type Node } from '../lib/api'
import { ago, date, dateTime } from '../lib/fmt'
import { useAction, useApplyTracker } from '../lib/actions'
import {
  SOURCE_LABEL, certLabel, covers, downloadCert, expiryText, expiryTone, matchCert, useCerts, useDomains, useProviders,
  type Cert, type DNSPlan, type DNSRecord, type Domain, type PemPreview, type Provider,
} from '../lib/certs'
import {
  ActionMenu, Badge, Button, Callout, Card, Checkbox, Confirm, Empty, Field, ModalDialog, PageHeader, Presence, Segmented, Select, Skeleton, Spinner, Switch,
  cx, useSticky, useToast,
} from '../ui/kit'
import { IconCheck, IconKey, IconPlus } from '../ui/icons'
import { useRunProbe, healthOf, type ProbeResult } from '../ui/probe'
import { applyCertChoice } from './Inbounds'

const errText = (e: unknown) => (e as Error)?.message || '操作失败'

/** A host name label from a node name: "香港 HK-1" → "hk-1". */
function slug(s: string, i: number): string {
  const x = s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return x || `node${i + 1}`
}

/** What a DNS record for the node should point to (public address if it's an IP, else the connecting address). */
function nodeIP(n: Node): string {
  const isIP = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(':')
  if (isIP(n.public_address)) return n.public_address
  if (isIP(n.address) && !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address) && n.address !== '::1') return n.address
  return ''
}
const recordType = (ip: string) => (ip.includes(':') ? 'AAAA' : 'A')

const statusBadge: Record<Cert['status'], { tone: 'good' | 'warn' | 'bad' | 'neutral' | 'accent'; text: string }> = {
  ok: { tone: 'good', text: '有效' }, expiring: { tone: 'warn', text: '即将过期' }, expired: { tone: 'bad', text: '已过期' },
  pending: { tone: 'neutral', text: '等待中' }, error: { tone: 'bad', text: '出错' }, renewing: { tone: 'accent', text: '签发中' },
}
const sourceTone: Record<Cert['source'], 'accent' | 'neutral' | 'warn'> = { acme: 'accent', upload: 'neutral', node: 'warn' }

const tlsInbound = (i: Inbound) => {
  const t = (i.options as any).tls
  return !!t?.enabled && !t.reality?.enabled
}

export function CertsPage() {
  const providers = useProviders()
  const domains = useDomains()
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<Node[]>('/nodes') })
  const busy = (cs?: Cert[]) => cs?.some((c) => c.renewing || c.status === 'pending')
  const certs = useCerts(false)
  const poll = useCerts(busy(certs.data) ? 2000 : 30000)
  const list = poll.data ?? certs.data
  const [guide, setGuide] = useState(false)
  const [upload, setUpload] = useState<{ replace?: Cert } | null>(null)
  const [nodeImport, setNodeImport] = useState(false)
  const [issue, setIssue] = useState<{ domains?: string[] } | null>(null)
  const [provider, setProvider] = useState<{ edit?: Provider } | null>(null)
  const prov = providers.data?.[0]
  const fresh = !!list && !!providers.data && list.length === 0 && providers.data.length === 0

  return (
    <>
      <PageHeader title="域名与证书" subtitle="连接 Cloudflare 后可以为节点配置域名、自动签发并续期证书；也可以导入 PEM 或直接用节点上 certbot 的证书。续期只替换证书文件，入站不重建"
        actions={<>
          <Button onPress={() => setGuide(true)}>设置向导</Button>
          <ActionMenu label="导入证书" onAction={(k) => (k === 'pem' ? setUpload({}) : setNodeImport(true))}
            trigger={<Button>导入证书 ▾</Button>}
            items={[{ id: 'pem', label: '上传 PEM 证书和私钥' }, { id: 'node', label: '引用节点上的文件（certbot）' }]} />
          <Button variant="primary" isDisabled={!prov} onPress={() => setIssue({})}><IconPlus size={16} />签发证书</Button>
        </>} />

      {fresh && <Welcome onStart={() => setGuide(true)} onCertbot={() => setNodeImport(true)} onUpload={() => setUpload({})} />}

      <div className="flex flex-col gap-4">
        <CertTable certs={list} loading={certs.isLoading} onReplace={(c) => setUpload({ replace: c })} onIssue={() => (prov ? setIssue({}) : setGuide(true))} />
        <DomainsCard domains={domains.data} provider={prov} nodes={nodes.data ?? []} certs={list ?? []} onIssue={(ds) => setIssue({ domains: ds })} />
        <div className="grid gap-4 lg:grid-cols-2">
          <ProviderCard providers={providers.data} loading={providers.isLoading} onConnect={() => setProvider({})} onEdit={(p) => setProvider({ edit: p })} />
          <ProbeSettingsCard />
        </div>
      </div>

      <Presence value={guide || null}>{(_, open) => <SetupGuide isOpen={open} onClose={() => setGuide(false)} />}</Presence>
      <Presence value={upload}>{(u, open) => <UploadDialog isOpen={open} replace={u.replace} onClose={() => setUpload(null)} />}</Presence>
      <Presence value={nodeImport || null}>{(_, open) => <NodeCertDialog isOpen={open} nodes={nodes.data ?? []} onClose={() => setNodeImport(false)} />}</Presence>
      <Presence value={issue}>{(x, open) => <IssueDialog isOpen={open} provider={prov} domains={x.domains} onClose={() => setIssue(null)} />}</Presence>
      <Presence value={provider}>{(x, open) => <ProviderDialog isOpen={open} edit={x.edit} onClose={() => setProvider(null)} />}</Presence>
    </>
  )
}

function Welcome({ onStart, onCertbot, onUpload }: { onStart: () => void; onCertbot: () => void; onUpload: () => void }) {
  const steps = [
    ['连接 Cloudflare', '粘贴 API 令牌，面板验证后列出你的域名'],
    ['为节点选域名', '例如 hk.example.com → 节点 IP，确认后才写 DNS'],
    ['签发证书', "Let's Encrypt，单域名或通配符，到期前 30 天自动续期"],
    ['分配给入站', 'TLS 入站选中证书即可，之后续期无感'],
  ]
  return (
    <Card className="mb-4" title="开始设置">
      <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map(([t, d], i) => (
          <li key={t} className="flex gap-3 rounded-[12px] bg-overlay/60 p-3">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-on-accent">{i + 1}</span>
            <div><div className="text-sm font-medium">{t}</div><div className="mt-0.5 text-xs text-subtle">{d}</div></div>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="primary" onPress={onStart}>开始设置向导</Button>
        <span className="text-[13px] text-subtle">不用 Cloudflare？</span>
        <Button variant="ghost" onPress={onCertbot}>使用节点上的 certbot 证书</Button>
        <Button variant="ghost" onPress={onUpload}>上传已有证书</Button>
      </div>
    </Card>
  )
}

// ---------- certificate table ----------

function Expiry({ ts }: { ts: number }) {
  if (!ts) return <span className="text-muted">—</span>
  return (
    <span title={date(ts)} className="inline-flex flex-col">
      <Badge tone={expiryTone(ts)}>{expiryText(ts)}</Badge>
      <span className="mt-0.5 text-[11px] text-muted tabular">{date(ts)}</span>
    </span>
  )
}

function CertTable({ certs, loading, onReplace, onIssue }: { certs?: Cert[]; loading: boolean; onReplace: (c: Cert) => void; onIssue: () => void }) {
  const toast = useToast()
  const [deleting, setDeleting] = useState<Cert | null>(null)
  const delSticky = useSticky(deleting)
  const [uses, setUses] = useState<Cert | null>(null)
  const renew = useAction({
    fn: (c: Cert) => api<{ started: boolean; hint?: string }>(`/certs/${c.id}/renew`, { method: 'POST' }),
    success: (r) => r.hint ?? '已开始续期，完成后自动下发到节点', invalidate: [['certs']],
  })
  const auto = useAction({
    fn: (c: Cert) => api(`/certs/${c.id}`, { method: 'PATCH', body: { auto_renew: !c.auto_renew } }),
    success: (_, c) => (c.auto_renew ? '已关闭自动续期' : '已开启自动续期'), invalidate: [['certs']],
  })
  const del = useAction({ fn: (c: Cert) => api(`/certs/${c.id}`, { method: 'DELETE' }), success: '证书已删除', invalidate: [['certs'], ['domains']] })
  const dl = async (c: Cert, part: 'chain' | 'key') => { try { await downloadCert(c, part) } catch (e) { toast('bad', errText(e)) } }

  return (
    <Card title="证书" pad={false}>
      {loading && <div className="p-5"><Skeleton className="h-24" /></div>}
      {certs?.length === 0 && <Empty title="还没有证书" hint="签发（Cloudflare DNS 验证）、上传 PEM，或引用节点上 certbot 的证书" action={<Button variant="primary" onPress={onIssue}>签发证书</Button>} />}
      {!!certs?.length && (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] whitespace-nowrap">
            <thead className="text-left text-xs text-subtle">
              <tr className="border-b">
                <th className="px-5 py-2 font-medium">证书 / 域名</th><th className="px-3 py-2 font-medium">来源</th>
                <th className="hidden px-3 py-2 font-medium lg:table-cell">签发者</th><th className="px-3 py-2 font-medium">到期</th>
                <th className="px-3 py-2 font-medium">自动续期</th><th className="px-3 py-2 font-medium">状态</th><th className="px-5 py-2" />
              </tr>
            </thead>
            <tbody>
              {certs.map((c) => (
                <tr key={c.id} className="border-b align-top last:border-0 hover:bg-hl-low">
                  <td className="max-w-[340px] min-w-[180px] px-5 py-2.5">
                    <div className="font-medium">{c.name}</div>
                    <div className="mt-0.5 font-mono text-xs whitespace-normal text-muted [overflow-wrap:anywhere]">{c.sans.join(', ') || (c.source === 'node' ? c.cert_path : '—')}</div>
                    {c.source === 'node' && <div className="mt-0.5 text-xs text-muted">{c.node} · {c.reported_at ? `节点 ${ago(c.reported_at)}上报` : '等待节点上报…'}</div>}
                  </td>
                  <td className="px-3 py-2.5"><Badge tone={sourceTone[c.source]}>{SOURCE_LABEL[c.source]}</Badge>{c.acme?.staging && <div className="mt-1"><Badge tone="warn">测试环境</Badge></div>}</td>
                  <td className="hidden px-3 py-2.5 text-subtle lg:table-cell">{c.issuer || '—'}</td>
                  <td className="px-3 py-2.5"><Expiry ts={c.not_after} /></td>
                  <td className="px-3 py-2.5">
                    {c.source === 'acme'
                      ? <Switch label={`自动续期 ${c.name}`} isSelected={c.auto_renew} isDisabled={auto.isPending} onChange={() => auto.mutate(c)} />
                      : <span className="text-xs text-muted">{c.source === 'node' ? '由 certbot 续期' : '手动替换'}</span>}
                  </td>
                  <td className="max-w-[280px] px-3 py-2.5">
                    <span className="inline-flex items-center gap-1.5"><Badge tone={statusBadge[c.status].tone} dot>{statusBadge[c.status].text}</Badge>{c.renewing && <Spinner size={12} />}</span>
                    {c.last_error && <div className="mt-1 text-xs whitespace-normal text-bad [overflow-wrap:anywhere]" title={c.last_error}>{c.last_error.length > 140 ? c.last_error.slice(0, 140) + '…' : c.last_error}</div>}
                    {c.next_attempt > 0 && c.last_error && <div className="text-[11px] text-muted">{dateTime(c.next_attempt)} 重试</div>}
                    <button type="button" onClick={() => setUses(c)} className="mt-1 block cursor-pointer text-xs text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent">
                      {c.uses.length ? `${c.uses.length} 个入站在用` : '未被使用'}
                    </button>
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    <span className="inline-flex items-center gap-1">
                      {c.source !== 'upload' && <Button size="sm" variant="ghost" isDisabled={c.renewing} isPending={renew.isPending && renew.variables?.id === c.id} onPress={() => renew.mutate(c)}>{c.source === 'acme' ? '立即续期' : '重新读取'}</Button>}
                      <ActionMenu label={`${c.name} 操作`} onAction={(k) => {
                        if (k === 'chain') dl(c, 'chain')
                        if (k === 'key') dl(c, 'key')
                        if (k === 'replace') onReplace(c)
                        if (k === 'uses') setUses(c)
                        if (k === 'delete') setDeleting(c)
                      }} items={[
                        { id: 'uses', label: '查看使用的入站' },
                        ...(c.source !== 'node' ? [{ id: 'chain', label: '下载证书链（fullchain.pem）', isDisabled: !c.has_material }, { id: 'key', label: '下载私钥', isDisabled: !c.has_material }] : []),
                        ...(c.source === 'upload' ? [{ id: 'replace', label: '替换为新证书' }] : []),
                        'sep', { id: 'delete', label: '删除', danger: true, isDisabled: c.uses.length > 0 },
                      ]} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Confirm isOpen={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} danger title="删除证书" confirmLabel="删除证书"
        onConfirm={() => deleting && del.mutate(deleting)}
        body={<>删除 <b className="text-text">{delSticky?.name}</b>（{delSticky?.sans.join(', ')}）。{delSticky?.source === 'node' ? '节点上的文件不会被删除。' : '面板保存的证书和私钥会被删除，无法恢复。'}</>} />
      <ModalDialog isOpen={!!uses} onOpenChange={(v) => !v && setUses(null)} title={`使用 ${uses?.name ?? ''} 的入站`}>
        {uses && (uses.uses.length === 0 ? <p className="text-sm text-subtle">还没有入站使用这张证书。在「入站」编辑 TLS 入站，把证书来源选成「面板证书」即可。</p> : (
          <ul className="flex flex-col gap-2">
            {uses.uses.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-2 rounded-[10px] bg-overlay/60 px-3 py-2 text-sm">
                <span><b>{u.tag}</b> <span className="text-subtle">· {u.node}</span></span>
                <span className="flex items-center gap-2 font-mono text-xs text-subtle">{u.sni || '（无 SNI）'}{u.sni && !covers(uses.sans, u.sni) && <Badge tone="warn">不匹配</Badge>}</span>
              </li>
            ))}
          </ul>
        ))}
      </ModalDialog>
    </Card>
  )
}

// ---------- domains & DNS ----------

function DomainsCard({ domains, provider, nodes, certs, onIssue }: { domains?: Domain[]; provider?: Provider; nodes: Node[]; certs: Cert[]; onIssue: (ds: string[]) => void }) {
  const [adding, setAdding] = useState(false)
  const [sync, setSync] = useState<Domain | null>(null)
  const [records, setRecords] = useState<Domain | null>(null)
  const [removing, setRemoving] = useState<Domain | null>(null)
  const rmSticky = useSticky(removing)
  const rm = useAction({ fn: (d: Domain) => api(`/domains/${d.id}`, { method: 'DELETE' }), success: '已从面板移除（DNS 记录未改动）', invalidate: [['domains']] })
  const nodeName = (id: string) => nodes.find((n) => n.id === id)?.name ?? ''
  return (
    <Card title="域名与 DNS" pad={false} action={<Button size="sm" onPress={() => setAdding(true)}><IconPlus size={14} />添加域名</Button>}>
      {domains?.length === 0 && <Empty title="还没有域名" hint={provider ? '为节点添加一个域名，例如 hk.example.com' : '先连接 Cloudflare，也可以只记录域名、手动管理 DNS'} />}
      {!!domains?.length && (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] whitespace-nowrap">
            <thead className="text-left text-xs text-subtle">
              <tr className="border-b"><th className="px-5 py-2 font-medium">域名</th><th className="px-3 py-2 font-medium">节点</th>
                <th className="px-3 py-2 font-medium">DNS 记录</th><th className="px-3 py-2 font-medium">证书</th><th className="px-5 py-2" /></tr>
            </thead>
            <tbody>
              {domains.map((d) => {
                const want = d.node_ip
                const drift = d.record_content && want && d.record_content !== want
                const cover = certs.filter((c) => d.certs.includes(c.id))
                return (
                  <tr key={d.id} className="border-b last:border-0 hover:bg-hl-low">
                    <td className="px-5 py-2.5"><div className="font-mono font-medium">{d.fqdn}</div><div className="text-xs text-muted">{d.zone ? `区域 ${d.zone}` : '未关联 DNS 服务商'}</div></td>
                    <td className="px-3 py-2.5">{d.node || nodeName(d.node_id) || <span className="text-muted">—</span>}{want && <div className="font-mono text-xs text-muted">{want}</div>}</td>
                    <td className="px-3 py-2.5">
                      {d.record_content
                        ? <span className="inline-flex items-center gap-1.5 font-mono text-xs">{d.record_type} {d.record_content}{d.proxied && <Badge tone="warn">已代理</Badge>}{drift && <Badge tone="bad">与节点 IP 不一致</Badge>}</span>
                        : <span className="text-xs text-muted">未由面板设置</span>}
                      {d.synced_at > 0 && <div className="text-[11px] text-muted">{ago(d.synced_at)}同步</div>}
                    </td>
                    <td className="px-3 py-2.5">
                      {cover.length ? <Badge tone={expiryTone(Math.max(...cover.map((c) => c.not_after)))}>{cover.length} 张 · {expiryText(Math.max(...cover.map((c) => c.not_after)))}</Badge>
                        : provider && d.zone ? <Button size="sm" variant="ghost" onPress={() => onIssue([d.fqdn])}>签发</Button> : <span className="text-xs text-muted">无</span>}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <span className="inline-flex items-center gap-1">
                        {d.zone && <Button size="sm" variant="ghost" isDisabled={!d.node_id} onPress={() => setSync(d)}>同步 DNS</Button>}
                        <ActionMenu label={`${d.fqdn} 操作`} onAction={(k) => { if (k === 'records') setRecords(d); if (k === 'rm') setRemoving(d) }}
                          items={[{ id: 'records', label: '查看现有记录', isDisabled: !d.zone }, 'sep', { id: 'rm', label: '从面板移除', danger: true }]} />
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <Presence value={adding || null}>{(_, open) => <DomainDialog isOpen={open} provider={provider} nodes={nodes} onClose={() => setAdding(false)} />}</Presence>
      <Presence value={sync}>{(d, open) => <DNSSyncDialog isOpen={open} domain={d} onClose={() => setSync(null)} />}</Presence>
      <Presence value={records}>{(d, open) => <RecordsDialog isOpen={open} domain={d} onClose={() => setRecords(null)} />}</Presence>
      <Confirm isOpen={!!removing} onOpenChange={(v) => !v && setRemoving(null)} title="从面板移除域名" confirmLabel="移除"
        onConfirm={() => removing && rm.mutate(removing)} body={<>只在面板里移除 <b className="text-text">{rmSticky?.fqdn}</b>，Cloudflare 上的 DNS 记录保持不变。</>} />
    </Card>
  )
}

function DomainDialog({ isOpen, onClose, provider, nodes }: { isOpen: boolean; onClose: () => void; provider?: Provider; nodes: Node[] }) {
  const qc = useQueryClient()
  const [fqdn, setFqdn] = useState('')
  const [nodeId, setNodeId] = useState(nodes[0]?.id ?? '')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const inZone = provider?.zones.find((z) => fqdn.toLowerCase() === z.name || fqdn.toLowerCase().endsWith('.' + z.name))
  const save = async () => {
    setBusy(true); setErr('')
    try {
      await api('/domains', { method: 'POST', body: { fqdn: fqdn.trim(), node_id: nodeId, provider_id: inZone ? provider!.id : 0 } })
      qc.invalidateQueries({ queryKey: ['domains'] })
      onClose()
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <ModalDialog isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title="添加域名"
      footer={<>{err && <span className="mr-auto self-center text-[13px] text-bad">{err}</span>}<Button onPress={onClose}>取消</Button><Button variant="primary" isPending={busy} isDisabled={!fqdn} onPress={save}>添加</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label="域名" value={fqdn} onChange={setFqdn} placeholder="hk.example.com" mono autoFocus
          description={inZone ? `在 Cloudflare 区域 ${inZone.name} 中，可以由面板管理 DNS 记录` : provider ? '不在已连接的区域里：只记录域名，DNS 需要你自己设置' : '未连接 DNS 服务商：只记录域名'} />
        <Select label="指向的节点" value={nodeId} onChange={setNodeId} options={nodes.map((n) => ({ id: n.id, label: `${n.name}${nodeIP(n) ? ' · ' + nodeIP(n) : ''}` }))} />
        <p className="text-xs text-muted">添加域名不会修改 DNS。之后点「同步 DNS」预览改动，确认后才会写入。</p>
      </div>
    </ModalDialog>
  )
}

/** Shows exactly what a DNS change will do; nothing is written before the user confirms. */
function PlanView({ plan }: { plan: DNSPlan }) {
  const row = (r: DNSRecord, tone: string) => (
    <div className={cx('flex flex-wrap items-center gap-2 rounded-[8px] px-2.5 py-1.5 font-mono text-xs', tone)}>
      <b>{r.type}</b><span>{r.name}</span><span>→ {r.content}</span>{r.proxied ? <Badge tone="warn">代理</Badge> : <span className="text-muted">仅 DNS</span>}
    </div>
  )
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm">
        <Badge tone={plan.action === 'create' ? 'good' : plan.action === 'update' ? 'warn' : plan.action === 'noop' ? 'neutral' : 'bad'}>
          {{ create: '新建', update: '修改', noop: '无需改动', conflict: '冲突' }[plan.action]}
        </Badge>
        <span className="font-mono">{plan.fqdn}</span>
      </div>
      {plan.action === 'update' && plan.before && <><div className="text-xs text-subtle">修改前</div>{row(plan.before, 'bg-bad/8 line-through decoration-bad/50')}<div className="text-xs text-subtle">修改后</div></>}
      {(plan.action === 'create' || plan.action === 'update') && row(plan.after, 'bg-good/10')}
      {plan.warning && <Callout tone={plan.action === 'conflict' ? 'bad' : 'warn'}>{plan.warning}</Callout>}
      {plan.existing.filter((r) => r.id !== plan.record_id).length > 0 && (
        <details className="text-xs text-subtle">
          <summary className="cursor-pointer outline-none hover:text-text">同名的其它记录（不会改动）</summary>
          <div className="mt-1 flex flex-col gap-1">{plan.existing.filter((r) => r.id !== plan.record_id).map((r) => <div key={r.id}>{row(r, 'bg-overlay')}</div>)}</div>
        </details>
      )}
    </div>
  )
}

function DNSSyncDialog({ isOpen, onClose, domain }: { isOpen: boolean; onClose: () => void; domain: Domain }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [content, setContent] = useState(domain.record_content || domain.node_ip)
  const [proxied, setProxied] = useState(domain.proxied)
  const [plan, setPlan] = useState<DNSPlan | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const body = { domain_id: domain.id, type: recordType(content), content: content.trim(), proxied }
  const preview = async () => {
    setBusy(true); setErr(''); setPlan(null)
    try { setPlan(await api<DNSPlan>('/dns/plan', { method: 'POST', body })) } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  const apply = async () => {
    setBusy(true); setErr('')
    try {
      await api('/dns/apply', { method: 'POST', body: { ...body, record_id: plan!.record_id } })
      toast('good', `${domain.fqdn} 的 DNS 记录已${plan!.action === 'create' ? '创建' : '更新'}`)
      qc.invalidateQueries({ queryKey: ['domains'] })
      onClose()
    } catch (e) { setErr(errText(e)); if (e instanceof ApiError && e.status === 409) setPlan(null) } finally { setBusy(false) }
  }
  useEffect(() => { setPlan(null) }, [content, proxied])
  return (
    <ModalDialog isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={`同步 DNS · ${domain.fqdn}`}
      footer={<>{err && <span className="mr-auto self-center text-[13px] text-bad">{err}</span>}<Button onPress={onClose}>取消</Button>
        {plan && (plan.action === 'create' || plan.action === 'update')
          ? <Button variant="primary" isPending={busy} onPress={apply}>确认{plan.action === 'create' ? '创建' : '修改'}这条记录</Button>
          : <Button variant="primary" isPending={busy} isDisabled={!content} onPress={preview}>预览改动</Button>}</>}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label={`${recordType(content)} 记录值`} value={content} onChange={setContent} mono description={domain.node_ip ? `节点地址：${domain.node_ip}` : '节点没有公网 IP，请手动填写'} />
          <div className="pb-2"><Switch isSelected={proxied} onChange={setProxied}>Cloudflare 代理（橙色云朵）</Switch></div>
        </div>
        {plan ? <PlanView plan={plan} /> : <p className="text-xs text-muted">面板只会改动这一个名称的 {recordType(content)} 记录，其它记录保持原样。</p>}
      </div>
    </ModalDialog>
  )
}

function RecordsDialog({ isOpen, onClose, domain }: { isOpen: boolean; onClose: () => void; domain: Domain }) {
  const q = useQuery({ queryKey: ['dns-records', domain.id], queryFn: () => api<DNSRecord[]>(`/dns/records?domain_id=${domain.id}`), retry: false })
  return (
    <ModalDialog isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={`现有记录 · ${domain.fqdn}`}>
      {q.isLoading && <Skeleton className="h-20" />}
      {q.error && <Callout tone="bad">{errText(q.error)}</Callout>}
      {q.data?.length === 0 && <p className="text-sm text-subtle">这个名称还没有任何记录。</p>}
      <div className="flex flex-col gap-1.5">
        {q.data?.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-[8px] bg-overlay/60 px-3 py-2 font-mono text-xs">
            <b>{r.type}</b><span className="[overflow-wrap:anywhere]">{r.content}</span>{r.proxied && <Badge tone="warn">代理</Badge>}
            {r.id === domain.record_id && <Badge tone="accent">面板管理</Badge>}
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">只读：要修改请用「同步 DNS」，或直接在 Cloudflare 后台操作。</p>
    </ModalDialog>
  )
}

// ---------- provider ----------

function ProviderCard({ providers, loading, onConnect, onEdit }: { providers?: Provider[]; loading: boolean; onConnect: () => void; onEdit: (p: Provider) => void }) {
  const [deleting, setDeleting] = useState<Provider | null>(null)
  const verify = useAction({ fn: (p: Provider) => api(`/dns/providers/${p.id}/verify`, { method: 'POST' }), success: '令牌有效，区域已刷新', invalidate: [['dns-providers']] })
  const del = useAction({ fn: (p: Provider) => api(`/dns/providers/${p.id}`, { method: 'DELETE' }), success: '已删除', invalidate: [['dns-providers'], ['domains']] })
  return (
    <Card title="DNS 服务商" action={!providers?.length && <Button size="sm" onPress={onConnect}>连接 Cloudflare</Button>}>
      {loading && <Skeleton className="h-16" />}
      {providers?.length === 0 && <p className="text-[13px] text-subtle">连接 Cloudflare 后，面板可以帮你创建 A 记录，并用 DNS 验证签发证书（支持通配符，节点不需要开放 80 端口）。</p>}
      <div className="flex flex-col gap-3">
        {providers?.map((p) => (
          <div key={p.id} className="rounded-[12px] border bg-base p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{p.name}</span><Badge tone="accent">Cloudflare</Badge>
              {p.token_set && <span className="inline-flex items-center gap-1 text-xs text-subtle"><IconKey size={12} />令牌已加密保存</span>}
              <span className="flex-1" />
              <ActionMenu label="服务商操作" onAction={(k) => { if (k === 'verify') verify.mutate(p); if (k === 'token') onEdit(p); if (k === 'del') setDeleting(p) }}
                items={[{ id: 'verify', label: '重新验证' }, { id: 'token', label: '更换令牌' }, 'sep', { id: 'del', label: '删除', danger: true }]} />
            </div>
            <div className="mt-1 text-xs text-muted">{p.verified_at ? `${ago(p.verified_at)}验证` : ''}{p.last_error && <span className="text-bad"> · {p.last_error}</span>}</div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {p.zones.slice(0, 24).map((z) => <span key={z.id} className="rounded-full bg-overlay px-2 py-0.5 font-mono text-xs">{z.name}</span>)}
              {p.zones.length > 24 && <span className="text-xs text-muted">等 {p.zones.length} 个区域</span>}
            </div>
          </div>
        ))}
      </div>
      <Confirm isOpen={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} danger title="删除 DNS 服务商" confirmLabel="删除"
        onConfirm={() => deleting && del.mutate(deleting)} body="删除后令牌会从面板清除；依赖它续期的 ACME 证书需要先删除。DNS 记录本身不受影响。" />
    </Card>
  )
}

function TokenHelp() {
  return (
    <details className="rounded-[10px] bg-overlay/60 px-3 py-2 text-xs text-subtle">
      <summary className="cursor-pointer font-medium outline-none hover:text-text">怎么创建令牌？</summary>
      <ol className="mt-2 ml-4 list-decimal space-y-1">
        <li>打开 Cloudflare 控制台 → 我的个人资料 → API 令牌 → 创建令牌</li>
        <li>选择模板「编辑区域 DNS」（权限：区域 · DNS · 编辑；区域 · 区域 · 读取）</li>
        <li>「区域资源」选择要给节点用的域名（或所有区域），创建后复制令牌</li>
      </ol>
      <p className="mt-2">令牌用 AES-GCM 加密保存在 master 上，之后只显示「已保存」，不会再返回明文。</p>
    </details>
  )
}

function ProviderDialog({ isOpen, onClose, edit, onDone }: { isOpen: boolean; onClose: () => void; edit?: Provider; onDone?: () => void }) {
  const qc = useQueryClient()
  const [token, setToken] = useState('')
  const [name, setName] = useState(edit?.name ?? 'Cloudflare')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true); setErr('')
    try {
      if (edit) await api(`/dns/providers/${edit.id}`, { method: 'PATCH', body: { name, token } })
      else await api('/dns/providers', { method: 'POST', body: { kind: 'cloudflare', name, token } })
      qc.invalidateQueries({ queryKey: ['dns-providers'] })
      onDone?.()
      onClose()
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <ModalDialog isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={edit ? '更换 Cloudflare 令牌' : '连接 Cloudflare'}
      footer={<>{err && <span className="mr-auto max-w-full self-center text-[13px] break-all text-bad">{err}</span>}<Button onPress={onClose}>取消</Button>
        <Button variant="primary" isPending={busy} isDisabled={!edit && token.length < 20} onPress={save}>验证并保存</Button></>}>
      <div className="flex flex-col gap-3">
        <TokenForm token={token} setToken={setToken} name={name} setName={setName} />
      </div>
    </ModalDialog>
  )
}

function TokenForm({ token, setToken, name, setName }: { token: string; setToken: (v: string) => void; name: string; setName: (v: string) => void }) {
  return (
    <>
      <TokenHelp />
      <Field label="API 令牌" type="password" autoComplete="off" value={token} onChange={setToken} mono placeholder="粘贴 Cloudflare API 令牌" />
      <Field label="名称" value={name} onChange={setName} />
    </>
  )
}

// ---------- probe settings ----------

function ProbeSettingsCard() {
  const qc = useQueryClient()
  const toast = useToast()
  const s = useQuery({ queryKey: ['probe-settings'], queryFn: () => api<{ url: string; fallback_url: string; interval: number }>('/probe/settings') })
  const [url, setUrl] = useState('')
  const [fb, setFb] = useState('')
  const [iv, setIv] = useState('0')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (s.data) { setUrl(s.data.url); setFb(s.data.fallback_url); setIv(String(s.data.interval)) } }, [s.data])
  const save = async () => {
    setBusy(true)
    try { await api('/probe/settings', { method: 'PUT', body: { url, fallback_url: fb, interval: Number(iv) } }); qc.invalidateQueries({ queryKey: ['probe-settings'] }); toast('good', '已保存') }
    catch (e) { toast('bad', errText(e)) } finally { setBusy(false) }
  }
  return (
    <Card title="连通性测试" action={<Button size="sm" isPending={busy} onPress={save}>保存</Button>}>
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-subtle">在「入站」和「节点」页点「测试连通性」，master 会以隐藏的探测用户经过入站访问下面的地址。</p>
        <Field label="探测地址" value={url} onChange={setUrl} mono />
        <Field label="备用地址" value={fb} onChange={setFb} mono description="主地址失败时再试一次，用来区分「入站故障」和「目标站点故障」" />
        <Select label="定时检查" value={iv} onChange={setIv} description="状态变化时产生「入站不可达 / 恢复」事件，可在设置里开启通知"
          options={[{ id: '0', label: '关闭' }, { id: '5', label: '每 5 分钟' }, { id: '15', label: '每 15 分钟' }, { id: '60', label: '每小时' }]} />
      </div>
    </Card>
  )
}

// ---------- import / issue dialogs ----------

function readFile(f: File): Promise<string> { return f.text() }

function PemFileButton({ label, onText }: { label: string; onText: (s: string) => void }) {
  return (
    <label className="inline-flex h-7 cursor-pointer items-center rounded-full bg-overlay px-3 text-[13px] font-medium text-text transition-colors duration-(--dur-1) hover:bg-hl-med/70 focus-within:ring-2 focus-within:ring-accent">
      {label}
      <input type="file" accept=".pem,.crt,.cer,.key,.txt" className="sr-only" onChange={async (e) => { const f = e.target.files?.[0]; if (f) onText(await readFile(f)); e.target.value = '' }} />
    </label>
  )
}

function UploadDialog({ isOpen, onClose, replace }: { isOpen: boolean; onClose: () => void; replace?: Cert }) {
  const qc = useQueryClient()
  const track = useApplyTracker()
  const [name, setName] = useState(replace?.name ?? '')
  const [cert, setCert] = useState('')
  const [key, setKey] = useState('')
  const [pv, setPv] = useState<PemPreview | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setPv(null); setErr('')
    if (!cert.includes('BEGIN') || !key.includes('BEGIN')) return
    const t = setTimeout(async () => {
      try { setPv(await api<PemPreview>('/certs/upload', { method: 'POST', body: { cert_pem: cert, key_pem: key, dry_run: true } })) } catch (e) { setErr(errText(e)) }
    }, 300)
    return () => clearTimeout(t)
  }, [cert, key])
  const save = async () => {
    setBusy(true); setErr('')
    try {
      if (replace) await api(`/certs/${replace.id}`, { method: 'PATCH', body: { cert_pem: cert, key_pem: key } })
      else await api('/certs/upload', { method: 'POST', body: { name, cert_pem: cert, key_pem: key } })
      qc.invalidateQueries({ queryKey: ['certs'] })
      if (replace?.uses.length) track({ text: `${replace.name} 已替换` })
      onClose()
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  const mismatch = replace && pv && replace.sans.some((s) => !pv.sans.includes(s))
  return (
    <ModalDialog wide isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={replace ? `替换证书 · ${replace.name}` : '上传 PEM 证书'} dirty={!!cert || !!key}
      footer={<>{err && <span className="mr-auto max-w-full self-center text-[13px] break-all text-bad">{err}</span>}<Button onPress={onClose}>取消</Button>
        <Button variant="primary" isPending={busy} isDisabled={!pv} onPress={save}>{replace ? '替换并下发' : '保存'}</Button></>}>
      <div className="flex flex-col gap-3">
        {!replace && <Field label="名称" value={name} onChange={setName} placeholder="默认用第一个域名" />}
        <div className="grid gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Field label="证书（含中间证书，fullchain）" multiline rows={9} mono value={cert} onChange={setCert} placeholder="-----BEGIN CERTIFICATE-----" />
            <div><PemFileButton label="选择证书文件…" onText={setCert} /></div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Field label="私钥" multiline rows={9} mono value={key} onChange={setKey} placeholder="-----BEGIN PRIVATE KEY-----" />
            <div><PemFileButton label="选择私钥文件…" onText={setKey} /></div>
          </div>
        </div>
        {pv && (
          <div className="animate-content-in rounded-[12px] bg-good/8 p-3 text-[13px]">
            <div className="flex items-center gap-2 font-medium text-good"><IconCheck size={14} />私钥与证书匹配</div>
            <div className="mt-2 grid gap-1 text-subtle sm:grid-cols-2">
              <div>域名：<span className="font-mono text-text">{pv.sans.join(', ')}</span></div>
              <div>签发者：<span className="text-text">{pv.issuer}</span>{pv.self_signed && <Badge tone="warn">自签名</Badge>}</div>
              <div>有效期至：<span className="text-text">{date(pv.not_after)}</span> <Badge tone={expiryTone(pv.not_after)}>{expiryText(pv.not_after)}</Badge></div>
              <div className="truncate">指纹：<span className="font-mono text-xs">{pv.fingerprint.slice(0, 32)}…</span></div>
            </div>
            {mismatch && <div className="mt-2 text-warn">新证书不包含原来的所有域名（{replace!.sans.join(', ')}），使用它的入站可能校验失败。</div>}
          </div>
        )}
        {replace && <p className="text-xs text-muted">替换后节点只更新证书文件，sing-box 自动重新加载；入站不会重建，已有连接不会断。</p>}
      </div>
    </ModalDialog>
  )
}

function NodeCertDialog({ isOpen, onClose, nodes, onDone }: { isOpen: boolean; onClose: () => void; nodes: Node[]; onDone?: () => void }) {
  const qc = useQueryClient()
  const [nodeId, setNodeId] = useState(nodes[0]?.id ?? '')
  const [mode, setMode] = useState<'certbot' | 'path'>('certbot')
  const [lineage, setLineage] = useState('')
  const [certPath, setCertPath] = useState('')
  const [keyPath, setKeyPath] = useState('')
  const [name, setName] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const names = useQuery({ queryKey: ['certbot', nodeId], queryFn: () => api<{ names: string[] }>(`/certs/certbot?node=${nodeId}`), enabled: !!nodeId })
  useEffect(() => { if (!lineage && names.data?.names.length) setLineage(names.data.names[0]) }, [names.data, lineage])
  const save = async () => {
    setBusy(true); setErr('')
    try {
      await api('/certs/node', { method: 'POST', body: mode === 'certbot' ? { node_id: nodeId, certbot: lineage, name } : { node_id: nodeId, cert_path: certPath, key_path: keyPath, name } })
      qc.invalidateQueries({ queryKey: ['certs'] })
      onDone?.()
      onClose()
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  const node = nodes.find((n) => n.id === nodeId)
  return (
    <ModalDialog isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title="引用节点上的证书文件"
      footer={<>{err && <span className="mr-auto max-w-full self-center text-[13px] break-all text-bad">{err}</span>}<Button onPress={onClose}>取消</Button>
        <Button variant="primary" isPending={busy} isDisabled={!nodeId || (mode === 'certbot' ? !lineage : !certPath || !keyPath)} onPress={save}>添加</Button></>}>
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-subtle">证书留在节点上，继续由 certbot（或你自己的脚本）续期。面板只引用路径：节点会读取文件并上报域名和到期时间，快到期时提醒你。</p>
        <Select label="节点" value={nodeId} onChange={(v) => { setNodeId(v); setLineage('') }} options={nodes.map((n) => ({ id: n.id, label: n.name }))} />
        <Segmented label="方式" value={mode} onChange={setMode} options={[{ id: 'certbot', label: 'certbot' }, { id: 'path', label: '自定义路径' }]} />
        {mode === 'certbot' ? (
          <>
            <Field label="certbot 证书名" value={lineage} onChange={setLineage} mono placeholder="example.com"
              description={<>使用 <span className="font-mono">/etc/letsencrypt/live/{lineage || '<名称>'}/fullchain.pem</span> 和 privkey.pem</>} />
            {names.data && (names.data.names.length ? (
              <div className="flex flex-wrap gap-1.5">
                <span className="text-xs text-muted">{node?.name} 上找到：</span>
                {names.data.names.map((n) => (
                  <button key={n} type="button" onClick={() => setLineage(n)} aria-pressed={lineage === n}
                    className={cx('cursor-pointer rounded-full px-2 py-0.5 font-mono text-xs outline-none transition-colors duration-(--dur-1) focus-visible:ring-2 focus-visible:ring-accent', lineage === n ? 'bg-accent text-on-accent' : 'bg-overlay hover:bg-hl-med')}>{n}</button>
                ))}
              </div>
            ) : <p className="text-xs text-muted">{node?.online ? `${node.name} 上没有找到 /etc/letsencrypt/live 下的证书，可以手动填写名称或改用自定义路径。` : '节点离线，无法列出 certbot 证书。'}</p>)}
          </>
        ) : (
          <>
            <Field label="证书路径" value={certPath} onChange={setCertPath} mono placeholder="/etc/ssl/example.com/fullchain.pem" />
            <Field label="私钥路径" value={keyPath} onChange={setKeyPath} mono placeholder="/etc/ssl/example.com/privkey.pem" />
          </>
        )}
        <Field label="名称" value={name} onChange={setName} placeholder="可选" />
      </div>
    </ModalDialog>
  )
}

type IssueMode = 'single' | 'wildcard'

/** Domains to issue for: one cert per domain, or one wildcard cert per zone. */
function issuePlan(mode: IssueMode, fqdns: string[], provider?: Provider): string[][] {
  if (mode === 'single') return fqdns.map((d) => [d])
  const zones = new Map<string, string[]>()
  for (const d of fqdns) {
    const z = provider?.zones.filter((x) => d === x.name || d.endsWith('.' + x.name)).sort((a, b) => b.name.length - a.name.length)[0]
    const zn = z?.name ?? d.split('.').slice(-2).join('.')
    if (!zones.has(zn)) zones.set(zn, [`*.${zn}`, zn])
  }
  return [...zones.values()]
}

function IssueForm({ provider, domains, onIssued }: { provider?: Provider; domains?: string[]; onIssued: (ids: string[]) => void }) {
  const known = useDomains()
  const [mode, setMode] = useState<IssueMode>('single')
  const [text, setText] = useState((domains ?? []).join('\n'))
  const [ca, setCa] = useState<'letsencrypt' | 'zerossl'>('letsencrypt')
  const [staging, setStaging] = useState(false)
  const [email, setEmail] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!domains && !text && known.data?.length) setText(known.data.filter((d) => d.zone).map((d) => d.fqdn).join('\n'))
  }, [known.data, domains, text])
  const fqdns = text.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
  const plan = issuePlan(mode, fqdns, provider)
  const go = async () => {
    setBusy(true); setErr('')
    try {
      const ids: string[] = []
      for (const ds of plan) ids.push((await api<{ id: string }>('/certs/acme', { method: 'POST', body: { provider_id: provider!.id, domains: ds, ca, staging, email } })).id)
      onIssued(ids)
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <div className="flex flex-col gap-3">
      <Segmented label="证书类型" value={mode} onChange={setMode} options={[{ id: 'single', label: '每个域名一张' }, { id: 'wildcard', label: '通配符（*.域名）' }]} />
      <Field label="域名（每行一个）" multiline rows={3} mono value={text} onChange={setText} placeholder="hk.example.com" />
      {plan.length > 0 && (
        <div className="flex flex-col gap-1 text-xs text-subtle">
          将签发 {plan.length} 张证书：
          {plan.map((ds) => <span key={ds.join()} className="font-mono text-text">{ds.join(' + ')}</span>)}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="证书颁发机构" value={ca} onChange={setCa} options={[{ id: 'letsencrypt', label: "Let's Encrypt" }, { id: 'zerossl', label: 'ZeroSSL' }]} />
        <Field label="邮箱" value={email} onChange={setEmail} placeholder={ca === 'zerossl' ? 'ZeroSSL 必填' : '可选，用于到期提醒'} />
      </div>
      <Switch isSelected={staging} onChange={setStaging}>测试环境（Let's Encrypt staging，证书不受信任，用来验证流程）</Switch>
      <p className="text-xs text-muted">通过 Cloudflare 添加临时 TXT 记录完成 DNS 验证，节点不需要开放 80 端口，通常 1–2 分钟。到期前 30 天自动续期，失败会退避重试并通知。</p>
      {err && <Callout tone="bad">{err}</Callout>}
      <div><Button variant="primary" isPending={busy} isDisabled={!provider || plan.length === 0 || (ca === 'zerossl' && !email)} onPress={go}>签发 {plan.length || ''} 张证书</Button></div>
    </div>
  )
}

function IssueProgress({ ids }: { ids: string[] }) {
  const certs = useCerts(2000)
  const mine = (certs.data ?? []).filter((c) => ids.includes(c.id))
  return (
    <div className="flex flex-col gap-2">
      {mine.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-[10px] bg-overlay/60 px-3 py-2 text-[13px]">
          {c.status === 'ok' || c.status === 'expiring' ? <IconCheck size={14} className="text-good" /> : c.status === 'error' ? <span className="text-bad">✕</span> : <Spinner size={13} />}
          <span className="font-mono">{c.sans.join(', ')}</span>
          <span className="flex-1" />
          <Badge tone={statusBadge[c.status].tone}>{c.status === 'pending' || c.renewing ? '验证 DNS 中…' : statusBadge[c.status].text}</Badge>
          {c.last_error && <div className="w-full text-xs text-bad [overflow-wrap:anywhere]">{c.last_error}</div>}
        </div>
      ))}
    </div>
  )
}

function IssueDialog({ isOpen, onClose, provider, domains }: { isOpen: boolean; onClose: () => void; provider?: Provider; domains?: string[] }) {
  const [ids, setIds] = useState<string[] | null>(null)
  return (
    <ModalDialog isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title="签发证书（ACME · DNS 验证）" footer={ids ? <Button onPress={onClose}>完成</Button> : undefined}>
      {ids ? <IssueProgress ids={ids} /> : <IssueForm provider={provider} domains={domains} onIssued={setIds} />}
    </ModalDialog>
  )
}

// ---------- guided setup ----------

const guideSteps = ['连接 Cloudflare', '为节点选域名', '签发证书', '分配给入站']

function Stepper({ step, done }: { step: number; done: boolean[] }) {
  return (
    <ol className="no-scrollbar mb-5 flex gap-2 overflow-x-auto" aria-label="设置步骤">
      {guideSteps.map((s, i) => (
        <li key={s} aria-current={i === step ? 'step' : undefined}
          className={cx('flex shrink-0 items-center gap-2 rounded-full px-3 py-1 text-[13px] transition-colors duration-(--dur-2)',
            i === step ? 'bg-accent text-on-accent' : done[i] ? 'bg-good/12 text-good' : 'bg-overlay text-subtle')}>
          <span className="grid h-5 w-5 place-items-center rounded-full bg-black/10 text-[11px] font-semibold">{done[i] && i !== step ? <IconCheck size={11} /> : i + 1}</span>{s}
        </li>
      ))}
    </ol>
  )
}

function SetupGuide({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const providers = useProviders()
  const prov = providers.data?.[0]
  const [step, setStep] = useState(0)
  const [done, setDone] = useState([false, false, false, false])
  const mark = (i: number) => setDone((d) => d.map((x, j) => (j === i ? true : x)))
  useEffect(() => { if (prov) mark(0) }, [prov])
  const next = () => setStep((s) => Math.min(3, s + 1))
  const footer = (
    <>
      {step > 0 && <Button variant="ghost" onPress={() => setStep(step - 1)}>上一步</Button>}
      <span className="flex-1" />
      {step < 3 ? <Button onPress={next}>{done[step] ? '下一步' : '跳过这一步'}</Button> : <Button variant="primary" onPress={onClose}>完成</Button>}
    </>
  )
  return (
    <ModalDialog wide isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title="域名与证书 · 设置向导" footer={footer}>
      <Stepper step={step} done={done} />
      <div key={step} className="animate-content-in">
        {step === 0 && <GuideProvider provider={prov} onDone={() => { mark(0); next() }} />}
        {step === 1 && <GuideDomains provider={prov} onDone={() => { mark(1); next() }} />}
        {step === 2 && <GuideIssue provider={prov} onDone={() => mark(2)} />}
        {step === 3 && <GuideAssign onDone={() => mark(3)} />}
      </div>
    </ModalDialog>
  )
}

function GuideProvider({ provider, onDone }: { provider?: Provider; onDone: () => void }) {
  const qc = useQueryClient()
  const [token, setToken] = useState('')
  const [name, setName] = useState('Cloudflare')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  if (provider) {
    return (
      <div className="flex flex-col gap-3">
        <Callout tone="good">已连接 {provider.name}，令牌可以访问 {provider.zones.length} 个区域。</Callout>
        <div className="flex flex-wrap gap-1.5">{provider.zones.map((z) => <span key={z.id} className="rounded-full bg-overlay px-2 py-0.5 font-mono text-xs">{z.name}</span>)}</div>
        <div><Button variant="primary" onPress={onDone}>下一步：为节点选域名</Button></div>
      </div>
    )
  }
  const save = async () => {
    setBusy(true); setErr('')
    try { await api('/dns/providers', { method: 'POST', body: { kind: 'cloudflare', name, token } }); await qc.invalidateQueries({ queryKey: ['dns-providers'] }) }
    catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-subtle">用 Cloudflare 管理域名时，面板可以帮你创建 A 记录、通过 DNS 验证签发证书（含通配符），节点不需要开放 80 端口。用 certbot 或已有证书的话可以跳过，直接在「导入证书」里添加。</p>
      <TokenForm token={token} setToken={setToken} name={name} setName={setName} />
      {err && <Callout tone="bad">{err}</Callout>}
      <div><Button variant="primary" isPending={busy} isDisabled={token.length < 20} onPress={save}>验证令牌</Button></div>
    </div>
  )
}

type DomainRow = { node: Node; on: boolean; sub: string; zone: string; ip: string; dns: boolean; proxied: boolean }

function GuideDomains({ provider, onDone }: { provider?: Provider; onDone: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<Node[]>('/nodes') })
  const existing = useDomains()
  const zones = provider?.zones ?? []
  const [rows, setRows] = useState<DomainRow[] | null>(null)
  const [plans, setPlans] = useState<{ domain: Domain; plan: DNSPlan; body: Record<string, unknown> }[] | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (rows || !nodes.data || !existing.data) return
    setRows(nodes.data.map((n, i) => {
      const have = existing.data.find((d) => d.node_id === n.id)
      const ip = nodeIP(n)
      const zone = have?.zone || zones[0]?.name || ''
      return { node: n, on: !have, sub: have ? have.fqdn.slice(0, -(have.zone.length + 1)) : slug(n.name, i), zone, ip, dns: !!ip && !have?.record_content, proxied: false }
    }))
  }, [nodes.data, existing.data, rows, zones])
  if (!provider) return <Callout>还没有连接 Cloudflare：可以在「域名与 DNS」里手动添加域名（不管理 DNS），或者回到上一步连接。</Callout>
  if (!rows) return <Skeleton className="h-32" />
  const set = (i: number, p: Partial<DomainRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)))
  const chosen = rows.filter((r) => r.on && r.sub && r.zone)
  const prepare = async () => {
    setBusy(true); setErr('')
    try {
      const out: { domain: Domain; plan: DNSPlan; body: Record<string, unknown> }[] = []
      for (const r of chosen) {
        const fqdn = `${r.sub}.${r.zone}`
        let d = (await api<Domain[]>('/domains')).find((x) => x.fqdn === fqdn)
        if (!d) {
          await api('/domains', { method: 'POST', body: { fqdn, provider_id: provider.id, node_id: r.node.id, proxied: r.proxied } })
          d = (await api<Domain[]>('/domains')).find((x) => x.fqdn === fqdn)!
        }
        if (r.dns && r.ip) {
          const body = { domain_id: d.id, type: recordType(r.ip), content: r.ip, proxied: r.proxied }
          out.push({ domain: d, plan: await api<DNSPlan>('/dns/plan', { method: 'POST', body }), body })
        }
      }
      qc.invalidateQueries({ queryKey: ['domains'] })
      if (out.some((p) => p.plan.action === 'create' || p.plan.action === 'update')) { setPlans(out); setConfirm(true) }
      else { toast('good', `已添加 ${chosen.length} 个域名`); onDone() }
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  const apply = async () => {
    setBusy(true); setErr('')
    try {
      for (const p of plans ?? []) {
        if (p.plan.action !== 'create' && p.plan.action !== 'update') continue
        await api('/dns/apply', { method: 'POST', body: { ...p.body, record_id: p.plan.record_id } })
      }
      qc.invalidateQueries({ queryKey: ['domains'] })
      toast('good', 'DNS 记录已写入')
      setConfirm(false)
      onDone()
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  const changes = (plans ?? []).filter((p) => p.plan.action === 'create' || p.plan.action === 'update').length
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-subtle">为每个节点选一个子域名。勾选「写 DNS」的会先预览改动，确认后才写入 Cloudflare；没勾选的只记录在面板里。</p>
      <div className="flex flex-col gap-2">
        {rows.map((r, i) => (
          <div key={r.node.id} className={cx('grid items-center gap-2 rounded-[12px] border p-3 transition-opacity duration-(--dur-1) md:grid-cols-[auto_minmax(0,1fr)_auto]', !r.on && 'opacity-60')}>
            <Checkbox isSelected={r.on} onChange={(on) => set(i, { on })} label={`为 ${r.node.name} 配置域名`}>
              <span className="min-w-[96px] text-sm font-medium">{r.node.name}</span>
            </Checkbox>
            <div className="flex min-w-0 items-center gap-1">
              <Field label="子域名" hideLabel value={r.sub} onChange={(sub) => set(i, { sub: sub.toLowerCase() })} mono className="w-32 shrink-0" />
              <span className="text-muted">.</span>
              <Select label="区域" hideLabel value={r.zone} onChange={(zone) => set(i, { zone })} options={zones.map((z) => ({ id: z.name, label: z.name }))} className="min-w-0 flex-1" />
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[13px]">
              <span className="font-mono text-xs text-subtle" title="节点的公网地址">{r.ip || '无公网 IP'}</span>
              <Checkbox isSelected={r.dns} isDisabled={!r.ip} onChange={(dns) => set(i, { dns })}>写 DNS</Checkbox>
              <Switch isSelected={r.proxied} isDisabled={!r.dns} onChange={(proxied) => set(i, { proxied })} label="Cloudflare 代理">代理</Switch>
            </div>
          </div>
        ))}
      </div>
      {rows.some((r) => r.proxied) && <Callout tone="warn">开启代理（橙色云朵）后，只有 WS / gRPC / HTTPUpgrade + TLS 入站能通过 Cloudflare；REALITY、Hysteria2、TUIC 等请保持「仅 DNS」。</Callout>}
      {err && <Callout tone="bad">{err}</Callout>}
      <div><Button variant="primary" isPending={busy && !confirm} isDisabled={chosen.length === 0} onPress={prepare}>添加 {chosen.length} 个域名{chosen.some((r) => r.dns) ? '并预览 DNS 改动' : ''}</Button></div>
      <ModalDialog isOpen={confirm} onOpenChange={setConfirm} title={`确认修改 ${changes} 条 DNS 记录`}
        footer={<>{err && <span className="mr-auto self-center text-[13px] text-bad">{err}</span>}<Button onPress={() => setConfirm(false)}>取消</Button><Button variant="primary" isPending={busy} onPress={apply}>确认写入</Button></>}>
        <div className="flex flex-col gap-4">
          <p className="text-[13px] text-subtle">只会改动下面列出的记录，其它记录保持不变。</p>
          {(plans ?? []).map((p) => <PlanView key={p.domain.id} plan={p.plan} />)}
        </div>
      </ModalDialog>
    </div>
  )
}

function GuideIssue({ provider, onDone }: { provider?: Provider; onDone: () => void }) {
  const [ids, setIds] = useState<string[] | null>(null)
  if (!provider) return <Callout>没有连接 Cloudflare，无法自动签发。可以关闭向导，用「导入证书」上传 PEM 或引用节点上 certbot 的证书，再回到第 4 步分配。</Callout>
  return ids ? (
    <div className="flex flex-col gap-3">
      <IssueProgress ids={ids} />
      <p className="text-xs text-muted">签发在后台进行，可以先继续下一步；证书就绪后会自动下发到使用它的节点。</p>
    </div>
  ) : <IssueForm provider={provider} onIssued={(x) => { setIds(x); onDone() }} />
}

function GuideAssign({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient()
  const track = useApplyTracker()
  const certs = useCerts(3000)
  const domains = useDomains()
  const inbounds = useQuery({ queryKey: ['inbounds'], queryFn: () => api<Inbound[]>('/inbounds') })
  const probe = useRunProbe()
  const [pick, setPick] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [applied, setApplied] = useState<number[] | null>(null)
  const [probeRes, setProbeRes] = useState<ProbeResult[] | null>(null)
  const tls = useMemo(() => (inbounds.data ?? []).filter(tlsInbound), [inbounds.data])
  const sniOf = (i: Inbound) => ((i.options as any).tls?.server_name as string) || domains.data?.find((d) => d.node_id === i.node_id)?.fqdn || ''
  useEffect(() => {
    if (!certs.data) return
    setPick((p) => {
      const n = { ...p }
      for (const i of tls) if (n[i.id] === undefined) n[i.id] = (i.options as any)._cert ?? matchCert(certs.data!, sniOf(i), i.node_id)?.id ?? ''
      return n
    })
  }, [certs.data, tls, domains.data]) // eslint-disable-line react-hooks/exhaustive-deps
  const changed = tls.filter((i) => pick[i.id] && pick[i.id] !== (i.options as any)._cert)
  const apply = async () => {
    setBusy(true); setErr('')
    try {
      for (const i of changed) {
        const c = certs.data!.find((x) => x.id === pick[i.id])!
        let opts = applyCertChoice(i.options as Record<string, any>, { src: 'panel', certId: c.id, certPath: '', keyPath: '', email: '' })
        const sni = opts.tls.server_name as string | undefined
        if (!sni || !covers(c.sans, sni)) {
          const d = domains.data?.find((x) => x.node_id === i.node_id && covers(c.sans, x.fqdn))?.fqdn ?? c.sans.find((s) => !s.startsWith('*.'))
          if (d) opts = { ...opts, tls: { ...opts.tls, server_name: d } }
        }
        await api(`/inbounds/${i.id}`, { method: 'PATCH', body: { options: opts } })
      }
      qc.invalidateQueries({ queryKey: ['inbounds'] }); qc.invalidateQueries({ queryKey: ['certs'] })
      track({ text: `${changed.length} 个入站已改用面板证书` })
      setApplied(changed.map((i) => i.id))
      onDone()
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  const test = async () => {
    const out: ProbeResult[] = []
    for (const id of applied ?? []) out.push(...await probe.mutateAsync({ inbound_id: id }))
    setProbeRes(out)
  }
  if (inbounds.isLoading) return <Skeleton className="h-32" />
  if (!tls.length) return <Callout>还没有需要证书的 TLS 入站（REALITY 不需要证书）。新建 Trojan / WS+TLS / Hysteria2 等入站时，「证书来源」默认选中覆盖该域名的面板证书。</Callout>
  const usable = (certs.data ?? []).filter((c) => c.has_material)
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-subtle">为 TLS 入站选择面板证书。之后证书续期时节点只替换文件，入站不重建、连接不断。</p>
      <div className="flex flex-col gap-2">
        {tls.map((i) => {
          const c = usable.find((x) => x.id === pick[i.id])
          const sni = sniOf(i)
          return (
            <div key={i.id} className="grid items-center gap-2 rounded-[12px] border p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <div className="min-w-0"><div className="text-sm font-medium">{i.tag} <span className="font-normal text-subtle">· {i.node}</span></div><div className="truncate font-mono text-xs text-muted">{i.type} · SNI {sni || '—'}</div></div>
              <div className="flex min-w-0 flex-col gap-1">
                <Select label={`${i.tag} 的证书`} hideLabel value={pick[i.id] ?? ''} onChange={(v) => setPick({ ...pick, [i.id]: v })} placeholder="保持不变"
                  options={[{ id: '', label: '保持不变' }, ...usable.map((x) => ({ id: x.id, label: certLabel(x) }))]} />
                {c && sni && !covers(c.sans, sni) && <span className="text-xs text-warn">证书不含 {sni}，保存时 SNI 会改成证书里的域名</span>}
              </div>
            </div>
          )
        })}
      </div>
      {err && <Callout tone="bad">{err}</Callout>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" isPending={busy} isDisabled={!changed.length} onPress={apply}>{changed.length ? `应用到 ${changed.length} 个入站` : '没有需要修改的入站'}</Button>
        {applied && <Button isPending={probe.isPending} onPress={test}>测试连通性</Button>}
      </div>
      {probeRes && <ProbeSummary results={probeRes} />}
    </div>
  )
}

function ProbeSummary({ results }: { results: ProbeResult[] }): ReactNode {
  const h = healthOf(results)
  return (
    <div className="flex flex-col gap-1.5">
      <Callout tone={h === 'ok' ? 'good' : h === 'bad' ? 'bad' : 'warn'}>{results.filter((r) => r.ok).length} / {results.length} 个地址可用</Callout>
      {results.filter((r) => !r.ok).map((r) => <div key={r.inbound_id + r.endpoint} className="text-xs text-bad">{r.tag} · {r.endpoint}：{r.error}</div>)}
    </div>
  )
}
