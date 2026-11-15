import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Group, type User } from '../../lib/api'
import { useAction } from '../../lib/actions'
import { href, go, useRoute } from '../../lib/router'
import { compact, lineDiff } from '../../lib/diff'
import { dateTime } from '../../lib/fmt'
import {
  CLIENTS, CLIENT_LABEL, MATCHER_TYPES, groupNodes, kindLabel, matcherLabel, memberMatches, newId, ruleSetSummary,
  type Catalog, type ClientId, type GroupType, type HistoryItem, type Matcher, type MatcherType, type Member, type NodeName,
  type PGroup, type Preview, type Profile, type ProfileDetail, type ProfileMeta, type Rule, type RuleSet,
} from '../../lib/routing'
import {
  ActionMenu, Badge, Button, Callout, Card, Checkbox, Chip, Confirm, Empty, Field, IconButton, ModalDialog, Presence, Segmented, Select,
  Skeleton, Spinner, Switch, Tabs, cx, useSticky,
} from '../../ui/kit'
import { IconArrowDown, IconArrowUp, IconEdit, IconPlus, IconSearch, IconTrash, IconX } from '../../ui/icons'
import { tr, useT } from '../../i18n'
import { C } from '../../i18n/common'
import { R } from '../../i18n/routing'

type EditTab = 'rules' | 'groups' | 'clients' | 'preview' | 'history' | 'json'
const editTabs = (): { id: EditTab; label: string }[] => {
  const t = tr(R)
  return [
    { id: 'rules', label: t.tabRules }, { id: 'groups', label: t.tabGroups }, { id: 'clients', label: t.tabClients },
    { id: 'preview', label: t.tabPreview }, { id: 'history', label: t.tabHistory }, { id: 'json', label: t.tabJson },
  ]
}
const typeLabels = (): Record<GroupType, string> => {
  const t = tr(R)
  return { select: t.tSelect, 'url-test': t.tUrlTest, fallback: t.tFallback, 'load-balance': t.tLoadBalance }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Subscriptions → Routing profiles: generic routing profiles rendered per client (Clash, sing-box, Surge). */
export function RoutingTab() {
  const t = useT(R)
  const { params } = useRoute()
  const profiles = useQuery({ queryKey: ['routing-profiles'], queryFn: () => api<ProfileMeta[]>('/routing/profiles') })
  const catalog = useQuery({ queryKey: ['routing-catalog'], queryFn: () => api<Catalog>('/routing/catalog'), staleTime: 300_000 })
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => api<Group[]>('/groups') })
  const [creating, setCreating] = useState(false)
  const list = profiles.data ?? []
  const id = Number(params.get('profile')) || list.find((p) => p.is_default)?.id || list[0]?.id
  const cur = list.find((p) => p.id === id)
  const gname = new Map((groups.data ?? []).map((g) => [g.id, g.name]))
  if (profiles.isLoading || catalog.isLoading) return <Skeleton className="h-96" />
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[230px_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-2">
        <Callout>{t.intro}</Callout>
        <nav aria-label={t.navLabel} className="flex gap-1 overflow-x-auto lg:flex-col">
          {list.map((p) => (
            <a key={p.id} href={href('subscriptions', { tab: 'routing', profile: p.id })}
              className={cx('min-w-[170px] shrink-0 rounded-[10px] border px-3 py-2.5 text-sm outline-none transition-colors duration-(--dur-1) focus-visible:ring-2 focus-visible:ring-accent lg:min-w-0',
                p.id === id ? 'border-accent/50 bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface))]' : 'bg-surface hover:bg-overlay')}>
              <div className="flex items-center gap-1.5"><span className="truncate font-medium">{p.name}</span>
                {p.is_default && <Badge tone="accent">{t.default}</Badge>}{p.has_draft && <Badge tone="warn">{t.draft}</Badge>}</div>
              <div className="mt-0.5 truncate text-xs text-muted">
                <span className="font-mono">{p.slug}</span>
                {p.group_ids.length > 0 && ` · ${p.group_ids.map((g) => gname.get(g) ?? g).join(t.listSep)}`}
                {p.users > 0 && t.nUsers(p.users)}
                {!p.selectable && t.notSelectable}
              </div>
            </a>
          ))}
        </nav>
        <Button onPress={() => setCreating(true)}><IconPlus size={16} />{t.newProfile}</Button>
      </div>
      {cur && catalog.data ? <ProfileEditor key={cur.id} meta={cur} catalog={catalog.data} groupNames={cur.group_ids.map((g) => gname.get(g) ?? String(g))} />
        : <Card><Empty title={t.pickProfile} /></Card>}
      <Presence value={creating && catalog.data}>
        {(c, open) => <CreateProfile isOpen={open} catalog={c} profiles={list} onClose={() => setCreating(false)} />}
      </Presence>
    </div>
  )
}

function CreateProfile({ isOpen, catalog, profiles, onClose }: { isOpen: boolean; catalog: Catalog; profiles: ProfileMeta[]; onClose: () => void }) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [from, setFrom] = useState('preset:standard')
  const t = useT(R)
  const c = useT(C)
  const slugErr = slug && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug) ? t.slugErr : profiles.some((p) => p.slug === slug) ? t.slugTaken : ''
  const create = useAction({
    fn: () => api<{ id: number }>('/routing/profiles', {
      method: 'POST', body: { name, slug, ...(from.startsWith('preset:') ? { preset: from.slice(7) } : { from: Number(from.slice(5)) }) },
    }),
    success: t.created, invalidate: [['routing-profiles']],
    onSuccess: (r) => { onClose(); go('subscriptions', { tab: 'routing', profile: r.id }) },
  })
  return (
    <ModalDialog isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={t.newProfile} dirty={!!name || !!slug}
      footer={<><Button onPress={onClose}>{c.cancel}</Button><Button variant="primary" isPending={create.isPending} isDisabled={!name.trim() || !slug || !!slugErr} onPress={() => create.mutate()}>{c.create}</Button></>}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.name} value={name} onChange={setName} autoFocus placeholder={t.namePh} />
          <Field label={t.slugLabel} mono value={slug} onChange={(v) => setSlug(v.toLowerCase())} placeholder="game" isInvalid={!!slugErr} errorMessage={slugErr} />
        </div>
        <Select label={t.startFrom} value={from} onChange={setFrom} options={[
          ...catalog.presets.map((p) => ({ id: `preset:${p.slug}`, label: t.presetX(p.name) })),
          ...profiles.map((p) => ({ id: `copy:${p.id}`, label: t.copyX(p.name) })),
        ]} description={catalog.presets.find((p) => `preset:${p.slug}` === from)?.description} />
      </div>
    </ModalDialog>
  )
}

