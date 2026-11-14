import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Group, type User } from '../../lib/api'
import { useAction } from '../../lib/actions'
import { href, go, useRoute } from '../../lib/router'
import { compact, lineDiff } from '../../lib/diff'
import { dateTime } from '../../lib/fmt'
import {
  CLIENTS, CLIENT_LABEL, KIND_LABEL, MATCHER_LABEL, groupNodes, memberMatches, newId, ruleSetSummary,
  type Catalog, type ClientId, type GroupType, type HistoryItem, type Matcher, type MatcherType, type Member, type NodeName,
  type PGroup, type Preview, type Profile, type ProfileDetail, type ProfileMeta, type Rule, type RuleSet,
} from '../../lib/routing'
import {
  ActionMenu, Badge, Button, Callout, Card, Checkbox, Chip, Confirm, Empty, Field, IconButton, ModalDialog, Presence, Segmented, Select,
  Skeleton, Spinner, Switch, Tabs, cx, useSticky,
} from '../../ui/kit'
import { IconArrowDown, IconArrowUp, IconEdit, IconPlus, IconSearch, IconTrash, IconX } from '../../ui/icons'

type EditTab = 'rules' | 'groups' | 'clients' | 'preview' | 'history' | 'json'
const EDIT_TABS: { id: EditTab; label: string }[] = [
  { id: 'rules', label: '规则' }, { id: 'groups', label: '策略组' }, { id: 'clients', label: '客户端模板' },
  { id: 'preview', label: '预览' }, { id: 'history', label: '历史' }, { id: 'json', label: '高级 JSON' },
]
const TYPE_LABEL: Record<GroupType, string> = { select: '手动选择', 'url-test': '自动测速', fallback: '故障转移', 'load-balance': '负载均衡' }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** 订阅 → 分流规则: generic routing profiles rendered per client (Clash, sing-box, Surge). */
export function RoutingTab() {
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
        <Callout>统一定义一次规则与策略组，按客户端自动生成 Clash / sing-box / Surge 配置；其他客户端（如 Shadowrocket）获取节点列表。</Callout>
        <nav aria-label="分流配置" className="flex gap-1 overflow-x-auto lg:flex-col">
          {list.map((p) => (
            <a key={p.id} href={href('subscriptions', { tab: 'routing', profile: p.id })}
              className={cx('min-w-[170px] shrink-0 rounded-[10px] border px-3 py-2.5 text-sm outline-none transition-colors duration-(--dur-1) focus-visible:ring-2 focus-visible:ring-accent lg:min-w-0',
                p.id === id ? 'border-accent/50 bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface))]' : 'bg-surface hover:bg-overlay')}>
              <div className="flex items-center gap-1.5"><span className="truncate font-medium">{p.name}</span>
                {p.is_default && <Badge tone="accent">默认</Badge>}{p.has_draft && <Badge tone="warn">草稿</Badge>}</div>
              <div className="mt-0.5 truncate text-xs text-muted">
                <span className="font-mono">{p.slug}</span>
                {p.group_ids.length > 0 && ` · ${p.group_ids.map((g) => gname.get(g) ?? g).join('、')}`}
                {p.users > 0 && ` · ${p.users} 用户`}
                {!p.selectable && ' · 不可自选'}
              </div>
            </a>
          ))}
        </nav>
        <Button onPress={() => setCreating(true)}><IconPlus size={16} />新建分流配置</Button>
      </div>
      {cur && catalog.data ? <ProfileEditor key={cur.id} meta={cur} catalog={catalog.data} groupNames={cur.group_ids.map((g) => gname.get(g) ?? String(g))} />
        : <Card><Empty title="选择一个分流配置" /></Card>}
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
  const slugErr = slug && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug) ? '小写字母、数字和 -，最长 32 位' : profiles.some((p) => p.slug === slug) ? '这个标识已存在' : ''
  const create = useAction({
    fn: () => api<{ id: number }>('/routing/profiles', {
      method: 'POST', body: { name, slug, ...(from.startsWith('preset:') ? { preset: from.slice(7) } : { from: Number(from.slice(5)) }) },
    }),
    success: '分流配置已创建', invalidate: [['routing-profiles']],
    onSuccess: (r) => { onClose(); go('subscriptions', { tab: 'routing', profile: r.id }) },
  })
  return (
    <ModalDialog isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title="新建分流配置" dirty={!!name || !!slug}
      footer={<><Button onPress={onClose}>取消</Button><Button variant="primary" isPending={create.isPending} isDisabled={!name.trim() || !slug || !!slugErr} onPress={() => create.mutate()}>创建</Button></>}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="名称" value={name} onChange={setName} autoFocus placeholder="例如：游戏加速" />
          <Field label="标识（订阅链接 ?profile=）" mono value={slug} onChange={(v) => setSlug(v.toLowerCase())} placeholder="game" isInvalid={!!slugErr} errorMessage={slugErr} />
        </div>
        <Select label="起点" value={from} onChange={setFrom} options={[
          ...catalog.presets.map((p) => ({ id: `preset:${p.slug}`, label: `预设 · ${p.name}` })),
          ...profiles.map((p) => ({ id: `copy:${p.id}`, label: `复制 · ${p.name}` })),
        ]} description={catalog.presets.find((p) => `preset:${p.slug}` === from)?.description} />
      </div>
    </ModalDialog>
  )
}

