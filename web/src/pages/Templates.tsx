import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Tooltip, TooltipTrigger } from 'react-aria-components'
import { useAction } from '../lib/actions'
import { api, type Node, type Template } from '../lib/api'
import { lineDiff, compact } from '../lib/diff'
import { dateTime } from '../lib/fmt'
import { useRoute, go } from '../lib/router'
import { Badge, Button, Callout, Card, Confirm, Empty, Field, IconButton, ModalDialog, PageHeader, Presence, Select, Skeleton, Tabs, cx, useSticky } from '../ui/kit'
import { IconArrowDown, IconArrowUp, IconEdit, IconPlus, IconTrash } from '../ui/icons'
import { tr, useT } from '../i18n'
import { T } from '../i18n/templates'

type Obj = Record<string, any>

type Preset = { readonly label: string; v: Obj }

const outboundPresets: Preset[] = [
  { get label() { return tr(T).pDirect }, v: { type: 'direct', tag: 'direct-v4', domain_resolver: { server: 'local', strategy: 'ipv4_only' } } },
  { get label() { return tr(T).pSocks }, v: { type: 'socks', tag: 'socks-out', server: '127.0.0.1', server_port: 1080, version: '5' } },
  { get label() { return tr(T).pSs }, v: { type: 'shadowsocks', tag: 'ss-relay', server: 'relay.example.com', server_port: 8388, method: '2022-blake3-aes-128-gcm', password: '' } },
  { get label() { return tr(T).pVless }, v: { type: 'vless', tag: 'vless-relay', server: 'relay.example.com', server_port: 443, uuid: '', flow: 'xtls-rprx-vision', tls: { enabled: true, server_name: 'www.microsoft.com', utls: { enabled: true, fingerprint: 'chrome' }, reality: { enabled: true, public_key: '', short_id: '' } } } },
  { get label() { return tr(T).pSelector }, v: { type: 'selector', tag: 'select', outbounds: ['direct'] } },
]

const rulePresets: Preset[] = [
  { get label() { return tr(T).pBlockBt }, v: { protocol: ['bittorrent'], action: 'reject' } },
  { get label() { return tr(T).pBlockPriv }, v: { ip_is_private: true, action: 'reject' } },
  { get label() { return tr(T).pSuffix }, v: { domain_suffix: ['openai.com', 'chatgpt.com'], outbound: 'direct' } },
  { get label() { return tr(T).pRuleSet }, v: { rule_set: ['geosite-netflix'], outbound: 'direct' } },
  { get label() { return tr(T).pResolve }, v: { action: 'resolve' } },
]