function ProfileEditor({ meta, catalog, groupNames }: { meta: ProfileMeta; catalog: Catalog; groupNames: string[] }) {
  const qc = useQueryClient()
  const t = useT(R)
  const c = useT(C)
  const detail = useQuery({ queryKey: ['routing-profile', meta.id], queryFn: () => api<ProfileDetail>(`/routing/profiles/${meta.id}`) })
  const nodes = useQuery({ queryKey: ['routing-nodes'], queryFn: () => api<NodeName[]>('/routing/nodes') })
  const [tab, setTab] = useState<EditTab>('rules')
  const [model, setModel] = useState<Profile | null>(null)
  const base = detail.data ? (detail.data.draft ?? detail.data.published) : null
  useEffect(() => { if (base) setModel(structuredClone(base)) }, [detail.dataUpdatedAt]) // eslint-disable-line react-hooks/exhaustive-deps
  const [info, setInfo] = useState({ name: meta.name, slug: meta.slug, description: meta.description })
  const [publishing, setPublishing] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const dirty = !!model && !!base && !same(model, base)
  const pending = !!detail.data?.draft
  const infoDirty = info.name !== meta.name || info.slug !== meta.slug || info.description !== meta.description
  const refresh = () => { qc.invalidateQueries({ queryKey: ['routing-profiles'] }); qc.invalidateQueries({ queryKey: ['routing-profile', meta.id] }); qc.invalidateQueries({ queryKey: ['routing-history', meta.id] }) }

  const saveInfo = useAction({
    fn: (body: Record<string, unknown>) => api(`/routing/profiles/${meta.id}`, { method: 'PATCH', body }),
    success: c.saved, onSuccess: refresh,
  })
  const saveDraft = useAction({
    fn: () => api(`/routing/profiles/${meta.id}/draft`, { method: 'PUT', body: { draft: model } }),
    success: t.draftSaved, onSuccess: refresh,
  })
  const discard = useAction({ fn: () => api(`/routing/profiles/${meta.id}/draft`, { method: 'DELETE' }), success: t.draftDiscarded, onSuccess: refresh })
  const del = useAction({
    fn: () => api(`/routing/profiles/${meta.id}`, { method: 'DELETE' }), success: t.deletedX(meta.name),
    onSuccess: () => { refresh(); go('subscriptions', { tab: 'routing' }) }, invalidate: [['groups'], ['users']],
  })
  const update = (fn: (p: Profile) => void) => setModel((m) => { if (!m) return m; const c = structuredClone(m); fn(c); return c })

  if (!model || !detail.data) return <Skeleton className="h-96" />
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field className="w-full sm:w-44" label={t.name} value={info.name} onChange={(v) => setInfo({ ...info, name: v })} />
          <Field className="w-full sm:w-36" label={t.slug} mono value={info.slug} onChange={(v) => setInfo({ ...info, slug: v.toLowerCase() })} />
          <Field className="min-w-0 flex-1 basis-56" label={t.desc} value={info.description} onChange={(v) => setInfo({ ...info, description: v })} />
          {infoDirty && <Button isPending={saveInfo.isPending} onPress={() => saveInfo.mutate(info)}>{t.saveInfo}</Button>}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
          <Switch isSelected={meta.selectable} onChange={(v) => saveInfo.mutate({ selectable: v })}>{t.selectable}</Switch>
          <span className="text-[13px] text-subtle">
            {meta.is_default ? t.isDefault : groupNames.length ? t.usedBy(groupNames.join(t.listSep)) : t.unassigned}
            {meta.users > 0 && t.nAssigned(meta.users)}
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            <ActionMenu label={t.moreActions} onAction={(k) => k === 'default' ? saveInfo.mutate({ is_default: true }) : setDeleting(true)} items={[
              { id: 'default', label: t.makeDefault, isDisabled: meta.is_default },
              'sep', { id: 'delete', label: t.deleteProfile, danger: true, isDisabled: meta.is_default, icon: <IconTrash size={14} /> },
            ]} />
            {pending && <Button onPress={() => setDiscarding(true)}>{t.discardDraft}</Button>}
            <Button isPending={saveDraft.isPending} isDisabled={!dirty} onPress={() => saveDraft.mutate()}>{t.saveDraft}</Button>
            <Button variant="primary" isDisabled={dirty || !pending} onPress={() => setPublishing(true)}>{t.reviewPublish}</Button>
          </div>
        </div>
        {dirty && <div className="mt-3"><Callout tone="warn">{t.dirtyWarn}</Callout></div>}
        {!dirty && pending && <div className="mt-3"><Callout>{t.pendingInfo}</Callout></div>}
      </Card>
      <Tabs value={tab} onChange={setTab} tabs={editTabs()} label={t.editorTabs} />
      <div key={tab} className="animate-content-in">
        {tab === 'rules' && <RulesTab p={model} update={update} catalog={catalog} />}
        {tab === 'groups' && <GroupsTab p={model} update={update} nodes={nodes.data ?? []} />}
        {tab === 'clients' && <ClientsTab id={meta.id} p={model} update={update} catalog={catalog} />}
        {tab === 'preview' && <PreviewTab id={meta.id} p={model} />}
        {tab === 'history' && <HistoryTab id={meta.id} published={detail.data.published} dirty={dirty} onRestored={refresh} />}
        {tab === 'json' && <JsonTab p={model} onChange={setModel} />}
      </div>
      <Presence value={publishing}>
        {(_, open) => <PublishDialog isOpen={open} meta={meta} p={model} onClose={() => setPublishing(false)} onDone={refresh} />}
      </Presence>
      <Confirm isOpen={discarding} onOpenChange={setDiscarding} danger title={t.discardDraft} confirmLabel={t.discardDraft} onConfirm={() => discard.mutate()}
        body={t.discardBody} />
      <Confirm isOpen={deleting} onOpenChange={setDeleting} danger title={t.deleteTitle} confirmLabel={c.delete} onConfirm={() => del.mutate()}
        body={t.deleteBody(<b className="text-text">{meta.name}</b>, <span className="font-mono">?profile={meta.slug}</span>)} />
    </div>
  )
}

// ---------------- rules ----------------

function targetOptions(p: Profile, withReject = true) {
  const t = tr(R)
  return [...p.groups.map((g) => ({ id: g.id, label: g.name })), { id: 'DIRECT', label: t.direct }, ...(withReject ? [{ id: 'REJECT', label: t.reject }] : [])]
}