function ProfileEditor({ meta, catalog, groupNames }: { meta: ProfileMeta; catalog: Catalog; groupNames: string[] }) {
  const qc = useQueryClient()
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
    success: '已保存', onSuccess: refresh,
  })
  const saveDraft = useAction({
    fn: () => api(`/routing/profiles/${meta.id}/draft`, { method: 'PUT', body: { draft: model } }),
    success: '草稿已保存，订阅仍使用已发布版本', onSuccess: refresh,
  })
  const discard = useAction({ fn: () => api(`/routing/profiles/${meta.id}/draft`, { method: 'DELETE' }), success: '草稿已丢弃', onSuccess: refresh })
  const del = useAction({
    fn: () => api(`/routing/profiles/${meta.id}`, { method: 'DELETE' }), success: `已删除 ${meta.name}`,
    onSuccess: () => { refresh(); go('subscriptions', { tab: 'routing' }) }, invalidate: [['groups'], ['users']],
  })
  const update = (fn: (p: Profile) => void) => setModel((m) => { if (!m) return m; const c = structuredClone(m); fn(c); return c })

  if (!model || !detail.data) return <Skeleton className="h-96" />
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field className="w-full sm:w-44" label="名称" value={info.name} onChange={(v) => setInfo({ ...info, name: v })} />
          <Field className="w-full sm:w-36" label="标识" mono value={info.slug} onChange={(v) => setInfo({ ...info, slug: v.toLowerCase() })} />
          <Field className="min-w-0 flex-1 basis-56" label="说明（订阅页可见）" value={info.description} onChange={(v) => setInfo({ ...info, description: v })} />
          {infoDirty && <Button isPending={saveInfo.isPending} onPress={() => saveInfo.mutate(info)}>保存信息</Button>}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
          <Switch isSelected={meta.selectable} onChange={(v) => saveInfo.mutate({ selectable: v })}>允许用户在订阅页切换到此配置</Switch>
          <span className="text-[13px] text-subtle">
            {meta.is_default ? '默认配置：没有单独指定的用户都使用它' : groupNames.length ? `分组使用：${groupNames.join('、')}` : '未分配给分组'}
            {meta.users > 0 && ` · ${meta.users} 个用户单独指定`}
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            <ActionMenu label="更多操作" onAction={(k) => k === 'default' ? saveInfo.mutate({ is_default: true }) : setDeleting(true)} items={[
              { id: 'default', label: '设为默认配置', isDisabled: meta.is_default },
              'sep', { id: 'delete', label: '删除配置', danger: true, isDisabled: meta.is_default, icon: <IconTrash size={14} /> },
            ]} />
            {pending && <Button onPress={() => setDiscarding(true)}>丢弃草稿</Button>}
            <Button isPending={saveDraft.isPending} isDisabled={!dirty} onPress={() => saveDraft.mutate()}>保存草稿</Button>
            <Button variant="primary" isDisabled={dirty || !pending} onPress={() => setPublishing(true)}>预览差异并发布</Button>
          </div>
        </div>
        {dirty && <div className="mt-3"><Callout tone="warn">有未保存的修改。保存草稿后才能发布；「预览」页已按当前编辑内容实时生成。</Callout></div>}
        {!dirty && pending && <div className="mt-3"><Callout>草稿已保存但尚未发布，用户的订阅仍使用已发布版本。</Callout></div>}
      </Card>
      <Tabs value={tab} onChange={setTab} tabs={EDIT_TABS} label="分流配置编辑" />
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
      <Confirm isOpen={discarding} onOpenChange={setDiscarding} danger title="丢弃草稿" confirmLabel="丢弃草稿" onConfirm={() => discard.mutate()}
        body="草稿里尚未发布的修改会全部丢失，编辑器恢复为已发布版本。此操作不可撤销。" />
      <Confirm isOpen={deleting} onOpenChange={setDeleting} danger title="删除分流配置" confirmLabel="删除" onConfirm={() => del.mutate()}
        body={<>删除 <b className="text-text">{meta.name}</b>。使用它的分组和用户会改用默认配置，<span className="font-mono">?profile={meta.slug}</span> 的链接也会回到默认。此操作不可撤销。</>} />
    </div>
  )
}

// ---------------- rules ----------------

function targetOptions(p: Profile, withReject = true) {
  return [...p.groups.map((g) => ({ id: g.id, label: g.name })), { id: 'DIRECT', label: '直连 DIRECT' }, ...(withReject ? [{ id: 'REJECT', label: '拒绝 REJECT' }] : [])]
}

