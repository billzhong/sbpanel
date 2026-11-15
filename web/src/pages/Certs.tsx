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
import { tr } from '../i18n'
import { C } from '../i18n/common'
import { CT } from '../i18n/certs'

const T = () => tr(CT)
const errText = (e: unknown) => (e as Error)?.message || tr(C).actionFailed

/** A host name label from a node name: "Hong Kong HK-1" → "hong-kong-hk-1". */
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
  ok: { tone: 'good', get text() { return T().stOk } }, expiring: { tone: 'warn', get text() { return T().stExpiring } }, expired: { tone: 'bad', get text() { return T().stExpired } },
  pending: { tone: 'neutral', get text() { return T().stPending } }, error: { tone: 'bad', get text() { return T().stError } }, renewing: { tone: 'accent', get text() { return T().stRenewing } },
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
      <PageHeader title={T().title} subtitle={T().subtitle}
        actions={<>
          <Button onPress={() => setGuide(true)}>{T().guide}</Button>
          <ActionMenu label={T().importCert} onAction={(k) => (k === 'pem' ? setUpload({}) : setNodeImport(true))}
            trigger={<Button>{T().importCertMenu}</Button>}
            items={[{ id: 'pem', label: T().importPem }, { id: 'node', label: T().importNode }]} />
          <Button variant="primary" isDisabled={!prov} onPress={() => setIssue({})}><IconPlus size={16} />{T().issue}</Button>
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
    [T().w1t, T().w1d], [T().w2t, T().w2d], [T().w3t, T().w3d], [T().w4t, T().w4d],
  ]
  return (
    <Card className="mb-4" title={T().getStarted}>
      <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map(([t, d], i) => (
          <li key={t} className="flex gap-3 rounded-[12px] bg-overlay/60 p-3">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-on-accent">{i + 1}</span>
            <div><div className="text-sm font-medium">{t}</div><div className="mt-0.5 text-xs text-subtle">{d}</div></div>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="primary" onPress={onStart}>{T().startGuide}</Button>
        <span className="text-[13px] text-subtle">{T().noCloudflare}</span>
        <Button variant="ghost" onPress={onCertbot}>{T().useCertbot}</Button>
        <Button variant="ghost" onPress={onUpload}>{T().uploadExisting}</Button>
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
    success: (r) => r.hint ?? T().renewStarted, invalidate: [['certs']],
  })
  const auto = useAction({
    fn: (c: Cert) => api(`/certs/${c.id}`, { method: 'PATCH', body: { auto_renew: !c.auto_renew } }),
    success: (_, c) => (c.auto_renew ? T().autoOff : T().autoOn), invalidate: [['certs']],
  })
  const del = useAction({ fn: (c: Cert) => api(`/certs/${c.id}`, { method: 'DELETE' }), success: T().certDeleted, invalidate: [['certs'], ['domains']] })
  const dl = async (c: Cert, part: 'chain' | 'key') => { try { await downloadCert(c, part) } catch (e) { toast('bad', errText(e)) } }

  return (
    <Card title={T().certs} pad={false}>
      {loading && <div className="p-5"><Skeleton className="h-24" /></div>}
      {certs?.length === 0 && <Empty title={T().noCerts} hint={T().noCertsHint} action={<Button variant="primary" onPress={onIssue}>{T().issue}</Button>} />}
      {!!certs?.length && (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] whitespace-nowrap">
            <thead className="text-left text-xs text-subtle">
              <tr className="border-b">
                <th className="px-5 py-2 font-medium">{T().colCert}</th><th className="px-3 py-2 font-medium">{T().colSource}</th>
                <th className="hidden px-3 py-2 font-medium lg:table-cell">{T().colIssuer}</th><th className="px-3 py-2 font-medium">{T().colExpiry}</th>
                <th className="px-3 py-2 font-medium">{T().colAuto}</th><th className="px-3 py-2 font-medium">{T().colStatus}</th><th className="px-5 py-2" />
              </tr>
            </thead>
            <tbody>
              {certs.map((c) => (
                <tr key={c.id} className="border-b align-top last:border-0 hover:bg-hl-low">
                  <td className="max-w-[340px] min-w-[180px] px-5 py-2.5">
                    <div className="font-medium">{c.name}</div>
                    <div className="mt-0.5 font-mono text-xs whitespace-normal text-muted [overflow-wrap:anywhere]">{c.sans.join(', ') || (c.source === 'node' ? c.cert_path : '—')}</div>
                    {c.source === 'node' && <div className="mt-0.5 text-xs text-muted">{c.node} · {c.reported_at ? T().reported(ago(c.reported_at)) : T().waitingReport}</div>}
                  </td>
                  <td className="px-3 py-2.5"><Badge tone={sourceTone[c.source]}>{SOURCE_LABEL[c.source]}</Badge>{c.acme?.staging && <div className="mt-1"><Badge tone="warn">{T().staging}</Badge></div>}</td>
                  <td className="hidden px-3 py-2.5 text-subtle lg:table-cell">{c.issuer || '—'}</td>
                  <td className="px-3 py-2.5"><Expiry ts={c.not_after} /></td>
                  <td className="px-3 py-2.5">
                    {c.source === 'acme'
                      ? <Switch label={T().autoRenewX(c.name)} isSelected={c.auto_renew} isDisabled={auto.isPending} onChange={() => auto.mutate(c)} />
                      : <span className="text-xs text-muted">{c.source === 'node' ? T().byCertbot : T().manual}</span>}
                  </td>
                  <td className="max-w-[280px] px-3 py-2.5">
                    <span className="inline-flex items-center gap-1.5"><Badge tone={statusBadge[c.status].tone} dot>{statusBadge[c.status].text}</Badge>{c.renewing && <Spinner size={12} />}</span>
                    {c.last_error && <div className="mt-1 text-xs whitespace-normal text-bad [overflow-wrap:anywhere]" title={c.last_error}>{c.last_error.length > 140 ? c.last_error.slice(0, 140) + '…' : c.last_error}</div>}
                    {c.next_attempt > 0 && c.last_error && <div className="text-[11px] text-muted">{T().retryAt(dateTime(c.next_attempt))}</div>}
                    <button type="button" onClick={() => setUses(c)} className="mt-1 block cursor-pointer text-xs text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent">
                      {c.uses.length ? T().usedBy(c.uses.length) : T().unused}
                    </button>
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    <span className="inline-flex items-center gap-1">
                      {c.source !== 'upload' && <Button size="sm" variant="ghost" isDisabled={c.renewing} isPending={renew.isPending && renew.variables?.id === c.id} onPress={() => renew.mutate(c)}>{c.source === 'acme' ? T().renewNow : T().reread}</Button>}
                      <ActionMenu label={T().actionsFor(c.name)} onAction={(k) => {
                        if (k === 'chain') dl(c, 'chain')
                        if (k === 'key') dl(c, 'key')
                        if (k === 'replace') onReplace(c)
                        if (k === 'uses') setUses(c)
                        if (k === 'delete') setDeleting(c)
                      }} items={[
                        { id: 'uses', label: T().viewUses },
                        ...(c.source !== 'node' ? [{ id: 'chain', label: T().dlChain, isDisabled: !c.has_material }, { id: 'key', label: T().dlKey, isDisabled: !c.has_material }] : []),
                        ...(c.source === 'upload' ? [{ id: 'replace', label: T().replace }] : []),
                        'sep', { id: 'delete', label: tr(C).delete, danger: true, isDisabled: c.uses.length > 0 },
                      ]} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Confirm isOpen={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} danger title={T().delTitle} confirmLabel={T().delTitle}
        onConfirm={() => deleting && del.mutate(deleting)}
        body={T().delBody(<b className="text-text">{delSticky?.name}</b>, delSticky?.sans.join(', ') ?? '', delSticky?.source === 'node')} />
      <ModalDialog isOpen={!!uses} onOpenChange={(v) => !v && setUses(null)} title={T().usesTitle(uses?.name ?? '')}>
        {uses && (uses.uses.length === 0 ? <p className="text-sm text-subtle">{T().noUses}</p> : (
          <ul className="flex flex-col gap-2">
            {uses.uses.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-2 rounded-[10px] bg-overlay/60 px-3 py-2 text-sm">
                <span><b>{u.tag}</b> <span className="text-subtle">· {u.node}</span></span>
                <span className="flex items-center gap-2 font-mono text-xs text-subtle">{u.sni || T().noSni}{u.sni && !covers(uses.sans, u.sni) && <Badge tone="warn">{T().mismatch}</Badge>}</span>
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
  const rm = useAction({ fn: (d: Domain) => api(`/domains/${d.id}`, { method: 'DELETE' }), success: T().domainRemoved, invalidate: [['domains']] })
  const nodeName = (id: string) => nodes.find((n) => n.id === id)?.name ?? ''
  return (
    <Card title={T().domainsDns} pad={false} action={<Button size="sm" onPress={() => setAdding(true)}><IconPlus size={14} />{T().addDomain}</Button>}>
      {domains?.length === 0 && <Empty title={T().noDomains} hint={provider ? T().noDomainsHint : T().noDomainsHintNoProv} />}
      {!!domains?.length && (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] whitespace-nowrap">
            <thead className="text-left text-xs text-subtle">
              <tr className="border-b"><th className="px-5 py-2 font-medium">{T().colDomain}</th><th className="px-3 py-2 font-medium">{T().colNode}</th>
                <th className="px-3 py-2 font-medium">{T().colDns}</th><th className="px-3 py-2 font-medium">{T().colCertShort}</th><th className="px-5 py-2" /></tr>
            </thead>
            <tbody>
              {domains.map((d) => {
                const want = d.node_ip
                const drift = d.record_content && want && d.record_content !== want
                const cover = certs.filter((c) => d.certs.includes(c.id))
                return (
                  <tr key={d.id} className="border-b last:border-0 hover:bg-hl-low">
                    <td className="px-5 py-2.5"><div className="font-mono font-medium">{d.fqdn}</div><div className="text-xs text-muted">{d.zone ? T().zone(d.zone) : T().noProvider}</div></td>
                    <td className="px-3 py-2.5">{d.node || nodeName(d.node_id) || <span className="text-muted">—</span>}{want && <div className="font-mono text-xs text-muted">{want}</div>}</td>
                    <td className="px-3 py-2.5">
                      {d.record_content
                        ? <span className="inline-flex items-center gap-1.5 font-mono text-xs">{d.record_type} {d.record_content}{d.proxied && <Badge tone="warn">{T().proxied}</Badge>}{drift && <Badge tone="bad">{T().ipDrift}</Badge>}</span>
                        : <span className="text-xs text-muted">{T().notByPanel}</span>}
                      {d.synced_at > 0 && <div className="text-[11px] text-muted">{T().synced(ago(d.synced_at))}</div>}
                    </td>
                    <td className="px-3 py-2.5">
                      {cover.length ? <Badge tone={expiryTone(Math.max(...cover.map((c) => c.not_after)))}>{T().certCount(cover.length, expiryText(Math.max(...cover.map((c) => c.not_after))))}</Badge>
                        : provider && d.zone ? <Button size="sm" variant="ghost" onPress={() => onIssue([d.fqdn])}>{T().issueShort}</Button> : <span className="text-xs text-muted">{T().none}</span>}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <span className="inline-flex items-center gap-1">
                        {d.zone && <Button size="sm" variant="ghost" isDisabled={!d.node_id} onPress={() => setSync(d)}>{T().syncDns}</Button>}
                        <ActionMenu label={T().actionsFor(d.fqdn)} onAction={(k) => { if (k === 'records') setRecords(d); if (k === 'rm') setRemoving(d) }}
                          items={[{ id: 'records', label: T().viewRecords, isDisabled: !d.zone }, 'sep', { id: 'rm', label: T().removeFromPanel, danger: true }]} />
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
      <Confirm isOpen={!!removing} onOpenChange={(v) => !v && setRemoving(null)} title={T().rmTitle} confirmLabel={T().rmLabel}
        onConfirm={() => removing && rm.mutate(removing)} body={T().rmBody(<b className="text-text">{rmSticky?.fqdn}</b>)} />
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
    <ModalDialog isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={T().addDomain}
      footer={<>{err && <span className="mr-auto self-center text-[13px] text-bad">{err}</span>}<Button onPress={onClose}>{tr(C).cancel}</Button><Button variant="primary" isPending={busy} isDisabled={!fqdn} onPress={save}>{tr(C).add}</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label={T().domain} value={fqdn} onChange={setFqdn} placeholder="hk.example.com" mono autoFocus
          description={inZone ? T().inZone(inZone.name) : provider ? T().notInZone : T().noProvRecord} />
        <Select label={T().pointsTo} value={nodeId} onChange={setNodeId} options={nodes.map((n) => ({ id: n.id, label: `${n.name}${nodeIP(n) ? ' · ' + nodeIP(n) : ''}` }))} />
        <p className="text-xs text-muted">{T().addHint}</p>
      </div>
    </ModalDialog>
  )
}

/** Shows exactly what a DNS change will do; nothing is written before the user confirms. */
function PlanView({ plan }: { plan: DNSPlan }) {
  const row = (r: DNSRecord, tone: string) => (
    <div className={cx('flex flex-wrap items-center gap-2 rounded-[8px] px-2.5 py-1.5 font-mono text-xs', tone)}>
      <b>{r.type}</b><span>{r.name}</span><span>→ {r.content}</span>{r.proxied ? <Badge tone="warn">{T().proxy}</Badge> : <span className="text-muted">{T().dnsOnly}</span>}
    </div>
  )
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm">
        <Badge tone={plan.action === 'create' ? 'good' : plan.action === 'update' ? 'warn' : plan.action === 'noop' ? 'neutral' : 'bad'}>
          {{ create: T().pCreate, update: T().pUpdate, noop: T().pNoop, conflict: T().pConflict }[plan.action]}
        </Badge>
        <span className="font-mono">{plan.fqdn}</span>
      </div>
      {plan.action === 'update' && plan.before && <><div className="text-xs text-subtle">{T().before}</div>{row(plan.before, 'bg-bad/8 line-through decoration-bad/50')}<div className="text-xs text-subtle">{T().after}</div></>}
      {(plan.action === 'create' || plan.action === 'update') && row(plan.after, 'bg-good/10')}
      {plan.warning && <Callout tone={plan.action === 'conflict' ? 'bad' : 'warn'}>{plan.warning}</Callout>}
      {plan.existing.filter((r) => r.id !== plan.record_id).length > 0 && (
        <details className="text-xs text-subtle">
          <summary className="cursor-pointer outline-none hover:text-text">{T().otherRecords}</summary>
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
      toast('good', T().dnsDone(domain.fqdn, plan!.action === 'create'))
      qc.invalidateQueries({ queryKey: ['domains'] })
      onClose()
    } catch (e) { setErr(errText(e)); if (e instanceof ApiError && e.status === 409) setPlan(null) } finally { setBusy(false) }
  }
  useEffect(() => { setPlan(null) }, [content, proxied])
  return (
    <ModalDialog isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={T().syncTitle(domain.fqdn)}
      footer={<>{err && <span className="mr-auto self-center text-[13px] text-bad">{err}</span>}<Button onPress={onClose}>{tr(C).cancel}</Button>
        {plan && (plan.action === 'create' || plan.action === 'update')
          ? <Button variant="primary" isPending={busy} onPress={apply}>{plan.action === 'create' ? T().confirmCreate : T().confirmUpdate}</Button>
          : <Button variant="primary" isPending={busy} isDisabled={!content} onPress={preview}>{T().previewChange}</Button>}</>}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label={T().recordValue(recordType(content))} value={content} onChange={setContent} mono description={domain.node_ip ? T().nodeAddr(domain.node_ip) : T().noPublicIp} />
          <div className="pb-2"><Switch isSelected={proxied} onChange={setProxied}>{T().cfProxy}</Switch></div>
        </div>
        {plan ? <PlanView plan={plan} /> : <p className="text-xs text-muted">{T().onlyThis(recordType(content))}</p>}
      </div>
    </ModalDialog>
  )
}

function RecordsDialog({ isOpen, onClose, domain }: { isOpen: boolean; onClose: () => void; domain: Domain }) {
  const q = useQuery({ queryKey: ['dns-records', domain.id], queryFn: () => api<DNSRecord[]>(`/dns/records?domain_id=${domain.id}`), retry: false })
  return (
    <ModalDialog isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={T().recordsTitle(domain.fqdn)}>
      {q.isLoading && <Skeleton className="h-20" />}
      {q.error && <Callout tone="bad">{errText(q.error)}</Callout>}
      {q.data?.length === 0 && <p className="text-sm text-subtle">{T().noRecords}</p>}
      <div className="flex flex-col gap-1.5">
        {q.data?.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-[8px] bg-overlay/60 px-3 py-2 font-mono text-xs">
            <b>{r.type}</b><span className="[overflow-wrap:anywhere]">{r.content}</span>{r.proxied && <Badge tone="warn">{T().proxy}</Badge>}
            {r.id === domain.record_id && <Badge tone="accent">{T().managed}</Badge>}
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">{T().readOnly}</p>
    </ModalDialog>
  )
}

// ---------- provider ----------

function ProviderCard({ providers, loading, onConnect, onEdit }: { providers?: Provider[]; loading: boolean; onConnect: () => void; onEdit: (p: Provider) => void }) {
  const [deleting, setDeleting] = useState<Provider | null>(null)
  const verify = useAction({ fn: (p: Provider) => api(`/dns/providers/${p.id}/verify`, { method: 'POST' }), success: T().tokenOk, invalidate: [['dns-providers']] })
  const del = useAction({ fn: (p: Provider) => api(`/dns/providers/${p.id}`, { method: 'DELETE' }), success: T().deleted, invalidate: [['dns-providers'], ['domains']] })
  return (
    <Card title={T().dnsProvider} action={!providers?.length && <Button size="sm" onPress={onConnect}>{T().connectCf}</Button>}>
      {loading && <Skeleton className="h-16" />}
      {providers?.length === 0 && <p className="text-[13px] text-subtle">{T().provIntro}</p>}
      <div className="flex flex-col gap-3">
        {providers?.map((p) => (
          <div key={p.id} className="rounded-[12px] border bg-base p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{p.name}</span><Badge tone="accent">Cloudflare</Badge>
              {p.token_set && <span className="inline-flex items-center gap-1 text-xs text-subtle"><IconKey size={12} />{T().tokenSaved}</span>}
              <span className="flex-1" />
              <ActionMenu label={T().provActions} onAction={(k) => { if (k === 'verify') verify.mutate(p); if (k === 'token') onEdit(p); if (k === 'del') setDeleting(p) }}
                items={[{ id: 'verify', label: T().reverify }, { id: 'token', label: T().changeToken }, 'sep', { id: 'del', label: tr(C).delete, danger: true }]} />
            </div>
            <div className="mt-1 text-xs text-muted">{p.verified_at ? T().verified(ago(p.verified_at)) : ''}{p.last_error && <span className="text-bad"> · {p.last_error}</span>}</div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {p.zones.slice(0, 24).map((z) => <span key={z.id} className="rounded-full bg-overlay px-2 py-0.5 font-mono text-xs">{z.name}</span>)}
              {p.zones.length > 24 && <span className="text-xs text-muted">{T().zonesMore(p.zones.length)}</span>}
            </div>
          </div>
        ))}
      </div>
      <Confirm isOpen={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} danger title={T().delProvTitle} confirmLabel={tr(C).delete}
        onConfirm={() => deleting && del.mutate(deleting)} body={T().delProvBody} />
    </Card>
  )
}

function TokenHelp() {
  return (
    <details className="rounded-[10px] bg-overlay/60 px-3 py-2 text-xs text-subtle">
      <summary className="cursor-pointer font-medium outline-none hover:text-text">{T().howToken}</summary>
      <ol className="mt-2 ml-4 list-decimal space-y-1">
        <li>{T().tok1}</li>
        <li>{T().tok2}</li>
        <li>{T().tok3}</li>
      </ol>
      <p className="mt-2">{T().tokNote}</p>
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
    <ModalDialog isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={edit ? T().changeCfToken : T().connectCf}
      footer={<>{err && <span className="mr-auto max-w-full self-center text-[13px] break-all text-bad">{err}</span>}<Button onPress={onClose}>{tr(C).cancel}</Button>
        <Button variant="primary" isPending={busy} isDisabled={!edit && token.length < 20} onPress={save}>{T().verifySave}</Button></>}>
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
      <Field label={T().apiToken} type="password" autoComplete="off" value={token} onChange={setToken} mono placeholder={T().pasteToken} />
      <Field label={T().name} value={name} onChange={setName} />
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
    try { await api('/probe/settings', { method: 'PUT', body: { url, fallback_url: fb, interval: Number(iv) } }); qc.invalidateQueries({ queryKey: ['probe-settings'] }); toast('good', tr(C).saved) }
    catch (e) { toast('bad', errText(e)) } finally { setBusy(false) }
  }
  return (
    <Card title={T().probeTitle} action={<Button size="sm" isPending={busy} onPress={save}>{tr(C).save}</Button>}>
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-subtle">{T().probeIntro}</p>
        <Field label={T().probeUrl} value={url} onChange={setUrl} mono />
        <Field label={T().fallbackUrl} value={fb} onChange={setFb} mono description={T().fallbackHint} />
        <Select label={T().schedule} value={iv} onChange={setIv} description={T().scheduleHint}
          options={[{ id: '0', label: tr(C).off }, { id: '5', label: T().every5 }, { id: '15', label: T().every15 }, { id: '60', label: T().hourly }]} />
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
      if (replace?.uses.length) track({ text: T().replacedX(replace.name) })
      onClose()
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  const mismatch = replace && pv && replace.sans.some((s) => !pv.sans.includes(s))
  return (
    <ModalDialog wide isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={replace ? T().replaceTitle(replace.name) : T().uploadTitle} dirty={!!cert || !!key}
      footer={<>{err && <span className="mr-auto max-w-full self-center text-[13px] break-all text-bad">{err}</span>}<Button onPress={onClose}>{tr(C).cancel}</Button>
        <Button variant="primary" isPending={busy} isDisabled={!pv} onPress={save}>{replace ? T().replaceDeploy : tr(C).save}</Button></>}>
      <div className="flex flex-col gap-3">
        {!replace && <Field label={T().name} value={name} onChange={setName} placeholder={T().defaultName} />}
        <div className="grid gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Field label={T().certChain} multiline rows={9} mono value={cert} onChange={setCert} placeholder="-----BEGIN CERTIFICATE-----" />
            <div><PemFileButton label={T().pickCert} onText={setCert} /></div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Field label={T().privKey} multiline rows={9} mono value={key} onChange={setKey} placeholder="-----BEGIN PRIVATE KEY-----" />
            <div><PemFileButton label={T().pickKey} onText={setKey} /></div>
          </div>
        </div>
        {pv && (
          <div className="animate-content-in rounded-[12px] bg-good/8 p-3 text-[13px]">
            <div className="flex items-center gap-2 font-medium text-good"><IconCheck size={14} />{T().keyMatches}</div>
            <div className="mt-2 grid gap-1 text-subtle sm:grid-cols-2">
              <div>{T().pvDomains}<span className="font-mono text-text">{pv.sans.join(', ')}</span></div>
              <div>{T().pvIssuer}<span className="text-text">{pv.issuer}</span>{pv.self_signed && <Badge tone="warn">{T().selfSigned}</Badge>}</div>
              <div>{T().validUntil}<span className="text-text">{date(pv.not_after)}</span> <Badge tone={expiryTone(pv.not_after)}>{expiryText(pv.not_after)}</Badge></div>
              <div className="truncate">{T().fingerprint}<span className="font-mono text-xs">{pv.fingerprint.slice(0, 32)}…</span></div>
            </div>
            {mismatch && <div className="mt-2 text-warn">{T().missingSans(replace!.sans.join(', '))}</div>}
          </div>
        )}
        {replace && <p className="text-xs text-muted">{T().replaceNote}</p>}
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
    <ModalDialog isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={T().nodeCertTitle}
      footer={<>{err && <span className="mr-auto max-w-full self-center text-[13px] break-all text-bad">{err}</span>}<Button onPress={onClose}>{tr(C).cancel}</Button>
        <Button variant="primary" isPending={busy} isDisabled={!nodeId || (mode === 'certbot' ? !lineage : !certPath || !keyPath)} onPress={save}>{tr(C).add}</Button></>}>
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-subtle">{T().nodeCertIntro}</p>
        <Select label={tr(C).node} value={nodeId} onChange={(v) => { setNodeId(v); setLineage('') }} options={nodes.map((n) => ({ id: n.id, label: n.name }))} />
        <Segmented label={T().method} value={mode} onChange={setMode} options={[{ id: 'certbot', label: 'certbot' }, { id: 'path', label: T().customPath }]} />
        {mode === 'certbot' ? (
          <>
            <Field label={T().certbotName} value={lineage} onChange={setLineage} mono placeholder="example.com"
              description={T().certbotUses(lineage || T().namePh)} />
            {names.data && (names.data.names.length ? (
              <div className="flex flex-wrap gap-1.5">
                <span className="text-xs text-muted">{T().foundOn(node?.name ?? '')}</span>
                {names.data.names.map((n) => (
                  <button key={n} type="button" onClick={() => setLineage(n)} aria-pressed={lineage === n}
                    className={cx('cursor-pointer rounded-full px-2 py-0.5 font-mono text-xs outline-none transition-colors duration-(--dur-1) focus-visible:ring-2 focus-visible:ring-accent', lineage === n ? 'bg-accent text-on-accent' : 'bg-overlay hover:bg-hl-med')}>{n}</button>
                ))}
              </div>
            ) : <p className="text-xs text-muted">{node?.online ? T().noneFound(node.name) : T().nodeOffline}</p>)}
          </>
        ) : (
          <>
            <Field label={T().certPath} value={certPath} onChange={setCertPath} mono placeholder="/etc/ssl/example.com/fullchain.pem" />
            <Field label={T().keyPath} value={keyPath} onChange={setKeyPath} mono placeholder="/etc/ssl/example.com/privkey.pem" />
          </>
        )}
        <Field label={T().name} value={name} onChange={setName} placeholder={T().optional} />
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
      <Segmented label={T().certType} value={mode} onChange={setMode} options={[{ id: 'single', label: T().perDomain }, { id: 'wildcard', label: T().wildcard }]} />
      <Field label={T().domainsPerLine} multiline rows={3} mono value={text} onChange={setText} placeholder="hk.example.com" />
      {plan.length > 0 && (
        <div className="flex flex-col gap-1 text-xs text-subtle">
          {T().willIssue(plan.length)}
          {plan.map((ds) => <span key={ds.join()} className="font-mono text-text">{ds.join(' + ')}</span>)}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label={T().ca} value={ca} onChange={setCa} options={[{ id: 'letsencrypt', label: "Let's Encrypt" }, { id: 'zerossl', label: 'ZeroSSL' }]} />
        <Field label={T().email} value={email} onChange={setEmail} placeholder={ca === 'zerossl' ? T().zerosslReq : T().emailOpt} />
      </div>
      <Switch isSelected={staging} onChange={setStaging}>{T().stagingSwitch}</Switch>
      <p className="text-xs text-muted">{T().issueNote}</p>
      {err && <Callout tone="bad">{err}</Callout>}
      <div><Button variant="primary" isPending={busy} isDisabled={!provider || plan.length === 0 || (ca === 'zerossl' && !email)} onPress={go}>{T().issueN(plan.length)}</Button></div>
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
          <Badge tone={statusBadge[c.status].tone}>{c.status === 'pending' || c.renewing ? T().validating : statusBadge[c.status].text}</Badge>
          {c.last_error && <div className="w-full text-xs text-bad [overflow-wrap:anywhere]">{c.last_error}</div>}
        </div>
      ))}
    </div>
  )
}

function IssueDialog({ isOpen, onClose, provider, domains }: { isOpen: boolean; onClose: () => void; provider?: Provider; domains?: string[] }) {
  const [ids, setIds] = useState<string[] | null>(null)
  return (
    <ModalDialog isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={T().issueTitle} footer={ids ? <Button onPress={onClose}>{T().done}</Button> : undefined}>
      {ids ? <IssueProgress ids={ids} /> : <IssueForm provider={provider} domains={domains} onIssued={setIds} />}
    </ModalDialog>
  )
}

// ---------- guided setup ----------

const guideSteps = () => [T().w1t, T().w2t, T().w3t, T().w4t]

function Stepper({ step, done }: { step: number; done: boolean[] }) {
  return (
    <ol className="no-scrollbar mb-5 flex gap-2 overflow-x-auto" aria-label={T().steps}>
      {guideSteps().map((s, i) => (
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
      {step > 0 && <Button variant="ghost" onPress={() => setStep(step - 1)}>{T().prev}</Button>}
      <span className="flex-1" />
      {step < 3 ? <Button onPress={next}>{done[step] ? T().next : T().skip}</Button> : <Button variant="primary" onPress={onClose}>{T().done}</Button>}
    </>
  )
  return (
    <ModalDialog wide isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={T().guideTitle} footer={footer}>
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
        <Callout tone="good">{T().connected(provider.name, provider.zones.length)}</Callout>
        <div className="flex flex-wrap gap-1.5">{provider.zones.map((z) => <span key={z.id} className="rounded-full bg-overlay px-2 py-0.5 font-mono text-xs">{z.name}</span>)}</div>
        <div><Button variant="primary" onPress={onDone}>{T().nextDomains}</Button></div>
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
      <p className="text-[13px] text-subtle">{T().provGuideIntro}</p>
      <TokenForm token={token} setToken={setToken} name={name} setName={setName} />
      {err && <Callout tone="bad">{err}</Callout>}
      <div><Button variant="primary" isPending={busy} isDisabled={token.length < 20} onPress={save}>{T().verifyToken}</Button></div>
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
  if (!provider) return <Callout>{T().noCfDomains}</Callout>
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
      else { toast('good', T().domainsAdded(chosen.length)); onDone() }
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
      toast('good', T().dnsWritten)
      setConfirm(false)
      onDone()
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  const changes = (plans ?? []).filter((p) => p.plan.action === 'create' || p.plan.action === 'update').length
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-subtle">{T().domGuideIntro}</p>
      <div className="flex flex-col gap-2">
        {rows.map((r, i) => (
          <div key={r.node.id} className={cx('grid items-center gap-2 rounded-[12px] border p-3 transition-opacity duration-(--dur-1) md:grid-cols-[auto_minmax(0,1fr)_auto]', !r.on && 'opacity-60')}>
            <Checkbox isSelected={r.on} onChange={(on) => set(i, { on })} label={T().domainFor(r.node.name)}>
              <span className="min-w-[96px] text-sm font-medium">{r.node.name}</span>
            </Checkbox>
            <div className="flex min-w-0 items-center gap-1">
              <Field label={T().subdomain} hideLabel value={r.sub} onChange={(sub) => set(i, { sub: sub.toLowerCase() })} mono className="w-32 shrink-0" />
              <span className="text-muted">.</span>
              <Select label={T().zoneLabel} hideLabel value={r.zone} onChange={(zone) => set(i, { zone })} options={zones.map((z) => ({ id: z.name, label: z.name }))} className="min-w-0 flex-1" />
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[13px]">
              <span className="font-mono text-xs text-subtle" title={T().publicAddr}>{r.ip || T().noIp}</span>
              <Checkbox isSelected={r.dns} isDisabled={!r.ip} onChange={(dns) => set(i, { dns })}>{T().writeDns}</Checkbox>
              <Switch isSelected={r.proxied} isDisabled={!r.dns} onChange={(proxied) => set(i, { proxied })} label={T().cfProxyLabel}>{T().proxyShort}</Switch>
            </div>
          </div>
        ))}
      </div>
      {rows.some((r) => r.proxied) && <Callout tone="warn">{T().proxyWarn}</Callout>}
      {err && <Callout tone="bad">{err}</Callout>}
      <div><Button variant="primary" isPending={busy && !confirm} isDisabled={chosen.length === 0} onPress={prepare}>{T().addN(chosen.length, chosen.some((r) => r.dns))}</Button></div>
      <ModalDialog isOpen={confirm} onOpenChange={setConfirm} title={T().confirmN(changes)}
        footer={<>{err && <span className="mr-auto self-center text-[13px] text-bad">{err}</span>}<Button onPress={() => setConfirm(false)}>{tr(C).cancel}</Button><Button variant="primary" isPending={busy} onPress={apply}>{T().confirmWrite}</Button></>}>
        <div className="flex flex-col gap-4">
          <p className="text-[13px] text-subtle">{T().onlyListed}</p>
          {(plans ?? []).map((p) => <PlanView key={p.domain.id} plan={p.plan} />)}
        </div>
      </ModalDialog>
    </div>
  )
}

function GuideIssue({ provider, onDone }: { provider?: Provider; onDone: () => void }) {
  const [ids, setIds] = useState<string[] | null>(null)
  if (!provider) return <Callout>{T().noCfIssue}</Callout>
  return ids ? (
    <div className="flex flex-col gap-3">
      <IssueProgress ids={ids} />
      <p className="text-xs text-muted">{T().issueBg}</p>
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
      track({ text: T().switchedN(changed.length) })
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
  if (!tls.length) return <Callout>{T().noTls}</Callout>
  const usable = (certs.data ?? []).filter((c) => c.has_material)
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-subtle">{T().assignIntro}</p>
      <div className="flex flex-col gap-2">
        {tls.map((i) => {
          const c = usable.find((x) => x.id === pick[i.id])
          const sni = sniOf(i)
          return (
            <div key={i.id} className="grid items-center gap-2 rounded-[12px] border p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <div className="min-w-0"><div className="text-sm font-medium">{i.tag} <span className="font-normal text-subtle">· {i.node}</span></div><div className="truncate font-mono text-xs text-muted">{i.type} · SNI {sni || '—'}</div></div>
              <div className="flex min-w-0 flex-col gap-1">
                <Select label={T().certOf(i.tag)} hideLabel value={pick[i.id] ?? ''} onChange={(v) => setPick({ ...pick, [i.id]: v })} placeholder={T().keep}
                  options={[{ id: '', label: T().keep }, ...usable.map((x) => ({ id: x.id, label: certLabel(x) }))]} />
                {c && sni && !covers(c.sans, sni) && <span className="text-xs text-warn">{T().sniChange(sni)}</span>}
              </div>
            </div>
          )
        })}
      </div>
      {err && <Callout tone="bad">{err}</Callout>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" isPending={busy} isDisabled={!changed.length} onPress={apply}>{T().applyN(changed.length)}</Button>
        {applied && <Button isPending={probe.isPending} onPress={test}>{T().testConn}</Button>}
      </div>
      {probeRes && <ProbeSummary results={probeRes} />}
    </div>
  )
}

function ProbeSummary({ results }: { results: ProbeResult[] }): ReactNode {
  const h = healthOf(results)
  return (
    <div className="flex flex-col gap-1.5">
      <Callout tone={h === 'ok' ? 'good' : h === 'bad' ? 'bad' : 'warn'}>{T().okOf(results.filter((r) => r.ok).length, results.length)}</Callout>
      {results.filter((r) => !r.ok).map((r) => <div key={r.inbound_id + r.endpoint} className="text-xs text-bad">{r.tag} · {r.endpoint}: {r.error}</div>)}
    </div>
  )
}