function RulesTab({ p, update, catalog }: { p: Profile; update: (fn: (p: Profile) => void) => void; catalog: Catalog }) {
  const t = useT(R)
  const [picking, setPicking] = useState(false)
  const [editing, setEditing] = useState<{ rs: RuleSet; target: string; idx: number } | null>(null)
  const sets = new Map(p.rule_sets.map((r) => [r.id, r]))
  const move = (i: number, d: number) => update((c) => { const [x] = c.rules.splice(i, 1); c.rules.splice(i + d, 0, x) })
  const remove = (i: number) => update((c) => {
    const [r] = c.rules.splice(i, 1)
    if (!c.rules.some((x) => x.rule_set === r.rule_set)) {
      c.rule_sets = c.rule_sets.filter((s) => s.id !== r.rule_set)
      c.dns.direct_sets = (c.dns.direct_sets ?? []).filter((x) => x !== r.rule_set)
    }
  })
  const setRule = (i: number, patch: Partial<Rule>) => update((c) => { c.rules[i] = { ...c.rules[i], ...patch } })
  const hasIP = (rs?: RuleSet) => !!rs && (!!rs.inline?.some((m) => m.type === 'ip_cidr' || m.type === 'geoip') || !!(rs.remote?.catalog && catalog.catalog.find((c) => c.key === rs.remote!.catalog)?.geoip) || rs.remote?.behavior === 'ipcidr')
  return (
    <div className="flex flex-col gap-4">
      <Card pad={false} title={t.rulesTitle(p.rules.length)}
        action={<div className="flex gap-2">
          <Button size="sm" onPress={() => setEditing({ rs: { id: newId('custom', p.rule_sets.map((r) => r.id)), name: '', inline: [{ type: 'domain_suffix', values: [] }] }, target: p.groups[0]?.id ?? 'DIRECT', idx: -1 })}>
            <IconEdit size={14} />{t.customRs}</Button>
          <Button size="sm" variant="primary" onPress={() => setPicking(true)}><IconPlus size={14} />{t.addFromCat}</Button>
        </div>}>
        {p.rules.length === 0 && <div className="px-5 pt-1 pb-4 text-[13px] text-muted">{t.noRules}</div>}
        <ul>
          {p.rules.map((r, i) => {
            const rs = sets.get(r.rule_set)
            return (
              <li key={r.rule_set + i} className={cx('flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5 text-[13px] hover:bg-hl-low sm:px-5', r.disabled && 'opacity-55')}>
                <span className="w-5 shrink-0 text-right text-xs text-muted tabular">{i + 1}</span>
                <div className="min-w-0 flex-1 basis-40">
                  <div className="truncate font-medium">{rs?.name || r.rule_set}</div>
                  <div className="truncate font-mono text-xs text-muted">{ruleSetSummary(rs, catalog.catalog)}</div>
                </div>
                <Select hideLabel label={t.target} className="w-40" value={r.target} onChange={(v) => setRule(i, { target: v })} options={targetOptions(p)} />
                <div className="w-[96px] shrink-0">
                  {hasIP(rs) && <Checkbox isSelected={!!r.resolve_ip} onChange={(v) => setRule(i, { resolve_ip: v })}>
                    <span className="text-xs" title={t.resolveIpTip}>{t.resolveIp}</span></Checkbox>}
                </div>
                <div className="flex shrink-0 items-center">
                  <Switch label={t.enable} isSelected={!r.disabled} onChange={(v) => setRule(i, { disabled: !v })} />
                  <IconButton label={t.moveUp} isDisabled={i === 0} onPress={() => move(i, -1)}><IconArrowUp size={15} /></IconButton>
                  <IconButton label={t.moveDown} isDisabled={i === p.rules.length - 1} onPress={() => move(i, 1)}><IconArrowDown size={15} /></IconButton>
                  <IconButton label={t.editRs} isDisabled={!rs} onPress={() => rs && setEditing({ rs: structuredClone(rs), target: r.target, idx: i })}><IconEdit size={15} /></IconButton>
                  <IconButton label={t.deleteRule} onPress={() => remove(i)}><IconTrash size={15} /></IconButton>
                </div>
              </li>
            )
          })}
          <li className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px] sm:px-5">
            <span className="w-5 shrink-0 text-right text-xs text-muted">∞</span>
            <div className="min-w-0 flex-1 basis-40"><div className="font-medium">{t.fallback}</div><div className="text-xs text-muted">{t.fallbackHint}</div></div>
            <Select hideLabel label={t.fallbackTarget} className="w-40" value={p.final} onChange={(v) => update((c) => { c.final = v })} options={targetOptions(p, false)} />
            <div aria-hidden className="hidden w-[284px] shrink-0 sm:block" />
          </li>
        </ul>
      </Card>
      <DnsCard p={p} update={update} />
      <Card title={t.ruleDownload}>
        <Field label={t.mirror} mono value={p.mirror ?? ''} onChange={(v) => update((c) => { c.mirror = v || undefined })}
          placeholder={catalog.mirror || 'https://ghfast.top/'}
          description={t.mirrorDesc(catalog.mirror ? <span className="font-mono">{catalog.mirror}</span> : null)} />
      </Card>
      <Presence value={picking}>
        {(_, open) => <CatalogPicker isOpen={open} p={p} catalog={catalog} onClose={() => setPicking(false)} onAdd={(keys, target) => update((c) => {
          // insert before the broad catch-alls (global / cn) so specific categories win
          let at = c.rules.findIndex((r) => { const k = c.rule_sets.find((s) => s.id === r.rule_set)?.remote?.catalog; return k === 'global' || k === 'cn' })
          if (at < 0) at = c.rules.length
          for (const k of keys) {
            const item = catalog.catalog.find((x) => x.key === k)!
            let id = k
            if (!c.rule_sets.some((s) => s.id === id)) c.rule_sets.push({ id, name: item.label, remote: { catalog: k } })
            else if (c.rule_sets.find((s) => s.id === id)?.remote?.catalog !== k) { id = newId(k, c.rule_sets.map((s) => s.id)); c.rule_sets.push({ id, name: item.label, remote: { catalog: k } }) }
            c.rules.splice(at++, 0, { rule_set: id, target, ...(k === 'cn' ? { resolve_ip: true } : {}) })
          }
        })} />}
      </Presence>
      <Presence value={editing}>
        {(e, open) => <RuleSetDialog isOpen={open} init={e.rs} target={e.target} isNew={e.idx < 0} p={p} onClose={() => setEditing(null)}
          onSave={(rs, target) => update((c) => {
            const k = c.rule_sets.findIndex((s) => s.id === rs.id)
            if (k >= 0) c.rule_sets[k] = rs; else c.rule_sets.push(rs)
            if (e.idx >= 0) c.rules[e.idx].target = target
            else c.rules.splice(0, 0, { rule_set: rs.id, target })
          })} />}
      </Presence>
    </div>
  )
}