function RulesTab({ p, update, catalog }: { p: Profile; update: (fn: (p: Profile) => void) => void; catalog: Catalog }) {
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
      <Card pad={false} title={`路由规则（${p.rules.length}，从上到下匹配）`}
        action={<div className="flex gap-2">
          <Button size="sm" onPress={() => setEditing({ rs: { id: newId('custom', p.rule_sets.map((r) => r.id)), name: '', inline: [{ type: 'domain_suffix', values: [] }] }, target: p.groups[0]?.id ?? 'DIRECT', idx: -1 })}>
            <IconEdit size={14} />自定义规则集</Button>
          <Button size="sm" variant="primary" onPress={() => setPicking(true)}><IconPlus size={14} />从分类添加</Button>
        </div>}>
        {p.rules.length === 0 && <div className="px-5 pt-1 pb-4 text-[13px] text-muted">没有规则，全部流量走兜底</div>}
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
                <Select hideLabel label="目标" className="w-40" value={r.target} onChange={(v) => setRule(i, { target: v })} options={targetOptions(p)} />
                <div className="w-[76px] shrink-0">
                  {hasIP(rs) && <Checkbox isSelected={!!r.resolve_ip} onChange={(v) => setRule(i, { resolve_ip: v })}>
                    <span className="text-xs" title="匹配 IP 前先解析域名（mihomo 去掉 no-resolve，sing-box 插入 resolve）">解析 IP</span></Checkbox>}
                </div>
                <div className="flex shrink-0 items-center">
                  <Switch label="启用" isSelected={!r.disabled} onChange={(v) => setRule(i, { disabled: !v })} />
                  <IconButton label="上移" isDisabled={i === 0} onPress={() => move(i, -1)}><IconArrowUp size={15} /></IconButton>
                  <IconButton label="下移" isDisabled={i === p.rules.length - 1} onPress={() => move(i, 1)}><IconArrowDown size={15} /></IconButton>
                  <IconButton label="编辑规则集" isDisabled={!rs} onPress={() => rs && setEditing({ rs: structuredClone(rs), target: r.target, idx: i })}><IconEdit size={15} /></IconButton>
                  <IconButton label="删除规则" onPress={() => remove(i)}><IconTrash size={15} /></IconButton>
                </div>
              </li>
            )
          })}
          <li className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px] sm:px-5">
            <span className="w-5 shrink-0 text-right text-xs text-muted">∞</span>
            <div className="min-w-0 flex-1 basis-40"><div className="font-medium">兜底</div><div className="text-xs text-muted">以上都没匹配时（MATCH / FINAL / route.final）</div></div>
            <Select hideLabel label="兜底目标" className="w-40" value={p.final} onChange={(v) => update((c) => { c.final = v })} options={targetOptions(p, false)} />
            <div aria-hidden className="hidden w-[264px] shrink-0 sm:block" />
          </li>
        </ul>
      </Card>
      <DnsCard p={p} update={update} />
      <Card title="规则下载">
        <Field label="镜像前缀（可选）" mono value={p.mirror ?? ''} onChange={(v) => update((c) => { c.mirror = v || undefined })}
          placeholder={catalog.mirror || 'https://ghfast.top/'}
          description={<>加在 GitHub 规则地址前，方便无法直连 GitHub 的客户端下载规则。留空使用全局设置{catalog.mirror ? <>（当前 <span className="font-mono">{catalog.mirror}</span>）</> : '（未设置）'}。必须以 / 结尾。</>} />
      </Card>
      <Presence value={picking}>
        {(_, open) => <CatalogPicker isOpen={open} p={p} catalog={catalog} onClose={() => setPicking(false)} onAdd={(keys, target) => update((c) => {
          // insert before the broad catch-alls (海外/大陆) so specific categories win
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
  return (
    <Card title="DNS">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-subtle">模式</span>
          <Segmented label="DNS 模式" value={p.dns.mode === 'real-ip' ? 'real-ip' : 'fake-ip'} onChange={(v) => update((c) => { c.dns.mode = v })}
            options={[{ id: 'fake-ip', label: 'Fake-IP（推荐）' }, { id: 'real-ip', label: '真实 IP' }]} />
        </div>
        <Switch isSelected={p.dns.ipv6} onChange={(v) => update((c) => { c.dns.ipv6 = v })}>解析 IPv6</Switch>
        <Field label="代理 DNS（经代理查询）" mono value={(p.dns.remote ?? []).join(', ')} onChange={(v) => update((c) => { c.dns.remote = list(v) })} placeholder="https://1.1.1.1/dns-query" />
        <Field label="国内 DNS（直连域名使用）" mono value={(p.dns.domestic ?? []).join(', ')} onChange={(v) => update((c) => { c.dns.domestic = list(v) })} placeholder="https://223.5.5.5/dns-query" />
      </div>
      <div className="mt-4">
        <div className="mb-2 text-[13px] font-medium text-subtle">使用国内 DNS 的规则集</div>
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
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string[]>([])
  const [target, setTarget] = useState(p.groups.find((g) => g.id === 'proxy')?.id ?? p.groups[0]?.id ?? 'DIRECT')
  const used = new Set(p.rule_sets.map((r) => r.remote?.catalog).filter(Boolean))
  const s = q.trim().toLowerCase()
  const items = catalog.catalog.filter((c) => !s || [c.key, c.label, c.geosite, KIND_LABEL[c.kind]].some((x) => x?.toLowerCase().includes(s)))
  const kinds = [...new Set(items.map((c) => c.kind))]
  return (
    <ModalDialog wide isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title="从分类添加规则"
      footer={<>
        <Select hideLabel label="目标" className="mr-auto w-44" value={target} onChange={setTarget} options={targetOptions(p)} />
        <Button onPress={onClose}>取消</Button>
        <Button variant="primary" isDisabled={!sel.length} onPress={() => { onAdd(sel, target); onClose() }}>{sel.length ? `添加 ${sel.length} 条规则` : '添加规则'}</Button>
      </>}>
      <div className="relative mb-4">
        <IconSearch size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
        <input autoFocus aria-label="搜索分类" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索：netflix、AI、广告…"
          className="h-9 w-full rounded-[10px] border border-border-strong bg-base pr-3 pl-8 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/25" />
      </div>
      <div className="flex max-h-[52vh] flex-col gap-4 overflow-y-auto">
        {kinds.map((k) => (
          <div key={k}>
            <div className="mb-2 text-xs font-semibold text-subtle">{KIND_LABEL[k] ?? k}</div>
            <div className="flex flex-wrap gap-1.5">
              {items.filter((c) => c.kind === k).map((c) => (
                <Chip key={c.key} active={sel.includes(c.key)} onPress={() => setSel(sel.includes(c.key) ? sel.filter((x) => x !== c.key) : [...sel, c.key])}>
                  {c.label}{used.has(c.key) && <span className="text-[11px] opacity-70">已有</span>}
                </Chip>
              ))}
            </div>
          </div>
        ))}
        {items.length === 0 && <Empty title="没有匹配的分类" hint="可以用「自定义规则集」填写域名或远程地址" />}
      </div>
      <p className="mt-4 text-xs text-muted">规则数据：mihomo 用 MetaCubeX meta-rules-dat（.mrs），sing-box 用其 sing 分支（.srs），Surge 用 blackmatrix7 ios_rule_script（.list）。客户端自行下载并定期更新。</p>
    </ModalDialog>
  )
}

function RuleSetDialog({ isOpen, init, target: t0, isNew, p, onClose, onSave }: {
  isOpen: boolean; init: RuleSet; target: string; isNew: boolean; p: Profile; onClose: () => void; onSave: (rs: RuleSet, target: string) => void
}) {
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
    <ModalDialog wide isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={isNew ? '自定义规则集' : `编辑规则集 ${init.name}`} dirty={!same(build(), init) || target !== t0}
      footer={<><Button onPress={onClose}>取消</Button><Button variant="primary" isDisabled={empty || bad || urlErr} onPress={() => { onSave(build(), target); onClose() }}>确定</Button></>}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
          <Field label="名称" value={rs.name} onChange={(v) => setRs({ ...rs, name: v })} autoFocus={isNew} placeholder="例如：公司内网" />
          <Select label="目标" value={target} onChange={setTarget} options={targetOptions(p)} />
        </div>
        {catalogKey ? <Callout>来自分类 <span className="font-mono">{catalogKey}</span>，各客户端自动使用对应格式的远程规则。下面可以补充内联条目。</Callout>
          : <Segmented label="规则来源" value={mode} onChange={setMode} options={[{ id: 'inline', label: '手动填写' }, { id: 'remote', label: '远程地址' }]} />}
        {(mode === 'inline' || catalogKey) && (
          <div className="flex flex-col gap-3">
            {(rs.inline ?? []).map((m, i) => (
              <div key={i} className="rounded-[12px] border bg-base p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Select hideLabel label="匹配类型" className="w-44" value={m.type} onChange={(v) => setRs({ ...rs, inline: rs.inline!.map((x, j) => j === i ? { ...x, type: v as MatcherType } : x) })}
                    options={(Object.keys(MATCHER_LABEL) as MatcherType[]).map((k) => ({ id: k, label: MATCHER_LABEL[k] }))} />
                  {(m.type === 'ip_cidr' || m.type === 'geoip') && <Checkbox isSelected={!!m.no_resolve} onChange={(v) => setRs({ ...rs, inline: rs.inline!.map((x, j) => j === i ? { ...x, no_resolve: v } : x) })}>
                    <span className="text-xs">no-resolve</span></Checkbox>}
                  <Badge>{texts[i].split('\n').filter((x) => x.trim()).length} 条</Badge>
                  <IconButton className="ml-auto" label="删除这组" onPress={() => { setRs({ ...rs, inline: rs.inline!.filter((_, j) => j !== i) }); setTexts(texts.filter((_, j) => j !== i)) }}><IconTrash size={15} /></IconButton>
                </div>
                <textarea aria-label={MATCHER_LABEL[m.type]} spellCheck={false} rows={5} value={texts[i]} onChange={(e) => setTexts(texts.map((t, j) => j === i ? e.target.value : t))}
                  placeholder={m.type === 'ip_cidr' ? '10.0.0.0/8\n2001:db8::/32' : m.type === 'domain_suffix' ? 'example.com\ncorp.example.org' : '每行一个'}
                  className="w-full resize-y rounded-[10px] border bg-surface p-2.5 font-mono text-[12.5px] leading-5 outline-none focus:border-accent" />
              </div>
            ))}
            <Button size="sm" className="self-start" onPress={() => { setRs({ ...rs, inline: [...(rs.inline ?? []), { type: 'domain_suffix', values: [] }] }); setTexts([...texts, '']) }}>
              <IconPlus size={14} />添加一组匹配</Button>
            {bad && <Callout tone="bad">条目里不能包含逗号或双引号</Callout>}
            {total > 64 && <Callout>共 {total} 条，生成时会作为内联规则集下发（Clash 的 inline provider、sing-box 的 inline rule_set），保持配置可读。</Callout>}
          </div>
        )}
        {mode === 'remote' && !catalogKey && (
          <div className="flex flex-col gap-3">
            <Select label="规则类型" value={rs.remote?.behavior ?? 'domain'} onChange={(v) => setRs({ ...rs, remote: { ...(rs.remote ?? {}), behavior: v } })}
              options={[{ id: 'domain', label: '域名列表（domain）' }, { id: 'ipcidr', label: 'IP 列表（ipcidr）' }, { id: 'classical', label: '混合规则（classical）' }]} />
            {CLIENTS.map((c) => (
              <Field key={c} label={`${CLIENT_LABEL[c]} 地址`} mono value={urls[c] ?? ''} placeholder={{ mihomo: 'https://…/x.mrs 或 .yaml / .txt', singbox: 'https://…/x.srs', surge: 'https://…/x.list' }[c]}
                onChange={(v) => setRs({ ...rs, remote: { ...(rs.remote ?? {}), urls: { ...urls, [c]: v || undefined } } })}
                isInvalid={!!urls[c] && !/^https?:\/\//.test(urls[c]!)} errorMessage="只能是 http(s) 地址" />
            ))}
            <p className="text-xs text-muted">某个客户端留空时，该规则在它的配置里会被跳过（预览会提示）。</p>
          </div>
        )}
      </div>
    </ModalDialog>
  )
}

// ---------------- groups ----------------

function memberLabel(m: Member, p: Profile) {
  switch (m.kind) {
    case 'all': return m.exclude ? `全部节点（排除 ${m.exclude}）` : '全部节点'
    case 'filter': return `筛选 ${m.include || '…'}`
    case 'group': return p.groups.find((g) => g.id === m.ref)?.name ?? `（缺失 ${m.ref}）`
    case 'direct': return 'DIRECT'
    case 'reject': return 'REJECT'
  }
}

function GroupsTab({ p, update, nodes }: { p: Profile; update: (fn: (p: Profile) => void) => void; nodes: NodeName[] }) {
  const refs = (id: string) => p.groups.filter((g) => g.members.some((m) => m.kind === 'group' && m.ref === id)).length + p.rules.filter((r) => r.target === id).length + (p.final === id ? 1 : 0)
  const [removing, setRemoving] = useState<PGroup | null>(null)
  const rm = useSticky(removing)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-subtle">共 {nodes.length} 个节点（全部入站）。成员的第一项是默认选择；节点筛选按「节点备注 + 节点名」匹配正则。</p>
        <Button variant="primary" onPress={() => update((c) => { c.groups.push({ id: newId('g', c.groups.map((g) => g.id)), name: `新分组 ${c.groups.length + 1}`, type: 'select', members: [{ kind: 'all' }] }) })}>
          <IconPlus size={16} />添加策略组</Button>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 xl:grid-cols-2">
        {p.groups.map((g, gi) => <GroupCard key={g.id} g={g} gi={gi} p={p} nodes={nodes} update={update} onRemove={() => refs(g.id) ? setRemoving(g) : update((c) => { c.groups.splice(gi, 1) })} />)}
      </div>
      <Confirm isOpen={!!removing} onOpenChange={(v) => !v && setRemoving(null)} danger title="删除策略组" confirmLabel="删除"
        body={<><b className="text-text">{rm?.name}</b> 还被 {rm ? refs(rm.id) : 0} 处引用（其他分组的成员、规则目标或兜底）。删除后这些规则改为直连，分组成员中移除它。</>}
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
  const addOpts = [
    { id: 'all', label: '全部节点' }, { id: 'filter', label: '节点筛选（正则）' }, { id: 'direct', label: 'DIRECT 直连' }, { id: 'reject', label: 'REJECT 拒绝' },
    ...p.groups.filter((x) => x.id !== g.id && !g.members.some((m) => m.kind === 'group' && m.ref === x.id)).map((x) => ({ id: 'group:' + x.id, label: `分组 · ${x.name}` })),
  ]
  return (
    <section className="rounded-[16px] border bg-surface p-4">
      <div className="flex flex-wrap items-end gap-2">
        <Field className="min-w-0 flex-1 basis-40" label="名称（客户端里显示）" value={g.name} onChange={(v) => set({ name: v })} />
        <Select className="w-32" label="类型" value={g.type} onChange={(v) => set({ type: v })} options={(Object.keys(TYPE_LABEL) as GroupType[]).map((k) => ({ id: k, label: TYPE_LABEL[k] }))} />
        <div className="flex">
          <IconButton label="上移" isDisabled={gi === 0} onPress={() => update((c) => { const [x] = c.groups.splice(gi, 1); c.groups.splice(gi - 1, 0, x) })}><IconArrowUp size={15} /></IconButton>
          <IconButton label="下移" isDisabled={gi === p.groups.length - 1} onPress={() => update((c) => { const [x] = c.groups.splice(gi, 1); c.groups.splice(gi + 1, 0, x) })}><IconArrowDown size={15} /></IconButton>
          <IconButton label="删除策略组" onPress={onRemove}><IconTrash size={15} /></IconButton>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <Badge tone={count ? 'good' : 'warn'} dot>{count} 个节点</Badge>
        <Switch isSelected={!!g.hide_if_empty} onChange={(v) => set({ hide_if_empty: v })}>没有节点时隐藏</Switch>
        <span className="font-mono text-xs text-muted">id: {g.id}</span>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {g.members.map((m, mi) => {
          const n = m.kind === 'all' || m.kind === 'filter' ? memberMatches(m, nodes) : null
          return (
            <div key={mi} className="rounded-[10px] bg-overlay/60 px-2.5 py-1.5">
              <div className="flex items-center gap-2 text-[13px]">
                {mi === 0 && <Badge tone="accent">默认</Badge>}
                <span className="min-w-0 flex-1 truncate">{memberLabel(m, p)}</span>
                {n && <span className="shrink-0 text-xs text-muted tabular" title={n.map((x) => x.remark).join('\n')}>匹配 {n.length}</span>}
                <IconButton label="提前" isDisabled={mi === 0} onPress={() => update((c) => { const ms = c.groups[gi].members; [ms[mi - 1], ms[mi]] = [ms[mi], ms[mi - 1]] })}><IconArrowUp size={14} /></IconButton>
                <IconButton label="移除成员" onPress={() => update((c) => { c.groups[gi].members.splice(mi, 1) })}><IconX size={14} /></IconButton>
              </div>
              {(m.kind === 'filter' || (m.kind === 'all' && !!m.exclude)) && (
                <div className="mt-1.5 grid gap-2 pb-1 sm:grid-cols-2">
                  {m.kind === 'filter' && <Field hideLabel label="包含（正则）" mono value={m.include ?? ''} onChange={(v) => setMember(mi, { include: v })} placeholder="包含：(?i)港|hk"
                    isInvalid={!!m.include && !validRe(m.include)} errorMessage="正则无效" />}
                  <Field hideLabel label="排除（正则）" mono value={m.exclude ?? ''} onChange={(v) => setMember(mi, { exclude: v || undefined })} placeholder="排除：(?i)测试|过期"
                    isInvalid={!!m.exclude && !validRe(m.exclude)} errorMessage="正则无效" />
                </div>
              )}
            </div>
          )
        })}
        <Select hideLabel label="添加成员" placeholder="＋ 添加成员…" className="w-52" value={'' as string} options={addOpts}
          onChange={(v) => update((c) => { c.groups[gi].members.push(v.startsWith('group:') ? { kind: 'group', ref: v.slice(6) } : { kind: v as Member['kind'], ...(v === 'filter' ? { include: '' } : {}) }) })} />
      </div>
      {g.type !== 'select' && (
        <div className="mt-3 grid grid-cols-[1fr_90px] gap-2">
          <Field label="测速地址" mono value={g.test_url ?? ''} onChange={(v) => set({ test_url: v || undefined })} placeholder="https://www.gstatic.com/generate_204" />
          <Field label="间隔（秒）" inputMode="numeric" value={g.interval ? String(g.interval) : ''} onChange={(v) => set({ interval: Number(v) || undefined })} placeholder="300" />
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
        <Segmented label="客户端" value={client} onChange={setClient} options={CLIENTS.map((c) => ({ id: c, label: CLIENT_LABEL[c] }))} />
        <Switch isSelected={ct.enabled} onChange={(v) => setCT({ enabled: v })}>生成此客户端的配置</Switch>
        <Button size="sm" variant="ghost" className="ml-auto" onPress={() => setCT({ base: catalog.bases[client] })}>恢复内置模板</Button>
      </div>
      {!ct.enabled && <Callout>已关闭：这个客户端会收到面板内置的简单配置（或节点列表）。</Callout>}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <Card pad={false} title="基础模板" busy={pv.loading}
          action={pv.data && (pv.data.error ? <Badge tone="bad">渲染失败</Badge> : <Badge tone="good" dot>渲染通过</Badge>)}>
          <div className="px-4 pb-4 sm:px-5">
            <div className="mb-2 flex flex-wrap gap-1.5" aria-label="占位符">
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
            <textarea ref={ref} aria-label={`${CLIENT_LABEL[client]} 基础模板`} spellCheck={false} value={ct.base} onChange={(e) => setCT({ base: e.target.value })}
              className="h-[440px] w-full resize-y rounded-[10px] border bg-base p-3 font-mono text-[12.5px] leading-5 outline-none focus:border-accent" />
            <div className="mt-2 flex flex-col gap-2">
              {missing.length > 0 && <Callout tone="bad">缺少必需占位符：{missing.map((m) => `{{${m}}}`).join('、')}</Callout>}
              {pv.data?.error && <Callout tone="bad">{pv.data.error}</Callout>}
              <p className="text-xs text-muted">占位符只做文本替换，不执行任何代码。独占一行的块占位符会按该行缩进展开；强调色的是必需项，虚线框的是右侧选项。</p>
            </div>
          </div>
        </Card>
        <Card title="选项">
          <div className="flex flex-col gap-3">
            {keys.map((k) => (
              <Field key={k} label={k} mono value={opts[k] ?? ''} placeholder={defaults[k] ?? ''}
                onChange={(v) => { const o = { ...opts }; if (v) o[k] = v; else delete o[k]; setCT({ options: o }) }}
                isInvalid={!!opts[k] && !/^[A-Za-z0-9._:/\-[\]]*$/.test(opts[k])} errorMessage="只能包含字母、数字和 . _ : / - [ ]" />
            ))}
            <AddOption onAdd={(k) => setCT({ options: { ...opts, [k]: 'value' } })} taken={keys} />
          </div>
        </Card>
      </div>
    </div>
  )
}

function AddOption({ onAdd, taken }: { onAdd: (k: string) => void; taken: string[] }) {
  const [k, setK] = useState('')
  const ok = /^[a-z_][a-z0-9_]*$/.test(k) && !taken.includes(k)
  return (
    <div className="flex items-end gap-2">
      <Field className="flex-1" label="新选项" mono value={k} onChange={setK} placeholder="例如 tun_mtu" />
      <Button isDisabled={!ok} onPress={() => { onAdd(k); setK('') }}>添加</Button>
    </div>
  )
}

// ---------------- preview / publish ----------------

function DiffView({ a, b }: { a: string; b: string }) {
  const lines = useMemo(() => compact(lineDiff(a, b)), [a, b])
  if (a === b) return <div className="rounded-[10px] border bg-base px-3 py-6 text-center text-[13px] text-muted">与已发布版本相同</div>
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
          <summary className="cursor-pointer">{d.warnings.length} 条提示（跳过的节点、隐藏的分组、客户端不支持的规则）</summary>
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
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<User[]>('/users') })
  const [client, setClient] = useState<ClientId>('mihomo')
  const [uid, setUid] = useState('0')
  const [view, setView] = useState<'body' | 'diff'>('body')
  const pv = usePreview(id, client, Number(uid), p)
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented label="客户端" value={client} onChange={setClient} options={CLIENTS.map((c) => ({ id: c, label: CLIENT_LABEL[c] }))} />
        <Select hideLabel label="示例用户" className="w-48" value={uid} onChange={setUid}
          options={[{ id: '0', label: '全部节点（不限分组）' }, ...(users.data ?? []).map((u) => ({ id: String(u.id), label: `用户 · ${u.username}` }))]} />
        <Segmented label="视图" value={view} onChange={setView} options={[{ id: 'body', label: '生成结果' }, { id: 'diff', label: '对比已发布' }]} />
        {pv.data && <span className="text-xs text-muted">{pv.data.nodes} 个节点{pv.loading && ' · 更新中…'}</span>}
      </div>
      <Output pv={pv} view={view} />
    </Card>
  )
}

function PublishDialog({ isOpen, meta, p, onClose, onDone }: { isOpen: boolean; meta: ProfileMeta; p: Profile; onClose: () => void; onDone: () => void }) {
  const [client, setClient] = useState<ClientId>('mihomo')
  const pv = usePreview(meta.id, client, 0, p)
  const enabled = CLIENTS.filter((c) => p.clients[c]?.enabled)
  const publish = useAction({
    fn: () => api<{ warnings?: Record<string, string[]> }>(`/routing/profiles/${meta.id}/publish`, { method: 'POST' }),
    success: `已发布 ${meta.name}，客户端下次更新订阅时生效`, onSuccess: () => { onDone(); onClose() },
  })
  return (
    <ModalDialog wide isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={`发布 ${meta.name}`}
      footer={<><Button onPress={onClose}>取消</Button><Button variant="primary" isPending={publish.isPending} isDisabled={!!pv.data?.error} onPress={() => publish.mutate()}>确认发布</Button></>}>
      <p className="mb-3 text-[13px] text-subtle">
        发布前会用示例节点为 {enabled.map((c) => CLIENT_LABEL[c]).join('、') || '（无）'} 各生成一次并校验。
        {meta.is_default ? '这是默认配置，影响所有未单独指定的用户。' : ''}下面是「全部节点」下与已发布版本的差异：
      </p>
      <div className="mb-3"><Segmented label="客户端" value={client} onChange={setClient} options={CLIENTS.map((c) => ({ id: c, label: CLIENT_LABEL[c] }))} /></div>
      <Output pv={pv} view="diff" />
    </ModalDialog>
  )
}

// ---------------- history / json ----------------

function HistoryTab({ id, published, dirty, onRestored }: { id: number; published: Profile; dirty: boolean; onRestored: () => void }) {
  const hist = useQuery({ queryKey: ['routing-history', id], queryFn: () => api<HistoryItem[]>(`/routing/profiles/${id}/history`) })
  const [viewing, setViewing] = useState<HistoryItem | null>(null)
  const [restoring, setRestoring] = useState<HistoryItem | null>(null)
  const v = useSticky(viewing)
  const r = useSticky(restoring)
  const restore = useAction({
    fn: (h: HistoryItem) => api(`/routing/profiles/${id}/history/${h.id}/restore`, { method: 'POST' }),
    success: '已恢复到草稿，确认后发布', onSuccess: onRestored,
  })
  const pub = JSON.stringify(published, null, 2)
  return (
    <Card pad={false} title="发布历史（最近 20 个版本）">
      {hist.isLoading && <Skeleton className="m-5 h-24" />}
      <ul>
        {(hist.data ?? []).map((h, i) => {
          const isPub = same(h.json, published)
          return (
            <li key={h.id} className="flex flex-wrap items-center gap-3 border-b px-5 py-2.5 text-[13px] last:border-0">
              <span className="tabular">{dateTime(h.ts)}</span>
              <span className="text-subtle">{h.admin}</span>
              {isPub && <Badge tone="good">当前发布</Badge>}
              {i === (hist.data?.length ?? 0) - 1 && <Badge>最初版本</Badge>}
              <div className="ml-auto flex gap-2">
                <Button size="sm" variant="ghost" onPress={() => setViewing(h)}>对比</Button>
                <Button size="sm" isDisabled={isPub} onPress={() => setRestoring(h)}>恢复到草稿</Button>
              </div>
            </li>
          )
        })}
      </ul>
      <ModalDialog wide isOpen={!!viewing} onOpenChange={(x) => !x && setViewing(null)} title={v ? `${dateTime(v.ts)} 与当前发布的差异` : ''}>
        {v && <DiffView a={pub} b={JSON.stringify(v.json, null, 2)} />}
      </ModalDialog>
      <Confirm isOpen={!!restoring} onOpenChange={(x) => !x && setRestoring(null)} title="恢复到草稿" confirmLabel="恢复"
        onConfirm={() => r && restore.mutate(r)} danger={dirty}
        body={<>把 {r ? dateTime(r.ts) : ''} 的版本放进草稿（不会立即生效）。{dirty ? '编辑器里未保存的修改会丢失。' : ''}</>} />
    </Card>
  )
}

function JsonTab({ p, onChange }: { p: Profile; onChange: (p: Profile) => void }) {
  const [text, setText] = useState(() => JSON.stringify(p, null, 2))
  const [err, setErr] = useState('')
  return (
    <Card>
      <p className="mb-3 text-[13px] text-subtle">直接编辑完整的分流模型（与 internal/subgen 的 Profile 结构一致）。格式正确时实时同步到其他标签页；保存草稿时服务端会完整校验。</p>
      <textarea aria-label="分流配置 JSON" spellCheck={false} value={text}
        onChange={(e) => {
          setText(e.target.value)
          try {
            const v = JSON.parse(e.target.value)
            if (!v || typeof v !== 'object' || !Array.isArray(v.groups) || !Array.isArray(v.rules) || !Array.isArray(v.rule_sets)) throw new Error('需要包含 rule_sets、groups、rules 数组')
            setErr(''); onChange(v)
          } catch (x) { setErr((x as Error).message) }
        }}
        className={cx('h-[560px] w-full resize-y rounded-[10px] border bg-base p-3 font-mono text-[12.5px] leading-5 outline-none focus:border-accent', err && 'border-bad')} />
      {err && <div className="mt-2"><Callout tone="bad">{err}</Callout></div>}
    </Card>
  )
}