const ruleSetPresets: Preset[] = [
  { get label() { return tr(T).pGeosite }, v: { type: 'remote', tag: 'geosite-netflix', format: 'binary', url: 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-netflix.srs', download_detour: 'direct' } },
  { get label() { return tr(T).pGeoip }, v: { type: 'remote', tag: 'geoip-cn', format: 'binary', url: 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs', download_detour: 'direct' } },
]

const dnsPresets: Preset[] = [
  { get label() { return tr(T).pSysDns }, v: { type: 'local', tag: 'local' } },
  { label: 'DoH 1.1.1.1', v: { type: 'https', tag: 'cf-doh', server: '1.1.1.1' } },
  { label: 'TCP 8.8.8.8', v: { type: 'tcp', tag: 'google-tcp', server: '8.8.8.8' } },
]

function parse(s: string): Obj | null {
  try { return JSON.parse(s) } catch { return null }
}

export function TemplatesPage() {
  const { params } = useRoute()
  const l = useT(T)
  const ts = useQuery({ queryKey: ['templates'], queryFn: () => api<Template[]>('/templates') })
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<Node[]>('/nodes') })
  const id = Number(params.get('id')) || ts.data?.[0]?.id
  const t = ts.data?.find((x) => x.id === id)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const del = useAction({
    fn: () => api(`/templates/${id}`, { method: 'DELETE' }),
    success: l.deleted, invalidate: [['templates']], onSuccess: () => go('templates'),
  })
  const nodeName = new Map((nodes.data ?? []).map((n) => [n.id, n.name]))
  return (
    <>
      <PageHeader title={l.title} subtitle={l.subtitle}
        actions={<Button variant="primary" onPress={() => setCreating(true)}><IconPlus size={16} />{l.newTpl}</Button>} />
      {ts.isLoading && <Skeleton className="h-64" />}
      {ts.data && (
        <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          <nav aria-label={l.listLabel} className="flex flex-col gap-1">
            {ts.data.map((x) => (
              <a key={x.id} href={`#/templates?id=${x.id}`}
                className={cx('rounded-[10px] border px-3 py-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent',
                  x.id === id ? 'border-accent/50 bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface))]' : 'bg-surface hover:bg-overlay')}>
                <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{x.name}</span>{x.has_draft && <Badge tone="warn">{l.draft}</Badge>}</div>
                <div className="mt-0.5 text-xs text-muted">{l.nNodes(x.nodes.length)} · {dateTime(x.updated_at)}</div>
              </a>
            ))}
          </nav>
          {t ? <Editor key={t.id} t={t} nodeNames={t.nodes.map((n) => nodeName.get(n) ?? n)} onDelete={() => setDeleting(true)} /> : <Card><Empty title={l.pick} /></Card>}
        </div>
      )}
      <Presence value={creating || null}>{(_, open) => <CreateTemplate isOpen={open} templates={ts.data ?? []} onClose={() => setCreating(false)} />}</Presence>
      <Confirm isOpen={deleting} onOpenChange={setDeleting} danger title={l.deleteTpl} confirmLabel={l.deleteTpl} onConfirm={() => del.mutate()}
        body={l.deleteBody(<b className="text-text">{t?.name}</b>)} />
    </>
  )
}

function CreateTemplate({ templates, onClose, isOpen }: { templates: Template[]; onClose: () => void; isOpen: boolean }) {
  const [name, setName] = useState('')
  const l = useT(T)
  const [from, setFrom] = useState(String(templates[0]?.id ?? ''))
  const create = useAction({
    fn: () => api<{ id: number }>('/templates', { method: 'POST', body: { name, from: Number(from) || 0 } }),
    success: l.created, invalidate: [['templates']], onSuccess: (r) => { onClose(); go('templates', { id: r.id }) },
  })
  return (
    <ModalDialog isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={l.newTpl}
      footer={<><Button onPress={onClose}>{l.cancel}</Button><Button variant="primary" isPending={create.isPending} isDisabled={!name.trim()} onPress={() => create.mutate()}>{l.create}</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label={l.name} value={name} onChange={setName} autoFocus />
        <Select label={l.copyFrom} value={from} onChange={setFrom} options={[{ id: '0', label: l.defaultSkel }, ...templates.map((t) => ({ id: String(t.id), label: t.name }))]} />
      </div>
    </ModalDialog>
  )
}

function Editor({ t, nodeNames, onDelete }: { t: Template; nodeNames: string[]; onDelete: () => void }) {
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const l = useT(T)
  const [text, setText] = useState(t.draft || t.json)
  const [tab, setTab] = useState<'struct' | 'json'>('struct')
  const [diff, setDiff] = useState(false)
  const [name, setName] = useState(t.name)
  useEffect(() => { setText(t.draft || t.json) }, [t.draft, t.json])
  const cfg = parse(text)
  const dirty = text !== (t.draft || t.json)
  const pending = (t.draft && t.draft !== t.json) || false

  const saveDraft = useAction({
    fn: (draft: string) => api(`/templates/${t.id}`, { method: 'PATCH', body: { draft, name } }),
    success: l.draftSaved, invalidate: [['templates']],
  })
  const apply = useAction({
    fn: () => api<{ nodes: string[] }>(`/templates/${t.id}/apply`, { method: 'POST' }),
    apply: true, success: l.publishedX(t.name), invalidate: [['templates'], ['nodes']], onSuccess: () => setDiff(false),
  })
  const discard = useAction({
    fn: () => api(`/templates/${t.id}`, { method: 'PATCH', body: { draft: '' } }),
    success: l.draftDiscarded, invalidate: [['templates']], onSuccess: () => setText(t.json),
  })
  const update = (fn: (c: Obj) => void) => {
    if (!cfg) return
    const c = structuredClone(cfg)
    fn(c)
    setText(JSON.stringify(c, null, 2))
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field className="w-56" label={l.tplName} value={name} onChange={setName} />
          <div className="text-[13px] text-subtle">{l.usedBy(nodeNames.length ? nodeNames.join(l.listSep) : l.noNodes)}</div>
          <div className="ml-auto flex flex-wrap gap-2">
            <TooltipTrigger delay={200}>
              <span tabIndex={nodeNames.length ? 0 : -1} className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent">
                <IconButton label={l.deleteTpl} isDisabled={nodeNames.length > 0} onPress={onDelete}><IconTrash size={16} /></IconButton>
              </span>
              {nodeNames.length > 0 && <Tooltip placement="bottom" className="max-w-[260px] rounded-[8px] bg-text px-2.5 py-1.5 text-xs text-base shadow data-[entering]:animate-pop-in data-[exiting]:animate-pop-out">
                {l.inUse(nodeNames.length, nodeNames.join(l.listSep))}</Tooltip>}
            </TooltipTrigger>
            {pending && <Button onPress={() => setConfirmDiscard(true)}>{l.discardDraft}</Button>}
            <Button isPending={saveDraft.isPending} isDisabled={(!dirty && name === t.name) || !cfg} onPress={() => saveDraft.mutate(text)}>{l.saveDraft}</Button>
            <Button variant="primary" isDisabled={dirty || !pending} onPress={() => setDiff(true)}>{l.reviewPublish}</Button>
          </div>
        </div>
        <Confirm isOpen={confirmDiscard} onOpenChange={setConfirmDiscard} danger title={l.discardDraft} confirmLabel={l.discardDraft} onConfirm={() => discard.mutate()}
          body={l.discardBody} />
        {dirty && <div className="mt-3"><Callout tone="warn">{l.dirtyWarn}</Callout></div>}
        {!dirty && pending && <div className="mt-3"><Callout>{l.pendingInfo}</Callout></div>}
      </Card>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'struct', label: l.structured }, { id: 'json', label: 'JSON' }]} />
      {tab === 'json' || !cfg ? (
        <Card>
          {!cfg && <div className="mb-3"><Callout tone="bad">{l.badJson}</Callout></div>}
          <textarea aria-label={l.jsonLabel} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)}
            className="h-[560px] w-full resize-y rounded-[10px] border bg-base p-3 font-mono text-[12.5px] leading-5 outline-none focus:border-accent" />
        </Card>
      ) : (
        <Structured cfg={cfg} update={update} />
      )}
      {(
        <ModalDialog wide isOpen={diff} onOpenChange={setDiff} title={l.publishX(t.name)}
          footer={<><Button onPress={() => setDiff(false)}>{l.cancel}</Button><Button variant="primary" isPending={apply.isPending} onPress={() => apply.mutate()}>{l.publishTo(nodeNames.length)}</Button></>}>
          <p className="mb-3 text-[13px] text-subtle">{l.publishNote}</p>
          <DiffView a={t.json} b={t.draft} />
        </ModalDialog>
      )}
    </div>
  )
}