function DnsCard({ p, update }: { p: Profile; update: (fn: (p: Profile) => void) => void }) {
  const list = (v: string) => v.split(/[\s,]+/).filter(Boolean)
  const t = useT(R)
  return (
    <Card title="DNS">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-subtle">{t.mode}</span>
          <Segmented label={t.dnsMode} value={p.dns.mode === 'real-ip' ? 'real-ip' : 'fake-ip'} onChange={(v) => update((c) => { c.dns.mode = v })}
            options={[{ id: 'fake-ip', label: t.fakeIp }, { id: 'real-ip', label: t.realIp }]} />
        </div>
        <Switch isSelected={p.dns.ipv6} onChange={(v) => update((c) => { c.dns.ipv6 = v })}>{t.ipv6}</Switch>
        <Field label={t.remoteDns} mono value={(p.dns.remote ?? []).join(', ')} onChange={(v) => update((c) => { c.dns.remote = list(v) })} placeholder="https://1.1.1.1/dns-query" />
        <Field label={t.domesticDns} mono value={(p.dns.domestic ?? []).join(', ')} onChange={(v) => update((c) => { c.dns.domestic = list(v) })} placeholder="https://223.5.5.5/dns-query" />
      </div>
      <div className="mt-4">
        <div className="mb-2 text-[13px] font-medium text-subtle">{t.directSets}</div>
        <div className="flex flex-wrap gap-1.5">
          {p.rule_sets.filter((r) => r.remote?.catalog).map((r) => {
            const on = (p.dns.direct_sets ?? []).includes(r.id)
            return <Chip key={r.id} active={on} onPress={() => update((c) => { const s = c.dns.direct_sets ?? []; c.dns.direct_sets = on ? s.filter((x) => x !== r.id) : [...s, r.id] })}>{r.name}</Chip>
          })}
        </div>
      </div>
    </Card>
  )
}

function CatalogPicker({ isOpen, p, catalog, onClose, onAdd }: { isOpen: boolean; p: Profile; catalog: Catalog; onClose: () => void; onAdd: (keys: string[], target: string) => void }) {
  const t = useT(R)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string[]>([])
  const [target, setTarget] = useState(p.groups.find((g) => g.id === 'proxy')?.id ?? p.groups[0]?.id ?? 'DIRECT')
  const used = new Set(p.rule_sets.map((r) => r.remote?.catalog).filter(Boolean))
  const s = q.trim().toLowerCase()
  const items = catalog.catalog.filter((c) => !s || [c.key, c.label, c.geosite, kindLabel(c.kind)].some((x) => x?.toLowerCase().includes(s)))
  const kinds = [...new Set(items.map((c) => c.kind))]
  return (
    <ModalDialog wide isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={t.pickerTitle}
      footer={<>
        <Select hideLabel label={t.target} className="mr-auto w-44" value={target} onChange={setTarget} options={targetOptions(p)} />
        <Button onPress={onClose}>{t.cancel}</Button>
        <Button variant="primary" isDisabled={!sel.length} onPress={() => { onAdd(sel, target); onClose() }}>{sel.length ? t.addN(sel.length) : t.addRules}</Button>
      </>}>
      <div className="relative mb-4">
        <IconSearch size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
        <input autoFocus aria-label={t.searchCat} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.searchCatPh}
          className="h-9 w-full rounded-[10px] border border-border-strong bg-base pr-3 pl-8 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/25" />
      </div>
      <div className="flex max-h-[52vh] flex-col gap-4 overflow-y-auto">
        {kinds.map((k) => (
          <div key={k}>
            <div className="mb-2 text-xs font-semibold text-subtle">{kindLabel(k) ?? k}</div>
            <div className="flex flex-wrap gap-1.5">
              {items.filter((c) => c.kind === k).map((c) => (
                <Chip key={c.key} active={sel.includes(c.key)} onPress={() => setSel(sel.includes(c.key) ? sel.filter((x) => x !== c.key) : [...sel, c.key])}>
                  {c.label}{used.has(c.key) && <span className="text-[11px] opacity-70">{t.already}</span>}
                </Chip>
              ))}
            </div>
          </div>
        ))}
        {items.length === 0 && <Empty title={t.noMatch} hint={t.noMatchHint} />}
      </div>
      <p className="mt-4 text-xs text-muted">{t.ruleData}</p>
    </ModalDialog>
  )
}

