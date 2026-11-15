import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAction } from '../../lib/actions'
import { ago, date } from '../../lib/fmt'
import { href } from '../../lib/router'
import {
  DEFAULT_RATE, MCP_TOOLS, SCOPES, claudeMcpCommand, curlExample, mcpJsonConfig, panelOrigin, scopeLabel,
  type ApiKey, type ApiKeyCreate, type Scope,
} from '../../lib/apikeys'
import { Badge, Button, Callout, Card, Checkbox, Confirm, CopyButton, CopyText, Field, IconButton, ModalDialog, Segmented, Skeleton, cx, useSticky } from '../../ui/kit'
import { IconKey, IconPlus, IconTrash } from '../../ui/icons'
import { tr, useT } from '../../i18n'
import { C } from '../../i18n/common'
import { AG } from '../../i18n/apikeys'

/** Settings → API & agents: scoped keys, MCP connection and API docs. */
export function ApiAgents() {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <ApiKeys />
      <McpCard />
      <DocsCard />
    </div>
  )
}

function ScopeBadges({ scopes }: { scopes: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {scopes.map((s) => <Badge key={s} tone={s === 'admin' ? 'warn' : s === 'read' ? 'neutral' : 'accent'}>{scopeLabel(s)}</Badge>)}
    </span>
  )
}

function expiryText(k: ApiKey) {
  const t = tr(AG)
  if (k.expired) return <Badge tone="bad" dot>{t.expired}</Badge>
  if (!k.expires_at) return <span>{t.neverExpires}</span>
  const days = (k.expires_at - Date.now() / 1000) / 86400
  return <span className={cx(days < 7 && 'text-warn')}>{t.expiresOn(date(k.expires_at))}</span>
}

function ApiKeys() {
  const t = useT(AG)
  const keys = useQuery({ queryKey: ['tokens'], queryFn: () => api<ApiKey[]>('/tokens') })
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<ApiKey | null>(null)
  const del = useAction({ fn: (id: number) => api(`/tokens/${id}`, { method: 'DELETE' }), success: t.keyDeleted, invalidate: [['tokens']] })
  const delSticky = useSticky(deleting)
  return (
    <Card className="xl:col-span-2" title={t.apiKeys} action={<Button size="sm" variant="primary" onPress={() => setCreating(true)}><IconPlus size={15} />{t.createKey}</Button>}>
      <p className="mb-3 text-[13px] text-subtle">
        {t.intro()}
      </p>
      {keys.isLoading ? <Skeleton className="h-16" /> : (keys.data?.length ?? 0) === 0 ? (
        <div className="flex items-center gap-3 rounded-[12px] border border-dashed px-4 py-5 text-[13px] text-subtle">
          <IconKey size={18} className="shrink-0 text-muted" />{t.empty}
        </div>
      ) : (
        <ul className="flex flex-col divide-y rounded-[12px] border">
          {keys.data!.map((k) => (
            <li key={k.id} className={cx('flex items-start gap-3 px-4 py-3 animate-content-in', k.expired && 'opacity-70')}>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium [overflow-wrap:anywhere]">{k.name}</span>
                  <span className="font-mono text-xs text-muted">{k.prefix}…</span>
                  <ScopeBadges scopes={k.scopes} />
                </div>
                {k.description && <p className="text-[13px] text-subtle [overflow-wrap:anywhere]">{k.description}</p>}
                <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-subtle">
                  <div className="flex gap-1"><dt className="text-muted">{t.validity}</dt><dd>{expiryText(k)}</dd></div>
                  <div className="flex gap-1"><dt className="text-muted">{t.rate}</dt><dd className="tabular">{t.perMin(k.rate_limit)}</dd></div>
                  <div className="flex gap-1"><dt className="text-muted">{t.source}</dt><dd className="font-mono [overflow-wrap:anywhere]">{k.allow_ips.length ? k.allow_ips.join(', ') : t.anyIp}</dd></div>
                  <div className="flex gap-1"><dt className="text-muted">{t.lastUsed}</dt><dd>{ago(k.last_used)}{k.last_ip && <span className="ml-1 font-mono">{k.last_ip}</span>}</dd></div>
                </dl>
              </div>
              <IconButton label={t.deleteKeyX(k.name)} onPress={() => setDeleting(k)}><IconTrash size={15} /></IconButton>
            </li>
          ))}
        </ul>
      )}
      <CreateKeyDialog isOpen={creating} onOpenChange={setCreating} />
      <Confirm isOpen={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} danger title={t.deleteKey} confirmLabel={t.deleteKey}
        onConfirm={() => deleting && del.mutate(deleting.id)} body={t.deleteBody(delSticky?.name ?? '')} />
    </Card>
  )
}