function DiffView({ a, b }: { a: string; b: string }) {
  const lines = useMemo(() => compact(lineDiff(a, b)), [a, b])
  return (
    <pre className="max-h-[56vh] overflow-auto rounded-[10px] border bg-base py-2 font-mono text-[12px] leading-5">
      {lines.map((l, i) => l === null
        ? <div key={i} className="px-3 text-muted">⋯</div>
        : <div key={i} className={cx('px-3 whitespace-pre-wrap', l.kind === '+' && 'bg-good/12 text-good', l.kind === '-' && 'bg-bad/12 text-bad')}>{l.kind}{' '}{l.text}</div>)}
    </pre>
  )
}

function Structured({ cfg, update }: { cfg: Obj; update: (fn: (c: Obj) => void) => void }) {
  const outbounds: Obj[] = cfg.outbounds ?? []
  const tags = outbounds.map((o) => o.tag).filter(Boolean)
  const l = useT(T)
  return (
    <div className="flex flex-col gap-4">
      <Card title={l.basics}>
        <div className="grid gap-4 sm:grid-cols-3">
          <Select label={l.finalOut} description="route.final" value={cfg.route?.final ?? ''} onChange={(v) => update((c) => { c.route = c.route ?? {}; c.route.final = v })}
            options={tags.map((t: string) => ({ id: t, label: t }))} />
          <Select label={l.logLevel} description="log.level" value={cfg.log?.level ?? 'warn'} onChange={(v) => update((c) => { c.log = { ...(c.log ?? {}), level: v } })}
            options={['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map((x) => ({ id: x, label: x }))} />
          <Select label={l.resolver} description="route.default_domain_resolver" value={typeof cfg.route?.default_domain_resolver === 'string' ? cfg.route.default_domain_resolver : ''}
            onChange={(v) => update((c) => { c.route = c.route ?? {}; c.route.default_domain_resolver = v })}
            options={(cfg.dns?.servers ?? []).map((s: Obj) => ({ id: s.tag, label: s.tag }))} />
        </div>
      </Card>
      <ItemList title={l.outbounds} noun={l.outbound} path={['outbounds']} items={outbounds} presets={outboundPresets} update={update}
        describe={(o) => `${o.type}${o.server ? ` → ${o.server}:${o.server_port ?? ''}` : ''}`} label={(o) => o.tag} />
      <ItemList title={l.rules} noun={l.rule} path={['route', 'rules']} items={cfg.route?.rules ?? []} presets={rulePresets} update={update}
        describe={describeRule} label={(r) => r.action === 'sniff' ? l.sniff : r.outbound ? `→ ${r.outbound}` : r.action ?? 'route'}
        locked={(r) => r.action === 'sniff'} />
      <ItemList title={l.ruleSets} noun={l.ruleSet} path={['route', 'rule_set']} items={cfg.route?.rule_set ?? []} presets={ruleSetPresets} update={update}
        describe={(r) => r.url ?? r.path ?? r.type} label={(r) => r.tag} />
      <ItemList title={l.dnsServers} noun={l.dnsServer} path={['dns', 'servers']} items={cfg.dns?.servers ?? []} presets={dnsPresets} update={update}
        describe={(s) => `${s.type}${s.server ? ' ' + s.server : ''}`} label={(s) => s.tag} />
    </div>
  )
}

function describeRule(r: Obj): string {
  const keys = Object.keys(r).filter((k) => !['action', 'outbound'].includes(k))
  return keys.map((k) => `${k}: ${Array.isArray(r[k]) ? r[k].slice(0, 3).join(', ') + (r[k].length > 3 ? ` +${r[k].length - 3}` : '') : String(r[k])}`).join('  ·  ') || tr(T).matchAll
}

function getPath(c: Obj, path: string[]): Obj[] {
  let o: any = c
  for (const p of path.slice(0, -1)) { o[p] = o[p] ?? {}; o = o[p] }
  const last = path[path.length - 1]
  o[last] = o[last] ?? []
  return o[last]
}

function ItemList({ title, noun, path, items, presets, update, describe, label, locked }: {
  title: string; noun: string; path: string[]; items: Obj[]; presets: Preset[]
  update: (fn: (c: Obj) => void) => void; describe: (o: Obj) => string; label: (o: Obj) => string; locked?: (o: Obj) => boolean
}) {
  const [edit, setEdit] = useState<{ i: number; text: string } | null>(null)
  const lastEdit = useSticky(edit)
  const [err, setErr] = useState('')
  const l = useT(T)
  const move = (i: number, d: number) => update((c) => { const a = getPath(c, path); const [x] = a.splice(i, 1); a.splice(i + d, 0, x) })
  const remove = (i: number) => update((c) => { getPath(c, path).splice(i, 1) })
  const commit = () => {
    if (!edit) return
    const v = parse(edit.text)
    if (!v || Array.isArray(v)) { setErr(l.needObject); return }
    update((c) => { const a = getPath(c, path); if (edit.i < 0) a.push(v); else a[edit.i] = v })
    setEdit(null)
  }
  return (
    <Card pad={false} title={`${title} (${items.length})`}
      action={
        <select aria-label={l.addX(noun)} value="" onChange={(e) => {
          const p = e.target.value === '_blank' ? {} : presets[Number(e.target.value)]?.v
          if (p) { setErr(''); setEdit({ i: -1, text: JSON.stringify(p, null, 2) }) }
        }} className="h-7 cursor-pointer rounded-full border bg-base px-3 text-[13px] outline-none focus:border-accent">
          <option value="">{l.addMenu}</option>
          {presets.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
          <option value="_blank">{l.blank}</option>
        </select>
      }>
      {items.length === 0 ? <div className="px-5 pt-1 pb-4 text-[13px] text-muted">{l.empty}</div> : (
        <ul>
          {items.map((it, i) => (
            <li key={i} className="flex items-center gap-3 border-b px-5 py-2.5 text-[13px] last:border-0 hover:bg-hl-low">
              <span className="w-6 shrink-0 text-right text-xs text-muted tabular">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{label(it) || <span className="text-bad">{l.noTag}</span>}</div>
                <div className="truncate font-mono text-xs text-muted">{describe(it)}</div>
              </div>
              <div className="flex shrink-0">
                <IconButton label={l.moveUp} isDisabled={i === 0} onPress={() => move(i, -1)}><IconArrowUp size={15} /></IconButton>
                <IconButton label={l.moveDown} isDisabled={i === items.length - 1} onPress={() => move(i, 1)}><IconArrowDown size={15} /></IconButton>
                <IconButton label={l.edit} onPress={() => { setErr(''); setEdit({ i, text: JSON.stringify(it, null, 2) }) }}><IconEdit size={15} /></IconButton>
                <IconButton label={l.delete} isDisabled={locked?.(it)} onPress={() => remove(i)}><IconTrash size={15} /></IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      {(
        <ModalDialog wide isOpen={!!edit} onOpenChange={(v) => !v && setEdit(null)} title={(edit ?? lastEdit)?.i === -1 ? l.addX(noun) : l.editX(noun)}
          footer={<><Button onPress={() => setEdit(null)}>{l.cancel}</Button><Button variant="primary" onPress={commit}>{l.ok}</Button></>}>
          <textarea aria-label="JSON" spellCheck={false} value={(edit ?? lastEdit)?.text ?? ''} onChange={(e) => { if (edit) setEdit({ ...edit, text: e.target.value }); setErr('') }}
            className="h-[360px] w-full rounded-[10px] border bg-base p-3 font-mono text-[12.5px] leading-5 outline-none focus:border-accent" />
          {err && <div className="mt-2 text-[13px] text-bad">{err}</div>}
          <p className="mt-2 text-xs text-muted">{l.docs}</p>
        </ModalDialog>
      )}
    </Card>
  )
}