function RuleSetDialog({ isOpen, init, target: t0, isNew, p, onClose, onSave }: {
  isOpen: boolean; init: RuleSet; target: string; isNew: boolean; p: Profile; onClose: () => void; onSave: (rs: RuleSet, target: string) => void
}) {
  const t = useT(R)
  const [rs, setRs] = useState<RuleSet>(init)
  const [target, setTarget] = useState(t0)
  const [mode, setMode] = useState<'inline' | 'remote'>(init.remote && !init.inline?.length ? 'remote' : 'inline')
  const [texts, setTexts] = useState(() => (init.inline ?? []).map((m) => m.values.join('\n')))
  const catalogKey = init.remote?.catalog
  const total = texts.reduce((a, t) => a + t.split('\n').filter((x) => x.trim()).length, 0)
  const bad = texts.some((t) => /[,"]/.test(t))
  const build = (): RuleSet => {
    const out: RuleSet = { id: rs.id, name: rs.name.trim() || rs.id }
    const inline: Matcher[] = (rs.inline ?? []).map((m, i) => ({ ...m, values: texts[i].split('\n').map((x) => x.trim()).filter(Boolean) })).filter((m) => m.values.length)
    if (mode === 'inline' || catalogKey) { if (inline.length) out.inline = inline }
    if (mode === 'remote' || catalogKey) out.remote = rs.remote ?? { behavior: 'domain', urls: {} }
    return out
  }
  const urls = rs.remote?.urls ?? {}
  const urlErr = Object.values(urls).some((u) => u && !/^https?:\/\//.test(u))
  const empty = mode === 'inline' ? total === 0 && !catalogKey : !catalogKey && !Object.values(urls).some(Boolean)
  return (
    <ModalDialog wide isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={isNew ? t.customRs : t.editRsX(init.name)} dirty={!same(build(), init) || target !== t0}
      footer={<><Button onPress={onClose}>{t.cancel}</Button><Button variant="primary" isDisabled={empty || bad || urlErr} onPress={() => { onSave(build(), target); onClose() }}>{t.ok}</Button></>}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
          <Field label={t.name} value={rs.name} onChange={(v) => setRs({ ...rs, name: v })} autoFocus={isNew} placeholder={t.rsNamePh} />
          <Select label={t.target} value={target} onChange={setTarget} options={targetOptions(p)} />
        </div>
        {catalogKey ? <Callout>{t.fromCat(<span className="font-mono">{catalogKey}</span>)}</Callout>
          : <Segmented label={t.source} value={mode} onChange={setMode} options={[{ id: 'inline', label: t.manual }, { id: 'remote', label: t.remoteUrl }]} />}
        {(mode === 'inline' || catalogKey) && (
          <div className="flex flex-col gap-3">
            {(rs.inline ?? []).map((m, i) => (
              <div key={i} className="rounded-[12px] border bg-base p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Select hideLabel label={t.matchType} className="w-44" value={m.type} onChange={(v) => setRs({ ...rs, inline: rs.inline!.map((x, j) => j === i ? { ...x, type: v as MatcherType } : x) })}
                    options={MATCHER_TYPES.map((k) => ({ id: k, label: matcherLabel(k) }))} />
                  {(m.type === 'ip_cidr' || m.type === 'geoip') && <Checkbox isSelected={!!m.no_resolve} onChange={(v) => setRs({ ...rs, inline: rs.inline!.map((x, j) => j === i ? { ...x, no_resolve: v } : x) })}>
                    <span className="text-xs">no-resolve</span></Checkbox>}
                  <Badge>{t.nEntries(texts[i].split('\n').filter((x) => x.trim()).length)}</Badge>
                  <IconButton className="ml-auto" label={t.removeBlock} onPress={() => { setRs({ ...rs, inline: rs.inline!.filter((_, j) => j !== i) }); setTexts(texts.filter((_, j) => j !== i)) }}><IconTrash size={15} /></IconButton>
                </div>
                <textarea aria-label={matcherLabel(m.type)} spellCheck={false} rows={5} value={texts[i]} onChange={(e) => setTexts(texts.map((x, j) => j === i ? e.target.value : x))}
                  placeholder={m.type === 'ip_cidr' ? '10.0.0.0/8\n2001:db8::/32' : m.type === 'domain_suffix' ? 'example.com\ncorp.example.org' : t.onePerLine}
                  className="w-full resize-y rounded-[10px] border bg-surface p-2.5 font-mono text-[12.5px] leading-5 outline-none focus:border-accent" />
              </div>
            ))}
            <Button size="sm" className="self-start" onPress={() => { setRs({ ...rs, inline: [...(rs.inline ?? []), { type: 'domain_suffix', values: [] }] }); setTexts([...texts, '']) }}>
              <IconPlus size={14} />{t.addBlock}</Button>
            {bad && <Callout tone="bad">{t.noComma}</Callout>}
            {total > 64 && <Callout>{t.inlineMany(total)}</Callout>}
          </div>
        )}
        {mode === 'remote' && !catalogKey && (
          <div className="flex flex-col gap-3">
            <Select label={t.ruleType} value={rs.remote?.behavior ?? 'domain'} onChange={(v) => setRs({ ...rs, remote: { ...(rs.remote ?? {}), behavior: v } })}
              options={[{ id: 'domain', label: t.bDomain }, { id: 'ipcidr', label: t.bIp }, { id: 'classical', label: t.bClassical }]} />
            {CLIENTS.map((c) => (
              <Field key={c} label={t.urlFor(CLIENT_LABEL[c])} mono value={urls[c] ?? ''} placeholder={{ mihomo: t.mihomoPh, singbox: 'https://…/x.srs', surge: 'https://…/x.list' }[c]}
                onChange={(v) => setRs({ ...rs, remote: { ...(rs.remote ?? {}), urls: { ...urls, [c]: v || undefined } } })}
                isInvalid={!!urls[c] && !/^https?:\/\//.test(urls[c]!)} errorMessage={t.httpOnly} />
            ))}
            <p className="text-xs text-muted">{t.skipHint}</p>
          </div>
        )}
      </div>
    </ModalDialog>
  )
}

// ---------------- groups ----------------

function memberLabel(m: Member, p: Profile) {
  const t = tr(R)
  switch (m.kind) {
    case 'all': return m.exclude ? t.allExcept(m.exclude) : t.allNodes
    case 'filter': return t.filterX(m.include || '…')
    case 'group': return p.groups.find((g) => g.id === m.ref)?.name ?? t.missingX(m.ref ?? '')
    case 'direct': return 'DIRECT'
    case 'reject': return 'REJECT'
  }
}

function GroupsTab({ p, update, nodes }: { p: Profile; update: (fn: (p: Profile) => void) => void; nodes: NodeName[] }) {
  const refs = (id: string) => p.groups.filter((g) => g.members.some((m) => m.kind === 'group' && m.ref === id)).length + p.rules.filter((r) => r.target === id).length + (p.final === id ? 1 : 0)
  const [removing, setRemoving] = useState<PGroup | null>(null)
  const rm = useSticky(removing)
  const t = useT(R)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-subtle">{t.groupsIntro(nodes.length)}</p>
        <Button variant="primary" onPress={() => update((c) => { c.groups.push({ id: newId('g', c.groups.map((g) => g.id)), name: t.newGroupX(c.groups.length + 1), type: 'select', members: [{ kind: 'all' }] }) })}>
          <IconPlus size={16} />{t.addGroup}</Button>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 xl:grid-cols-2">
        {p.groups.map((g, gi) => <GroupCard key={g.id} g={g} gi={gi} p={p} nodes={nodes} update={update} onRemove={() => refs(g.id) ? setRemoving(g) : update((c) => { c.groups.splice(gi, 1) })} />)}
      </div>
      <Confirm isOpen={!!removing} onOpenChange={(v) => !v && setRemoving(null)} danger title={t.deleteGroup} confirmLabel={t.delete}
        body={t.deleteGroupBody(<b className="text-text">{rm?.name}</b>, rm ? refs(rm.id) : 0)}
        onConfirm={() => rm && update((c) => {
          c.groups = c.groups.filter((x) => x.id !== rm.id)
          for (const g of c.groups) g.members = g.members.filter((m) => !(m.kind === 'group' && m.ref === rm.id))
          for (const r of c.rules) if (r.target === rm.id) r.target = 'DIRECT'
          if (c.final === rm.id) c.final = c.groups[0]?.id ?? 'DIRECT'
        })} />
    </div>
  )
}

function GroupCard({ g, gi, p, nodes, update, onRemove }: { g: PGroup; gi: number; p: Profile; nodes: NodeName[]; update: (fn: (p: Profile) => void) => void; onRemove: () => void }) {
  const set = (patch: Partial<PGroup>) => update((c) => { c.groups[gi] = { ...c.groups[gi], ...patch } })
  const setMember = (mi: number, patch: Partial<Member>) => update((c) => { c.groups[gi].members[mi] = { ...c.groups[gi].members[mi], ...patch } })
  const count = useMemo(() => groupNodes(p, g.id, nodes).size, [p, g.id, nodes])
  const t = useT(R)
  const TYPE_LABEL = typeLabels()
  const addOpts = [
    { id: 'all', label: t.allNodes }, { id: 'filter', label: t.filterRe }, { id: 'direct', label: t.directM }, { id: 'reject', label: t.rejectM },
    ...p.groups.filter((x) => x.id !== g.id && !g.members.some((m) => m.kind === 'group' && m.ref === x.id)).map((x) => ({ id: 'group:' + x.id, label: t.groupX(x.name) })),
  ]
  return (
    <section className="rounded-[16px] border bg-surface p-4">
      <div className="flex flex-wrap items-end gap-2">
        <Field className="min-w-0 flex-1 basis-40" label={t.groupName} value={g.name} onChange={(v) => set({ name: v })} />
        <Select className="w-40" label={t.type} value={g.type} onChange={(v) => set({ type: v })} options={(Object.keys(TYPE_LABEL) as GroupType[]).map((k) => ({ id: k, label: TYPE_LABEL[k] }))} />
        <div className="flex">
          <IconButton label={t.moveUp} isDisabled={gi === 0} onPress={() => update((c) => { const [x] = c.groups.splice(gi, 1); c.groups.splice(gi - 1, 0, x) })}><IconArrowUp size={15} /></IconButton>
          <IconButton label={t.moveDown} isDisabled={gi === p.groups.length - 1} onPress={() => update((c) => { const [x] = c.groups.splice(gi, 1); c.groups.splice(gi + 1, 0, x) })}><IconArrowDown size={15} /></IconButton>
          <IconButton label={t.deleteGroup} onPress={onRemove}><IconTrash size={15} /></IconButton>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <Badge tone={count ? 'good' : 'warn'} dot>{t.nNodes(count)}</Badge>
        <Switch isSelected={!!g.hide_if_empty} onChange={(v) => set({ hide_if_empty: v })}>{t.hideEmpty}</Switch>
        <span className="font-mono text-xs text-muted">id: {g.id}</span>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {g.members.map((m, mi) => {
          const n = m.kind === 'all' || m.kind === 'filter' ? memberMatches(m, nodes) : null
          return (
            <div key={mi} className="rounded-[10px] bg-overlay/60 px-2.5 py-1.5">
              <div className="flex items-center gap-2 text-[13px]">
                {mi === 0 && <Badge tone="accent">{t.default}</Badge>}
                <span className="min-w-0 flex-1 truncate">{memberLabel(m, p)}</span>
                {n && <span className="shrink-0 text-xs text-muted tabular" title={n.map((x) => x.remark).join('\n')}>{t.matchedN(n.length)}</span>}
                <IconButton label={t.moveEarlier} isDisabled={mi === 0} onPress={() => update((c) => { const ms = c.groups[gi].members; [ms[mi - 1], ms[mi]] = [ms[mi], ms[mi - 1]] })}><IconArrowUp size={14} /></IconButton>
                <IconButton label={t.removeMember} onPress={() => update((c) => { c.groups[gi].members.splice(mi, 1) })}><IconX size={14} /></IconButton>
              </div>
              {(m.kind === 'filter' || (m.kind === 'all' && !!m.exclude)) && (
                <div className="mt-1.5 grid gap-2 pb-1 sm:grid-cols-2">
                  {m.kind === 'filter' && <Field hideLabel label={t.include} mono value={m.include ?? ''} onChange={(v) => setMember(mi, { include: v })} placeholder={t.includePh}
                    isInvalid={!!m.include && !validRe(m.include)} errorMessage={t.badRe} />}
                  <Field hideLabel label={t.exclude} mono value={m.exclude ?? ''} onChange={(v) => setMember(mi, { exclude: v || undefined })} placeholder={t.excludePh}
                    isInvalid={!!m.exclude && !validRe(m.exclude)} errorMessage={t.badRe} />
                </div>
              )}
            </div>
          )
        })}
        <Select hideLabel label={t.addMember} placeholder={t.addMemberPh} className="w-52" value={'' as string} options={addOpts}
          onChange={(v) => update((c) => { c.groups[gi].members.push(v.startsWith('group:') ? { kind: 'group', ref: v.slice(6) } : { kind: v as Member['kind'], ...(v === 'filter' ? { include: '' } : {}) }) })} />
      </div>
      {g.type !== 'select' && (
        <div className="mt-3 grid grid-cols-[1fr_100px] gap-2">
          <Field label={t.testUrl} mono value={g.test_url ?? ''} onChange={(v) => set({ test_url: v || undefined })} placeholder="https://www.gstatic.com/generate_204" />
          <Field label={t.interval} inputMode="numeric" value={g.interval ? String(g.interval) : ''} onChange={(v) => set({ interval: Number(v) || undefined })} placeholder="300" />
        </div>
      )}
    </section>
  )
}

function validRe(s: string) {
  try { new RegExp(s.replace(/^\(\?[imsU]+\)/, ''), 'u'); return true } catch { return false }
}

// ---------------- client templates ----------------

/** Live render with unsaved editor state; debounced. */
function usePreview(id: number, client: ClientId, userId: number, p: Profile | null) {
  const [state, setState] = useState<{ data?: Preview; loading: boolean }>({ loading: true })
  const key = JSON.stringify([client, userId, p])
  useEffect(() => {
    let live = true
    setState((s) => ({ ...s, loading: true }))
    const t = setTimeout(() => {
      api<Preview>(`/routing/profiles/${id}/preview`, { method: 'POST', body: { client, user_id: userId, draft: p } })
        .then((d) => live && setState({ data: d, loading: false }))
        .catch((e) => live && setState({ data: { body: '', warnings: [], error: (e as Error).message, published_body: '', nodes: 0 }, loading: false }))
    }, 350)
    return () => { live = false; clearTimeout(t) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}

function ClientsTab({ id, p, update, catalog }: { id: number; p: Profile; update: (fn: (p: Profile) => void) => void; catalog: Catalog }) {
  const t = useT(R)
  const [client, setClient] = useState<ClientId>('mihomo')
  const ct = p.clients[client] ?? { enabled: false, base: catalog.bases[client], options: {} }
  const ref = useRef<HTMLTextAreaElement>(null)
  const pv = usePreview(id, client, 0, p)
  const setCT = (patch: Partial<typeof ct>) => update((c) => { c.clients[client] = { ...ct, ...patch } })
  const defaults = catalog.default_options[client] ?? {}
  const opts = { ...(ct.options ?? {}) }
  const keys = [...new Set([...Object.keys(defaults), ...Object.keys(opts)])]
  const insert = (s: string) => {
    const el = ref.current
    if (!el) return
    const a = el.selectionStart, b = el.selectionEnd
    const v = ct.base.slice(0, a) + s + ct.base.slice(b)
    setCT({ base: v })
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + s.length, a + s.length) })
  }
  const req = new Set(catalog.required[client])
  const missing = catalog.required[client].filter((r) => !new RegExp(`\\{\\{\\s*${r}\\s*\\}\\}`).test(ct.base))
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented label={t.client} value={client} onChange={setClient} options={CLIENTS.map((c) => ({ id: c, label: CLIENT_LABEL[c] }))} />
        <Switch isSelected={ct.enabled} onChange={(v) => setCT({ enabled: v })}>{t.genConfig}</Switch>
        <Button size="sm" variant="ghost" className="ml-auto" onPress={() => setCT({ base: catalog.bases[client] })}>{t.restoreBase}</Button>
      </div>
      {!ct.enabled && <Callout>{t.clientOff}</Callout>}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <Card pad={false} title={t.baseTpl} busy={pv.loading}
          action={pv.data && (pv.data.error ? <Badge tone="bad">{t.renderFail}</Badge> : <Badge tone="good" dot>{t.renderOk}</Badge>)}>
          <div className="px-4 pb-4 sm:px-5">
            <div className="mb-2 flex flex-wrap gap-1.5" aria-label={t.placeholders}>
              {catalog.placeholders[client].map((ph) => (
                <button key={ph} type="button" onClick={() => insert(`{{${ph}}}`)}
                  className={cx('rounded-full border px-2 py-0.5 font-mono text-[12px] outline-none transition-colors duration-(--dur-1) hover:bg-overlay focus-visible:ring-2 focus-visible:ring-accent',
                    req.has(ph) ? 'border-accent/50 text-accent' : 'text-subtle')}>{`{{${ph}}}`}</button>
              ))}
              {keys.map((k) => (
                <button key={k} type="button" onClick={() => insert(`{{opt.${k}}}`)}
                  className="rounded-full border border-dashed px-2 py-0.5 font-mono text-[12px] text-subtle outline-none hover:bg-overlay focus-visible:ring-2 focus-visible:ring-accent">{`{{opt.${k}}}`}</button>
              ))}
            </div>
            <textarea ref={ref} aria-label={t.baseTplX(CLIENT_LABEL[client])} spellCheck={false} value={ct.base} onChange={(e) => setCT({ base: e.target.value })}
              className="h-[440px] w-full resize-y rounded-[10px] border bg-base p-3 font-mono text-[12.5px] leading-5 outline-none focus:border-accent" />
            <div className="mt-2 flex flex-col gap-2">
              {missing.length > 0 && <Callout tone="bad">{t.missingPh(missing.map((m) => `{{${m}}}`).join(t.listSep))}</Callout>}
              {pv.data?.error && <Callout tone="bad">{pv.data.error}</Callout>}
              <p className="text-xs text-muted">{t.phHint}</p>
            </div>
          </div>
        </Card>
        <Card title={t.options}>
          <div className="flex flex-col gap-3">
            {keys.map((k) => (
              <Field key={k} label={k} mono value={opts[k] ?? ''} placeholder={defaults[k] ?? ''}
                onChange={(v) => { const o = { ...opts }; if (v) o[k] = v; else delete o[k]; setCT({ options: o }) }}
                isInvalid={!!opts[k] && !/^[A-Za-z0-9._:/\-[\]]*$/.test(opts[k])} errorMessage={t.optErr} />
            ))}
            <AddOption onAdd={(k) => setCT({ options: { ...opts, [k]: 'value' } })} taken={keys} />
          </div>
        </Card>
      </div>
    </div>
  )
}

function AddOption({ onAdd, taken }: { onAdd: (k: string) => void; taken: string[] }) {
  const t = useT(R)
  const [k, setK] = useState('')
  const ok = /^[a-z_][a-z0-9_]*$/.test(k) && !taken.includes(k)
  return (
    <div className="flex items-end gap-2">
      <Field className="flex-1" label={t.newOpt} mono value={k} onChange={setK} placeholder={t.newOptPh} />
      <Button isDisabled={!ok} onPress={() => { onAdd(k); setK('') }}>{t.add}</Button>
    </div>
  )
}

// ---------------- preview / publish ----------------

function DiffView({ a, b }: { a: string; b: string }) {
  const lines = useMemo(() => compact(lineDiff(a, b)), [a, b])
  if (a === b) return <div className="rounded-[10px] border bg-base px-3 py-6 text-center text-[13px] text-muted">{tr(R).sameAsPub}</div>
  return (
    <pre className="max-h-[56vh] overflow-auto rounded-[10px] border bg-base py-2 font-mono text-[12px] leading-5">
      {lines.map((l, i) => l === null
        ? <div key={i} className="px-3 text-muted">⋯</div>
        : <div key={i} className={cx('px-3 whitespace-pre-wrap [overflow-wrap:anywhere]', l.kind === '+' && 'bg-good/12 text-good', l.kind === '-' && 'bg-bad/12 text-bad')}>{l.kind} {l.text}</div>)}
    </pre>
  )
}

function Output({ pv, view }: { pv: { data?: Preview; loading: boolean }; view: 'body' | 'diff' }) {
  if (!pv.data) return <div className="flex h-40 items-center justify-center"><Spinner /></div>
  const d = pv.data
  return (
    <div className="flex flex-col gap-3">
      {d.error && <Callout tone="bad">{d.error}</Callout>}
      {d.warnings.length > 0 && (
        <details className="rounded-[10px] bg-warn/10 px-3 py-2 text-[13px] text-warn">
          <summary className="cursor-pointer">{tr(R).warnings(d.warnings.length)}</summary>
          <ul className="mt-1.5 list-disc pl-5">{d.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
      {view === 'diff' ? <DiffView a={d.published_body} b={d.body} /> : (
        <pre className={cx('max-h-[60vh] overflow-auto rounded-[10px] border bg-base p-3 font-mono text-[12px] leading-5 whitespace-pre transition-opacity duration-(--dur-2)', pv.loading && 'opacity-60')}>{d.body}</pre>
      )}
    </div>
  )
}

function PreviewTab({ id, p }: { id: number; p: Profile }) {
  const t = useT(R)
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<User[]>('/users') })
  const [client, setClient] = useState<ClientId>('mihomo')
  const [uid, setUid] = useState('0')
  const [view, setView] = useState<'body' | 'diff'>('body')
  const pv = usePreview(id, client, Number(uid), p)
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented label={t.client} value={client} onChange={setClient} options={CLIENTS.map((c) => ({ id: c, label: CLIENT_LABEL[c] }))} />
        <Select hideLabel label={t.sampleUser} className="w-48" value={uid} onChange={setUid}
          options={[{ id: '0', label: t.allNodesAny }, ...(users.data ?? []).map((u) => ({ id: String(u.id), label: t.userX(u.username) }))]} />
        <Segmented label={t.view} value={view} onChange={setView} options={[{ id: 'body', label: t.output }, { id: 'diff', label: t.vsPub }]} />
        {pv.data && <span className="text-xs text-muted">{t.nodesN(pv.data.nodes)}{pv.loading && t.updating}</span>}
      </div>
      <Output pv={pv} view={view} />
    </Card>
  )
}

function PublishDialog({ isOpen, meta, p, onClose, onDone }: { isOpen: boolean; meta: ProfileMeta; p: Profile; onClose: () => void; onDone: () => void }) {
  const t = useT(R)
  const [client, setClient] = useState<ClientId>('mihomo')
  const pv = usePreview(meta.id, client, 0, p)
  const enabled = CLIENTS.filter((c) => p.clients[c]?.enabled)
  const publish = useAction({
    fn: () => api<{ warnings?: Record<string, string[]> }>(`/routing/profiles/${meta.id}/publish`, { method: 'POST' }),
    success: t.published(meta.name), onSuccess: () => { onDone(); onClose() },
  })
  return (
    <ModalDialog wide isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={t.publishX(meta.name)}
      footer={<><Button onPress={onClose}>{t.cancel}</Button><Button variant="primary" isPending={publish.isPending} isDisabled={!!pv.data?.error} onPress={() => publish.mutate()}>{t.confirmPublish}</Button></>}>
      <p className="mb-3 text-[13px] text-subtle">
        {t.publishIntro(enabled.map((c) => CLIENT_LABEL[c]).join(t.listSep), meta.is_default)}
      </p>
      <div className="mb-3"><Segmented label={t.client} value={client} onChange={setClient} options={CLIENTS.map((c) => ({ id: c, label: CLIENT_LABEL[c] }))} /></div>
      <Output pv={pv} view="diff" />
    </ModalDialog>
  )
}

// ---------------- history / json ----------------

function HistoryTab({ id, published, dirty, onRestored }: { id: number; published: Profile; dirty: boolean; onRestored: () => void }) {
  const t = useT(R)
  const hist = useQuery({ queryKey: ['routing-history', id], queryFn: () => api<HistoryItem[]>(`/routing/profiles/${id}/history`) })
  const [viewing, setViewing] = useState<HistoryItem | null>(null)
  const [restoring, setRestoring] = useState<HistoryItem | null>(null)
  const v = useSticky(viewing)
  const r = useSticky(restoring)
  const restore = useAction({
    fn: (h: HistoryItem) => api(`/routing/profiles/${id}/history/${h.id}/restore`, { method: 'POST' }),
    success: t.restored, onSuccess: onRestored,
  })
  const pub = JSON.stringify(published, null, 2)
  return (
    <Card pad={false} title={t.historyTitle}>
      {hist.isLoading && <Skeleton className="m-5 h-24" />}
      <ul>
        {(hist.data ?? []).map((h, i) => {
          const isPub = same(h.json, published)
          return (
            <li key={h.id} className="flex flex-wrap items-center gap-3 border-b px-5 py-2.5 text-[13px] last:border-0">
              <span className="tabular">{dateTime(h.ts)}</span>
              <span className="text-subtle">{h.admin}</span>
              {isPub && <Badge tone="good">{t.current}</Badge>}
              {i === (hist.data?.length ?? 0) - 1 && <Badge>{t.first}</Badge>}
              <div className="ml-auto flex gap-2">
                <Button size="sm" variant="ghost" onPress={() => setViewing(h)}>{t.compare}</Button>
                <Button size="sm" isDisabled={isPub} onPress={() => setRestoring(h)}>{t.restoreDraft}</Button>
              </div>
            </li>
          )
        })}
      </ul>
      <ModalDialog wide isOpen={!!viewing} onOpenChange={(x) => !x && setViewing(null)} title={v ? t.diffTitle(dateTime(v.ts)) : ''}>
        {v && <DiffView a={pub} b={JSON.stringify(v.json, null, 2)} />}
      </ModalDialog>
      <Confirm isOpen={!!restoring} onOpenChange={(x) => !x && setRestoring(null)} title={t.restoreDraft} confirmLabel={t.restore}
        onConfirm={() => r && restore.mutate(r)} danger={dirty}
        body={t.restoreBody(r ? dateTime(r.ts) : '', dirty)} />
    </Card>
  )
}

function JsonTab({ p, onChange }: { p: Profile; onChange: (p: Profile) => void }) {
  const t = useT(R)
  const [text, setText] = useState(() => JSON.stringify(p, null, 2))
  const [err, setErr] = useState('')
  return (
    <Card>
      <p className="mb-3 text-[13px] text-subtle">{t.jsonIntro}</p>
      <textarea aria-label={t.jsonLabel} spellCheck={false} value={text}
        onChange={(e) => {
          setText(e.target.value)
          try {
            const v = JSON.parse(e.target.value)
            if (!v || typeof v !== 'object' || !Array.isArray(v.groups) || !Array.isArray(v.rules) || !Array.isArray(v.rule_sets)) throw new Error(t.jsonNeed)
            setErr(''); onChange(v)
          } catch (x) { setErr((x as Error).message) }
        }}
        className={cx('h-[560px] w-full resize-y rounded-[10px] border bg-base p-3 font-mono text-[12.5px] leading-5 outline-none focus:border-accent', err && 'border-bad')} />
      {err && <div className="mt-2"><Callout tone="bad">{err}</Callout></div>}
    </Card>
  )
}