const EXPIRY_IDS = ['0', '7', '30', '90', '365'] as const
type ExpiryId = (typeof EXPIRY_IDS)[number]
const EXPIRY = () => { const t = tr(AG); return EXPIRY_IDS.map((id) => ({ id, label: id === '0' ? t.e_never : t[`e_${id}`] })) }

function CreateKeyDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (v: boolean) => void }) {
  const t = useT(AG)
  const c = useT(C)
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [scopes, setScopes] = useState<Scope[]>(['read'])
  const [expiry, setExpiry] = useState<ExpiryId>('90')
  const [ips, setIps] = useState('')
  const [rate, setRate] = useState('')
  const [created, setCreated] = useState<{ token: string; key: ApiKey } | null>(null)
  const reset = () => { setName(''); setDesc(''); setScopes(['read']); setExpiry('90'); setIps(''); setRate(''); setCreated(null); create.reset() }
  const close = (v: boolean) => { onOpenChange(v); if (!v) setTimeout(reset, 250) }
  const rateN = rate.trim() === '' ? 0 : Number(rate)
  const rateBad = rate.trim() !== '' && (!Number.isInteger(rateN) || rateN < 1 || rateN > 100000)
  const create = useMutation({
    mutationFn: () => {
      const body: ApiKeyCreate = {
        name: name.trim(), description: desc.trim(), scopes, expires_in_days: Number(expiry) || undefined,
        allow_ips: ips.split(/[\s,;]+/).filter(Boolean), rate_limit: rateN || undefined,
      }
      return api<{ token: string; key: ApiKey }>('/tokens', { method: 'POST', body })
    },
    onSuccess: (r) => { setCreated(r); qc.invalidateQueries({ queryKey: ['tokens'] }) },
  })
  const admin = scopes.includes('admin')
  const toggle = (s: Scope, on: boolean) => setScopes((cur) => on ? [...cur, s] : cur.filter((x) => x !== s))
  const valid = name.trim() !== '' && scopes.length > 0 && !rateBad

  if (created) {
    const tok = created.token
    return (
      <ModalDialog isOpen={isOpen} onOpenChange={close} title={t.created} wide footer={<Button variant="primary" onPress={() => close(false)}>{c.done}</Button>}>
        <div className="flex flex-col gap-4 animate-content-in">
          <Callout tone="warn">{t.once}</Callout>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-subtle">{created.key.name} · <ScopeBadgesInline scopes={created.key.scopes} /></span>
            <div className="flex items-center gap-2 rounded-[10px] border bg-base px-3 py-2.5">
              <CopyText text={tok} className="min-w-0 flex-1 text-[13px] text-text" />
            </div>
          </div>
          <Snippet title={t.testCurl} text={curlExample(tok, created.key.scopes)} />
          <Snippet title={t.addClaude} text={claudeMcpCommand(tok)} />
          <Snippet title={t.otherMcp} text={mcpJsonConfig(tok)} />
        </div>
      </ModalDialog>
    )
  }

  return (
    <ModalDialog isOpen={isOpen} onOpenChange={close} title={t.createTitle} wide dirty={!!name.trim() || !!desc.trim() || !!ips.trim()}
      footer={<>
        <Button onPress={() => close(false)}>{c.cancel}</Button>
        <Button variant="primary" isPending={create.isPending} isDisabled={!valid} onPress={() => create.mutate()}>{t.createKey}</Button>
      </>}>
      <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); if (valid) create.mutate() }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.name} value={name} onChange={setName} placeholder={t.namePh} autoFocus isRequired description={t.nameHint} />
          <Field label={t.desc} value={desc} onChange={setDesc} placeholder={t.descPh} />
        </div>
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1.5 text-[13px] font-medium text-subtle">{t.scopes}</legend>
          <div className="grid gap-px overflow-hidden rounded-[12px] border bg-hl-low sm:grid-cols-2">
            {SCOPES.map((s) => {
              const implied = admin && s.id !== 'admin'
              return (
                <div key={s.id} className={cx('bg-surface px-3 py-2.5', s.id === 'admin' && 'sm:col-span-2')}>
                  <Checkbox isSelected={scopes.includes(s.id) || implied} isDisabled={implied} onChange={(v) => toggle(s.id, v)}>
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium">{s.label} <span className="font-mono text-xs font-normal text-muted">{s.id}</span></span>
                      <span className="text-xs text-subtle">{s.desc}</span>
                    </span>
                  </Checkbox>
                </div>
              )
            })}
          </div>
          {scopes.length === 0 && <span className="text-xs text-bad">{t.pickScope}</span>}
          {admin && <span className="text-xs text-warn">{t.adminWarn}</span>}
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-subtle">{t.validity}</span>
          <div><Segmented label={t.validity} value={expiry} onChange={setExpiry} options={EXPIRY()} /></div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.ips} multiline rows={3} mono value={ips} onChange={setIps} placeholder={'203.0.113.7\n10.0.0.0/8'}
            description={t.ipsHint} />
          <Field label={t.rateLabel} inputMode="numeric" value={rate} onChange={setRate} placeholder={String(DEFAULT_RATE)}
            isInvalid={rateBad} errorMessage={t.rateErr} description={t.rateHint(DEFAULT_RATE)} />
        </div>
        {create.error && <Callout tone="bad">{(create.error as Error).message}</Callout>}
        <button type="submit" hidden />
      </form>
    </ModalDialog>
  )
}

function ScopeBadgesInline({ scopes }: { scopes: string[] }) {
  return <span className="font-normal">{scopes.map(scopeLabel).join(tr(AG).listSep)}</span>
}

function Snippet({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-subtle">{title}</span>
        <CopyButton text={text} />
      </div>
      <pre className="overflow-x-auto rounded-[10px] border bg-base px-3 py-2.5 font-mono text-[12px] leading-5 whitespace-pre-wrap [overflow-wrap:anywhere] text-text">{text}</pre>
    </div>
  )
}

function McpCard() {
  const t = useT(AG)
  const url = `${panelOrigin()}/mcp`
  return (
    <Card title={t.mcpTitle}>
      <div className="flex flex-col gap-3 text-[13px]">
        <p className="text-subtle">
          {t.mcpIntro()}
        </p>
        <div className="flex min-w-0 items-center gap-2 rounded-[10px] border bg-base px-3 py-2">
          <span className="shrink-0 text-xs text-muted">{t.endpoint}</span><CopyText text={url} className="min-w-0 text-text" />
        </div>
        <Snippet title="Claude Code" text={claudeMcpCommand('sbp_…')} />
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-subtle">{t.tools}</span>
          <div className="flex flex-wrap gap-1.5">
            {MCP_TOOLS.map((m) => (
              <span key={m.name} title={m.desc} className={cx('inline-flex h-[22px] items-center rounded-full px-2 font-mono text-[11.5px]', m.write ? 'bg-accent/12 text-accent' : 'bg-overlay text-subtle')}>{m.name}</span>
            ))}
          </div>
          <p className="text-xs text-muted">{t.toolsHint}</p>
        </div>
      </div>
    </Card>
  )
}

function DocsCard() {
  const t = useT(AG)
  return (
    <Card title={t.docsTitle}>
      <div className="flex flex-col gap-3 text-[13px] text-subtle">
        <p>{t.docsIntro}</p>
        <ul className="flex flex-col gap-1.5">
          <li className="flex gap-2"><span className="w-24 shrink-0 text-muted">{t.auth}</span><span className="font-mono text-text">Authorization: Bearer sbp_…</span></li>
          <li className="flex gap-2"><span className="w-24 shrink-0 text-muted">{t.spec}</span><span className="font-mono text-text">GET /api/openapi.json</span></li>
          <li className="flex gap-2"><span className="w-24 shrink-0 text-muted">{t.limit}</span><span>{t.limitBody()}</span></li>
        </ul>
        <div className="flex flex-wrap gap-2">
          <a href={href('settings', { view: 'api-docs' })} className="inline-flex h-8 items-center rounded-full bg-accent px-4 text-sm font-medium text-on-accent outline-none transition-[filter] duration-(--dur-1) hover:brightness-110 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base">{t.openDocs}</a>
          <a href="/api/openapi.json" download="sbpanel-openapi.json" className="inline-flex h-8 items-center rounded-full bg-overlay px-4 text-sm font-medium text-text outline-none transition-colors duration-(--dur-1) hover:bg-hl-med/70 focus-visible:ring-2 focus-visible:ring-accent">{t.dlSpec}</a>
        </div>
      </div>
    </Card>
  )
}
