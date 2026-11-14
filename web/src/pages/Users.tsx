import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog, DialogTrigger, Popover } from 'react-aria-components'
import { api, type User, type TopRow, type SeriesResp, type Group, type SubInfo } from '../lib/api'
import { bytes, dateTime, parseSize, ago, expiresIn, GB, DAY } from '../lib/fmt'
import { useRoute, go, replace, withParams, href } from '../lib/router'
import { flashRows, leaveRows, settleRows, useAction, useApplyTracker, useRowFx, useSubUrl, useUserBatch, useUserPatch } from '../lib/actions'
import { filterDefs, sortDefs, matchQuery, usedOf, usedPct, lastSeenOf, USERNAME_RE, type FilterId, type SortId } from '../lib/users'
import {
  ActionMenu, Badge, Busy, Button, Card, CheckList, Checkbox, Chip, Confirm, CopyButton, CopyIcon, CopyText, Drawer, Empty, Field,
  IconButton, ModalDialog, PageHeader, Presence, Progress, RelTime, Segmented, Select, Skeleton, Switch, Tabs, copyText,
  cx, popoverCls, useCopy, useToast, type MenuEntry,
} from '../ui/kit'
import { ShareList, TimeChart } from '../ui/charts'
import type { ProfileMeta } from '../lib/routing'
import { IconPlus, IconSearch, IconX, IconArrowDown, IconEdit } from '../ui/icons'

const statusInfo: Record<string, { tone: 'good' | 'warn' | 'bad' | 'neutral'; text: string }> = {
  active: { tone: 'good', text: '正常' },
  limited: { tone: 'warn', text: '超额' },
  expired: { tone: 'bad', text: '已过期' },
}

export const resetOptions = [
  { id: 'none', label: '不重置' }, { id: 'day', label: '每天' }, { id: 'week', label: '每周一' },
  { id: 'month', label: '每月 1 日' }, { id: 'month_rolling', label: '按创建日每月' },
]

const mbps = (bps: number) => (bps > 0 ? +(bps * 8 / 1e6).toFixed(2) + ' Mbps' : '不限')
const IconQr = (p: { size?: number }) => <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><path d="M14 14h3v3M21 14v.01M14 21h3M21 17v4h-1" /></svg>
const IconChevron = ({ dir, size = 16 }: { dir: 'up' | 'down'; size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={dir === 'up' ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} /></svg>

function UserStatus({ u }: { u: User }) {
  if (!u.enabled) return <Badge tone="neutral" dot>已禁用</Badge>
  const s = statusInfo[u.status] ?? { tone: 'neutral' as const, text: u.status }
  return <Badge tone={s.tone} dot>{s.text}</Badge>
}

function Expiry({ u }: { u: User }) {
  const left = u.expire_at ? u.expire_at - Date.now() / 1000 : Infinity
  return <RelTime ts={u.expire_at} text={expiresIn(u.expire_at)} className={cx('tabular whitespace-nowrap', left <= 0 ? 'text-bad' : left <= 7 * DAY ? 'text-warn' : '')} />
}

function Usage({ u }: { u: User }) {
  const used = usedOf(u)
  return (
    <div className="min-w-[150px]">
      <div className="mb-1 flex justify-between gap-2 text-xs tabular whitespace-nowrap">
        <span>{bytes(used)} <span className="text-muted">/ {u.traffic_limit ? bytes(u.traffic_limit, 0) : '不限'}</span></span>
        {u.traffic_limit > 0 && <span className={cx(usedPct(u) >= 95 ? 'text-bad' : usedPct(u) >= 80 ? 'text-warn' : 'text-muted')}>{usedPct(u).toFixed(0)}%</span>}
      </div>
      <Progress value={u.traffic_limit ? usedPct(u) : 0} />
    </div>
  )
}

function Online({ u }: { u: User }) {
  if (u.online_ips <= 0) return <span className="text-muted">—</span>
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap tabular"><span className="h-2 w-2 rounded-full bg-good" />{u.online_ips}{u.device_limit ? `/${u.device_limit}` : ''}</span>
}

function LastSeen({ u }: { u: User }) {
  if (u.online_ips > 0) return <span className="text-good">在线</span>
  const t = lastSeenOf(u)
  if (t) return <RelTime ts={t} text={ago(t)} className="text-subtle" />
  return u.sub_last_at ? <RelTime ts={u.sub_last_at} text={`订阅 ${ago(u.sub_last_at)}`} className="text-muted" /> : <span className="text-muted">—</span>
}

/** Params straight from the URL, so debounced writes never use a stale closure. */
const liveParams = () => new URLSearchParams(location.hash.split('?')[1] ?? '')
const setP = (patch: Record<string, string | number | undefined>) => replace('users', withParams(liveParams(), patch))

export function UsersPage() {
  const { params } = useRoute()
  const qc = useQueryClient()
  const toast = useToast()
  const subUrl = useSubUrl()
  const run = useUserBatch()
  const fx = useRowFx()
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<User[]>('/users'), refetchInterval: 10000 })
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => api<Group[]>('/groups') })
  const gname = useMemo(() => new Map((groups.data ?? []).map((g) => [g.id, g.name])), [groups.data])

  const openId = Number(params.get('id')) || 0
  const legacy = params.get('filter') === 'problem' ? 'limited,expired,disabled' : params.get('filter') === 'online' ? 'online' : ''
  const fParam = params.get('f') ?? legacy
  const active = useMemo(() => new Set(fParam.split(',').filter(Boolean) as FilterId[]), [fParam])
  const group = params.get('g') ?? 'all'
  const sort = (params.get('sort') as SortId) || 'created'
  const sd = sortDefs.find((s) => s.id === sort) ?? sortDefs[0]
  const dir = (params.get('dir') as 'asc' | 'desc') || sd.defDir
  const qParam = params.get('q') ?? ''
  const [q, setQ] = useState(qParam)
  useEffect(() => { setQ((x) => (x === qParam ? x : qParam)) }, [qParam])
  useEffect(() => {
    if (q === (liveParams().get('q') ?? '')) return
    const t = setTimeout(() => setP({ q, page: undefined }), 150)
    return () => clearTimeout(t)
  }, [q])

  const all = useMemo(() => users.data ?? [], [users.data])
  const base = useMemo(() => all.filter((u) => matchQuery(u, qParam) && (group === 'all' || u.group_ids.includes(Number(group)))), [all, qParam, group])
  const counts = useMemo(() => Object.fromEntries(filterDefs.map((f) => [f.id, base.filter(f.test).length])) as Record<FilterId, number>, [base])
  const rows = useMemo(() => {
    const tests = filterDefs.filter((f) => active.has(f.id))
    const r = tests.length ? base.filter((u) => tests.some((t) => t.test(u))) : [...base]
    const k = sd.key
    r.sort((a, b) => { const x = k(a), y = k(b); const c = x < y ? -1 : x > y ? 1 : 0; return dir === 'asc' ? c : -c })
    return r
  }, [base, active, sd, dir])
  const PAGE = 100
  const paged = rows.length > 200
  const pages = Math.ceil(rows.length / PAGE)
  const page = Math.min(pages, Math.max(1, Number(params.get('page')) || 1))
  const visible = paged ? rows.slice((page - 1) * PAGE, page * PAGE) : rows

  // ---- selection & keyboard ----
  const [sel, setSel] = useState<Set<number>>(new Set())
  const anchor = useRef<number | null>(null)
  const [focus, setFocus] = useState(-1)
  useEffect(() => { // drop ids that no longer exist
    setSel((s) => { const ids = new Set(all.map((u) => u.id)); const n = new Set([...s].filter((i) => ids.has(i))); return n.size === s.size ? s : n })
  }, [all])
  const toggle = useCallback((id: number, idx: number, shift?: boolean) => {
    setSel((s) => {
      const n = new Set(s)
      if (shift && anchor.current !== null) {
        const [a, b] = [Math.min(anchor.current, idx), Math.max(anchor.current, idx)]
        const on = !s.has(id)
        visible.slice(a, b + 1).forEach((u) => (on ? n.add(u.id) : n.delete(u.id)))
      } else if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
    anchor.current = idx
  }, [visible])
  const allSel = rows.length > 0 && rows.every((u) => sel.has(u.id))
  const someSel = !allSel && rows.some((u) => sel.has(u.id))
  const focusRow = (i: number) => {
    const el = [...document.querySelectorAll<HTMLElement>(`[data-row="${i}"]`)].find((x) => x.offsetParent !== null)
    el?.focus()
    el?.scrollIntoView({ block: 'nearest' })
  }
  const openUser = (id: number, tab?: string) => go('users', withParams(liveParams(), { id, tab }))
  const closeUser = () => go('users', withParams(liveParams(), { id: undefined, tab: undefined }))
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t?.closest?.('input, textarea, select, [contenteditable=true]')) return
      const dialogs = document.querySelectorAll('[role=dialog]').length
      if (openId) {
        if (dialogs > 1 || e.metaKey || e.ctrlKey || e.altKey) return
        if (e.key === 'j' || e.key === 'k') {
          e.preventDefault()
          const i = rows.findIndex((u) => u.id === openId)
          const n = rows[i + (e.key === 'j' ? 1 : -1)]
          if (n) setP({ id: n.id })
        }
        return
      }
      if (dialogs > 0) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); setSel(new Set(rows.map((u) => u.id))); return }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault()
        const n = Math.max(0, Math.min(visible.length - 1, focus + (e.key === 'j' ? 1 : -1)))
        setFocus(n); focusRow(n)
      } else if (e.key === 'x' && focus >= 0 && visible[focus]) {
        e.preventDefault(); toggle(visible[focus].id, focus)
      } else if (e.key === 'Escape' && sel.size) setSel(new Set())
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [openId, rows, visible, focus, sel.size, toggle])

  // ---- actions ----
  const [creating, setCreating] = useState(() => params.get('new') === '1')
  useEffect(() => { if (params.get('new') === '1') { setCreating(true); setP({ new: undefined }) } }, [params])
  const [bulk, setBulk] = useState(false)
  const [deleting, setDeleting] = useState<number[] | null>(null)
  const [prompt, setPrompt] = useState<{ kind: 'days' | 'gb'; ids: number[] } | null>(null)
  const [groupsFor, setGroupsFor] = useState<number[] | null>(null)
  const byId = useMemo(() => new Map(all.map((u) => [u.id, u])), [all])
  const who = (ids: number[]) => (ids.length === 1 ? byId.get(ids[0])?.username ?? '用户' : `${ids.length} 个用户`)

  const doDelete = async (ids: number[]) => {
    leaveRows(ids)
    try {
      if (ids.length === 1) await api(`/users/${ids[0]}`, { method: 'DELETE' })
      else await api('/users/batch', { method: 'POST', body: { ids, action: 'delete' } })
      setTimeout(() => { qc.invalidateQueries({ queryKey: ['users'] }); qc.invalidateQueries({ queryKey: ['groups'] }); settleRows(ids) }, 180)
      setSel(new Set())
      if (ids.includes(openId)) closeUser()
      toast('good', `已删除 ${who(ids)}`)
    } catch (e) { settleRows(ids); toast('bad', (e as Error).message) }
  }
  const act = (ids: number[], k: string) => {
    const u = byId.get(ids[0])
    switch (k) {
      case 'copy': copyText(ids.map((i) => subUrl(byId.get(i)!)).join('\n')).then(() => toast('good', ids.length > 1 ? `已复制 ${ids.length} 条订阅链接` : '已复制订阅链接'), () => toast('bad', '复制失败，请检查浏览器的剪贴板权限')); break
      case 'qr': openUser(ids[0], 'sub'); break
      case 'open': openUser(ids[0]); break
      case 'd7': case 'd30': case 'd90': case 'd365': { const n = Number(k.slice(1)); run(ids, 'extend_days', n, `${who(ids)} 已续期 ${n} 天`).catch(() => {}); break }
      case 'g10': case 'g50': case 'g100': case 'g500': { const n = Number(k.slice(1)); run(ids, 'add_traffic', n * GB, `${who(ids)} 已增加 ${n} GB`).catch(() => {}); break }
      case 'dcustom': setPrompt({ kind: 'days', ids }); break
      case 'gcustom': setPrompt({ kind: 'gb', ids }); break
      case 'reset': run(ids, 'reset_usage', null, `${who(ids)} 的本期用量已清零`).catch(() => {}); break
      case 'enable': run(ids, 'enable', null, `已启用 ${who(ids)}`).catch(() => {}); break
      case 'disable': run(ids, 'disable', null, `已禁用 ${who(ids)}`).catch(() => {}); break
      case 'toggle': if (u) act(ids, u.enabled ? 'disable' : 'enable'); break
      case 'kick': api(`/users/${ids[0]}/kick`, { method: 'POST' }).then(() => toast('good', `已断开 ${who(ids)} 的所有连接`), (e) => toast('bad', (e as Error).message)); break
      case 'groups': setGroupsFor(ids); break
      case 'delete': setDeleting(ids); break
    }
  }
  const rowMenu = (u: User): MenuEntry[] => [
    { id: 'copy', label: '复制订阅链接' }, { id: 'qr', label: '订阅二维码' }, 'sep',
    { id: 'd30', label: '续期 +30 天' }, { id: 'g100', label: '流量 +100 GB' }, { id: 'reset', label: '重置用量' },
    { id: 'toggle', label: u.enabled ? '禁用' : '启用' }, { id: 'kick', label: '断开连接', isDisabled: u.online_ips === 0 }, 'sep',
    { id: 'delete', label: '删除', danger: true },
  ]
  const clearFilters = () => { setQ(''); setP({ q: undefined, f: undefined, filter: undefined, g: undefined, page: undefined }) }
  const toggleChip = (id: FilterId) => {
    const n = new Set(active)
    if (n.has(id)) n.delete(id); else n.add(id)
    setP({ f: [...n].join(',') || undefined, filter: undefined, page: undefined })
  }
  const sortBy = (id: SortId) => {
    const d = sortDefs.find((s) => s.id === id)!
    const nd = id === sort ? (dir === 'asc' ? 'desc' : 'asc') : d.defDir
    setP({ sort: id === 'created' && nd === 'desc' ? undefined : id, dir: nd === d.defDir ? undefined : nd })
  }
  const Th = ({ id, children, className }: { id: SortId; children: ReactNode; className?: string }) => (
    <th className={cx('px-3 py-2 font-medium', className)} aria-sort={sort === id ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" onClick={() => sortBy(id)} className={cx('inline-flex cursor-pointer items-center gap-1 rounded outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-accent', sort === id && 'text-text')}>
        {children}
        <span className={cx('transition-[opacity,transform] duration-(--dur-1)', sort === id ? 'opacity-100' : 'opacity-0', dir === 'asc' && sort === id && 'rotate-180')}><IconArrowDown size={12} /></span>
      </button>
    </th>
  )
  const selIds = [...sel]

  return (
    <>
      <PageHeader title="用户" subtitle="额度、到期、限速和设备数。超额或到期的用户会在几秒内从所有节点移除并断线"
        actions={<>
          <Button onPress={() => setBulk(true)}>批量创建</Button>
          <Button variant="primary" onPress={() => setCreating(true)}><IconPlus size={16} />新建用户</Button>
        </>} />
      <div className="mb-3 flex flex-wrap items-center gap-2 sm:gap-3">
        <label className="relative w-full sm:w-72 sm:flex-none">
          <IconSearch size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="用户名、备注或 UUID 前缀" aria-label="搜索用户"
            onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ('') } }}
            className="h-9 w-full rounded-full border bg-surface pr-8 pl-9 text-sm outline-none transition-[border-color,box-shadow] duration-(--dur-1) focus:border-accent focus:ring-2 focus:ring-accent/25 [&::-webkit-search-cancel-button]:hidden" />
          {q ? <button type="button" aria-label="清空搜索" onClick={() => setQ('')} className="absolute top-1/2 right-2 grid h-6 w-6 -translate-y-1/2 cursor-pointer place-items-center rounded-full text-muted hover:bg-overlay hover:text-text"><IconX size={12} /></button>
            : <kbd className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded bg-overlay px-1.5 text-[11px] text-muted sm:block">/</kbd>}
        </label>
        {(groups.data?.length ?? 0) > 1 && (
          <Select hideLabel label="分组" className="w-36" value={group} onChange={(v) => setP({ g: v === 'all' ? undefined : v, page: undefined })}
            options={[{ id: 'all', label: '全部分组' }, ...(groups.data ?? []).map((g) => ({ id: String(g.id), label: g.name }))]} />
        )}
        <Select hideLabel label="排序" className="w-32 lg:hidden" value={sort} onChange={(v) => sortBy(v as SortId)}
          options={sortDefs.map((s) => ({ id: s.id, label: s.label }))} />
        <span className="ml-auto text-[13px] text-subtle tabular">{rows.length} / {all.length} 个用户</span>
      </div>
      <div className="no-scrollbar -mx-4 mb-4 flex gap-1.5 overflow-x-auto px-4 lg:mx-0 lg:flex-wrap lg:px-0" role="group" aria-label="筛选">
        <Chip active={active.size === 0} onPress={() => setP({ f: undefined, filter: undefined, page: undefined })} count={base.length}>全部</Chip>
        {filterDefs.map((f) => <Chip key={f.id} active={active.has(f.id)} onPress={() => toggleChip(f.id)} count={counts[f.id]} tone={f.tone}>{f.label}</Chip>)}
      </div>

      <Card pad={false}>
        {users.isPending && !users.data ? <div className="p-5"><Skeleton className="h-40" /></div> : rows.length === 0 ? (
          all.length ? (
            <Empty title="没有匹配的用户" hint="换个关键词，或者清除筛选条件" action={<Button onPress={clearFilters}>清除筛选</Button>} />
          ) : (
            <Empty title="还没有用户" hint="新建用户后，它会被下发到所属分组的所有入站"
              action={<>
                <Button variant="primary" onPress={() => setCreating(true)}><IconPlus size={16} />新建用户</Button>
                <Button onPress={() => setBulk(true)}>批量创建</Button>
                <Button onPress={() => go('settings', { tab: 'import' })}>从 3x-ui 迁移</Button>
              </>} />
          )
        ) : (
          <>
            {/* desktop table */}
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-[13px]">
                <thead className="text-left text-xs whitespace-nowrap text-subtle">
                  <tr className="border-b">
                    <th className="w-10 py-2 pr-0 pl-4"><Checkbox label="全选筛选结果" isSelected={allSel} isIndeterminate={someSel}
                      onChange={() => setSel(allSel ? new Set() : new Set(rows.map((u) => u.id)))} /></th>
                    <Th id="name" className="pl-2">用户</Th>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <Th id="usage" className="w-[220px]">本期用量</Th>
                    <Th id="expire">到期</Th>
                    <th className="px-3 py-2 font-medium">在线</th>
                    <Th id="seen" className="hidden xl:table-cell">最近在线</Th>
                    <th className="hidden px-3 py-2 font-medium 2xl:table-cell">分组</th>
                    <th className="w-[120px] px-3 py-2"><span className="sr-only">操作</span></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((u, i) => (
                    <tr key={u.id} data-row={i} tabIndex={0} aria-selected={sel.has(u.id)}
                      onClick={(e) => { if ((e.target as HTMLElement).closest('button, a, label, [role=checkbox]')) return; openUser(u.id) }}
                      onFocus={() => setFocus(i)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openUser(u.id) }}
                      className={cx('group cursor-pointer border-b outline-none transition-colors duration-(--dur-1) last:border-0 hover:bg-hl-low focus-visible:bg-hl-low focus-visible:shadow-[inset_2px_0_0_var(--accent)]',
                        sel.has(u.id) && 'bg-accent/6', openId === u.id && 'bg-hl-low', fx(u.id))}>
                      <td className="py-2.5 pr-0 pl-4" onMouseDown={(e) => e.shiftKey && e.preventDefault()} onClick={(e) => { e.stopPropagation(); toggle(u.id, i, e.shiftKey) }}>
                        <Checkbox label={`选择 ${u.username}`} isSelected={sel.has(u.id)} onChange={() => {}} className="pointer-events-none" />
                      </td>
                      <td className="py-2.5 pr-3 pl-2"><div className="font-medium">{u.username}</div>{u.note && <div className="max-w-[200px] truncate text-xs text-muted">{u.note}</div>}</td>
                      <td className="px-3 py-2.5"><UserStatus u={u} /></td>
                      <td className="px-3 py-2.5"><Usage u={u} /></td>
                      <td className="px-3 py-2.5"><Expiry u={u} /></td>
                      <td className="px-3 py-2.5"><Online u={u} /></td>
                      <td className="hidden px-3 py-2.5 whitespace-nowrap xl:table-cell"><LastSeen u={u} /></td>
                      <td className="hidden px-3 py-2.5 2xl:table-cell">
                        <div className="flex max-w-[200px] flex-wrap gap-1">{u.group_ids.map((g) => <Badge key={g}>{gname.get(g) ?? g}</Badge>)}{u.group_ids.length === 0 && <span className="text-xs text-bad">无分组</span>}</div>
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <div className="flex items-center justify-end opacity-0 transition-opacity duration-(--dur-1) group-focus-within:opacity-100 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100 [@media(hover:none)]:opacity-100">
                          <RowCopy url={subUrl(u)} />
                          <QrPop u={u} />
                          <ActionMenu label={`${u.username} 的更多操作`} items={rowMenu(u)} onAction={(k) => act([u.id], k)} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* mobile cards */}
            <ul className="lg:hidden">
              <li className="flex items-center justify-between border-b px-4 py-2 text-xs text-subtle">
                <Checkbox label="全选筛选结果" isSelected={allSel} isIndeterminate={someSel} onChange={() => setSel(allSel ? new Set() : new Set(rows.map((u) => u.id)))}>全选</Checkbox>
              </li>
              {visible.map((u, i) => (
                <li key={u.id} data-row={i} tabIndex={0} onFocus={() => setFocus(i)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openUser(u.id) }}
                  className={cx('flex items-start gap-3 border-b px-4 py-3 outline-none last:border-0 focus-visible:bg-hl-low', sel.has(u.id) && 'bg-accent/6', fx(u.id))}>
                  <div className="pt-0.5" onMouseDown={(e) => e.shiftKey && e.preventDefault()} onClick={(e) => { e.stopPropagation(); toggle(u.id, i, e.shiftKey) }}>
                    <Checkbox label={`选择 ${u.username}`} isSelected={sel.has(u.id)} onChange={() => {}} className="pointer-events-none" />
                  </div>
                  <button type="button" onClick={() => openUser(u.id)} className="min-w-0 flex-1 cursor-pointer text-left outline-none">
                    <div className="flex items-center gap-2"><span className="truncate font-medium">{u.username}</span><UserStatus u={u} />{u.online_ips > 0 && <Online u={u} />}</div>
                    {u.note && <div className="truncate text-xs text-muted">{u.note}</div>}
                    <div className="mt-2"><Usage u={u} /></div>
                    <div className="mt-1.5 flex justify-between text-xs text-subtle"><span>到期 <Expiry u={u} /></span><LastSeen u={u} /></div>
                  </button>
                  <ActionMenu label={`${u.username} 的操作`} items={rowMenu(u)} onAction={(k) => act([u.id], k)} />
                </li>
              ))}
            </ul>
            {paged && (
              <div className="flex items-center justify-between gap-3 border-t px-4 py-3 text-[13px] text-subtle">
                <span className="tabular">第 {(page - 1) * PAGE + 1}–{Math.min(rows.length, page * PAGE)} 个，共 {rows.length} 个</span>
                <div className="flex gap-2">
                  <Button size="sm" isDisabled={page <= 1} onPress={() => setP({ page: page - 1 })}>上一页</Button>
                  <Button size="sm" isDisabled={page >= pages} onPress={() => setP({ page: page + 1 })}>下一页</Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      <Presence value={sel.size > 0 ? selIds : null}>
        {(ids, open) => <BatchBar ids={open ? selIds : ids} open={open} onClear={() => setSel(new Set())} onAction={(k) => act(open ? selIds : ids, k)} />}
      </Presence>

      <Presence value={creating || null}>
        {(_, open) => <UserForm isOpen={open} groups={groups.data ?? []} users={all} onClose={() => setCreating(false)} onOpen={(id) => { setCreating(false); openUser(id) }} />}
      </Presence>
      <Presence value={bulk || null}>
        {(_, open) => <BulkCreate isOpen={open} groups={groups.data ?? []} onClose={() => setBulk(false)} />}
      </Presence>
      <Presence value={openId || null}>
        {(id, open) => <UserDrawer id={id} isOpen={open} groups={groups.data ?? []} ids={rows.map((u) => u.id)}
          tab={(params.get('tab') as DrawerTab) || 'overview'} onTab={(t) => setP({ tab: t === 'overview' ? undefined : t })}
          onNav={(n) => setP({ id: n })} onClose={closeUser} onAct={(k) => act([id], k)} />}
      </Presence>
      <Confirm isOpen={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} danger title={deleting && deleting.length > 1 ? `删除 ${deleting.length} 个用户` : '删除用户'}
        confirmLabel={deleting && deleting.length > 1 ? `删除 ${deleting.length} 个用户` : '删除'}
        requireText={deleting && deleting.length > 1 ? String(deleting.length) : undefined}
        onConfirm={() => deleting && doDelete(deleting)}
        body={deleting && deleting.length > 1
          ? <>将永久删除 <b className="text-text">{deleting.length}</b> 个用户，立刻从所有节点移除并断线，订阅链接失效。此操作不可撤销，历史流量记录保留。</>
          : <>删除 <b className="text-text">{deleting && who(deleting)}</b> 会立刻从所有节点移除并断线，订阅链接失效。此操作不可撤销，历史流量记录保留。</>} />
      <Presence value={prompt}>
        {(p, open) => <AmountPrompt kind={p.kind} count={p.ids.length} isOpen={open} onClose={() => setPrompt(null)}
          onSubmit={(n) => { setPrompt(null); if (p.kind === 'days') run(p.ids, 'extend_days', n, `${who(p.ids)} 已${n >= 0 ? '续期' : '缩短'} ${Math.abs(n)} 天`).catch(() => {}); else run(p.ids, 'add_traffic', Math.round(n * GB), `${who(p.ids)} 已${n >= 0 ? '增加' : '减少'} ${Math.abs(n)} GB`).catch(() => {}) }} />}
      </Presence>
      <Presence value={groupsFor}>
        {(ids, open) => <SetGroups ids={ids} isOpen={open} groups={groups.data ?? []} users={byId} onClose={() => setGroupsFor(null)}
          onSubmit={(gids) => { setGroupsFor(null); run(ids, 'set_groups', gids, `已设置 ${who(ids)} 的分组`).catch(() => {}) }} />}
      </Presence>
    </>
  )
}

function RowCopy({ url }: { url: string }) {
  const [copied, copy] = useCopy()
  return <IconButton label={copied ? '已复制' : '复制订阅链接'} onPress={() => copy(url)}><CopyIcon copied={copied} size={15} /></IconButton>
}

function QrPop({ u }: { u: User }) {
  return (
    <DialogTrigger>
      <IconButton label="订阅二维码"><IconQr size={15} /></IconButton>
      <Popover placement="bottom end" className={popoverCls}>
        <Dialog aria-label={`${u.username} 的订阅二维码`} className="p-2 outline-none"><QrBody id={u.id} /></Dialog>
      </Popover>
    </DialogTrigger>
  )
}

function QrBody({ id }: { id: number }) {
  const sub = useQuery({ queryKey: ['user', id, 'sub'], queryFn: () => api<SubInfo>(`/users/${id}/sub`) })
  return sub.data?.qr
    ? <img src={sub.data.qr} alt="订阅链接二维码" className="h-44 w-44 animate-content-in rounded-[8px] bg-white p-1.5 [image-rendering:pixelated]" />
    : <Skeleton className="h-44 w-44" />
}

function BatchBar({ ids, open, onClear, onAction }: { ids: number[]; open: boolean; onClear: () => void; onAction: (k: string) => void }) {
  useEffect(() => {
    if (!open) return
    document.documentElement.style.setProperty('--toast-lift', '64px')
    return () => { document.documentElement.style.removeProperty('--toast-lift') }
  }, [open])
  const n = ids.length
  return (
    <div role="toolbar" aria-label={`批量操作：已选 ${n} 个用户`}
      className={cx('fixed bottom-[calc(72px+env(safe-area-inset-bottom))] left-1/2 z-40 flex -translate-x-1/2 max-w-[calc(100vw-24px)] items-center gap-1 rounded-full border bg-surface p-1.5 shadow-[0_8px_24px_rgb(0_0_0/0.16)] lg:bottom-5',
        open ? 'animate-bar-in' : 'pointer-events-none animate-bar-out')}>
      <span className="flex shrink-0 items-center gap-1 pl-2 text-[13px] font-medium whitespace-nowrap">
        已选 <span key={n} className="inline-block animate-num tabular">{n}</span> 个
        <IconButton label="取消选择" className="h-7 w-7" onPress={onClear}><IconX size={14} /></IconButton>
      </span>
      <span className="mx-1 h-5 w-px shrink-0 bg-hl-med" />
      <div className="no-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto">
        <Button size="sm" variant="ghost" onPress={() => onAction('enable')}>启用</Button>
        <Button size="sm" variant="ghost" onPress={() => onAction('disable')}>禁用</Button>
        <ActionMenu label="续期" placement="top" onAction={onAction} trigger={<Button size="sm" variant="ghost">续期…</Button>}
          items={[{ id: 'd7', label: '+7 天' }, { id: 'd30', label: '+30 天' }, { id: 'd90', label: '+90 天' }, { id: 'd365', label: '+365 天' }, 'sep', { id: 'dcustom', label: '自定义天数…' }]} />
        <ActionMenu label="增加流量" placement="top" onAction={onAction} trigger={<Button size="sm" variant="ghost">增加流量…</Button>}
          items={[{ id: 'g10', label: '+10 GB' }, { id: 'g50', label: '+50 GB' }, { id: 'g100', label: '+100 GB' }, { id: 'g500', label: '+500 GB' }, 'sep', { id: 'gcustom', label: '自定义…' }]} />
        <Button size="sm" variant="ghost" onPress={() => onAction('reset')}>重置用量</Button>
        <Button size="sm" variant="ghost" onPress={() => onAction('groups')}>设置分组…</Button>
        <Button size="sm" variant="ghost" onPress={() => onAction('copy')}>复制订阅链接</Button>
        <Button size="sm" variant="danger" onPress={() => onAction('delete')}>删除</Button>
      </div>
    </div>
  )
}

function AmountPrompt({ kind, count, isOpen, onClose, onSubmit }: { kind: 'days' | 'gb'; count: number; isOpen: boolean; onClose: () => void; onSubmit: (n: number) => void }) {
  const [v, setV] = useState(kind === 'days' ? '30' : '100')
  const n = Number(v)
  const ok = v.trim() !== '' && Number.isFinite(n) && n !== 0
  return (
    <ModalDialog isOpen={isOpen} onOpenChange={(x) => !x && onClose()} title={kind === 'days' ? `为 ${count} 个用户续期` : `为 ${count} 个用户增加流量`}
      footer={<><Button onPress={onClose}>取消</Button><Button variant="primary" isDisabled={!ok} onPress={() => onSubmit(n)}>确定</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); if (ok) onSubmit(n) }}>
        <Field label={kind === 'days' ? '天数' : '流量（GB）'} value={v} onChange={setV} autoFocus inputMode="decimal" isInvalid={v.trim() !== '' && !ok} errorMessage="请输入非 0 的数字"
          description={kind === 'days' ? '从当前到期时间（已过期则从现在）往后延；永久的用户改为从现在起算。负数表示缩短。' : '加在当前额度上；不限额度的用户保持不限。负数表示减少。'} />
      </form>
    </ModalDialog>
  )
}

function SetGroups({ ids, isOpen, groups, users, onClose, onSubmit }: { ids: number[]; isOpen: boolean; groups: Group[]; users: Map<number, User>; onClose: () => void; onSubmit: (g: number[]) => void }) {
  const common = groups.filter((g) => ids.every((i) => users.get(i)?.group_ids.includes(g.id))).map((g) => g.id)
  const [gids, setGids] = useState<number[]>(common)
  return (
    <ModalDialog isOpen={isOpen} onOpenChange={(x) => !x && onClose()} title={`设置 ${ids.length} 个用户的分组`}
      footer={<><Button onPress={onClose}>取消</Button><Button variant="primary" onPress={() => onSubmit(gids)}>应用到 {ids.length} 个用户</Button></>}>
      <p className="mb-3 text-[13px] text-subtle">所选用户的分组会被替换为下面勾选的分组（不是追加）。</p>
      <CheckList label="分组" value={gids} onChange={setGids} options={groups.map((g) => ({ id: g.id, label: g.name, hint: `${g.inbound_ids.length} 个入站` }))} empty="还没有分组" />
      {gids.length === 0 && <div className="mt-3"><Badge tone="bad">没有分组的用户无法使用任何入站</Badge></div>}
    </ModalDialog>
  )
}

// ---- create / edit ------------------------------------------------------------

function gb(n: number) { return n ? String(+(n / GB).toFixed(2)) : '' }
function toMbps(bps: number) { return bps ? String(+(bps * 8 / 1e6).toFixed(2)) : '' }
function fromMbps(s: string) { const v = parseFloat(s); return s.trim() && v > 0 ? Math.round(v * 1e6 / 8) : 0 }
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const inDays = (n: number) => ymd(new Date(Date.now() + n * DAY * 1000))

const presets = [
  { id: 'trial', label: '试用', hint: '10GB / 7 天', limit: '10', unit: 'GB', days: 7, reset: 'none' },
  { id: 'std', label: '标准', hint: '100GB / 30 天 / 月重置', limit: '100', unit: 'GB', days: 30, reset: 'month' },
  { id: 'free', label: '不限', hint: '不限流量和时间', limit: '', unit: 'GB', days: 0, reset: 'none' },
] as const

type FormState = { username: string; limit: string; unit: 'GB' | 'TB'; exp: string; reset: string; devices: string; up: string; down: string; note: string; gids: number[]; profile: string }

/** Create (u undefined) or edit a user. Creating ends on a "created" view with the subscription link. */
function UserForm({ u, groups, users, isOpen, onClose, onOpen }: { u?: User; groups: Group[]; users: User[]; isOpen: boolean; onClose: () => void; onOpen?: (id: number) => void }) {
  const qc = useQueryClient()
  const track = useApplyTracker()
  const init = useCallback((): FormState => {
    const tb = (u?.traffic_limit ?? 0) >= 1024 * GB && (u!.traffic_limit / (1024 * GB)) % 1 === 0
    return {
      username: u?.username ?? '', limit: tb ? String(u!.traffic_limit / (1024 * GB)) : gb(u?.traffic_limit ?? 0), unit: tb ? 'TB' : 'GB',
      exp: u?.expire_at ? ymd(new Date(u.expire_at * 1000)) : '', reset: u?.reset_strategy || 'none',
      devices: u?.device_limit ? String(u.device_limit) : '', up: toMbps(u?.speed_up ?? 0), down: toMbps(u?.speed_down ?? 0),
      note: u?.note ?? '', gids: u?.group_ids ?? groups.filter((g) => g.is_default).map((g) => g.id), profile: String(u?.sub_profile_id ?? 0),
    }
  }, [u, groups])
  const [f, setF] = useState<FormState>(init)
  const [initial] = useState(() => JSON.stringify(init()))
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((x) => ({ ...x, [k]: v }))
  const [preset, setPreset] = useState('')
  const [created, setCreated] = useState<{ id: number; username: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [touched, setTouched] = useState(false)

  const nameErr = !f.username ? (touched ? '请输入用户名' : '')
    : !USERNAME_RE.test(f.username) ? '只能包含字母、数字和 . _ @ -，最长 64 个字符'
      : users.some((x) => x.username === f.username && x.id !== u?.id) ? '这个用户名已经存在' : ''
  const limitBytes = (() => {
    const s = f.limit.trim()
    if (!s) return 0
    if (/[kmgtp]/i.test(s)) return parseSize(s)
    const n = Number(s)
    return Number.isFinite(n) && n >= 0 ? Math.round(n * (f.unit === 'TB' ? 1024 * GB : GB)) : NaN
  })()
  const devN = f.devices.trim() ? Number(f.devices) : 0
  const devErr = !Number.isInteger(devN) || devN < 0 ? '必须是非负整数' : ''
  const dirty = !created && JSON.stringify(f) !== initial
  const valid = !!f.username && !nameErr && !Number.isNaN(limitBytes) && !devErr

  const applyPreset = (id: string) => {
    const p = presets.find((x) => x.id === id)!
    setPreset(id)
    setF((x) => ({ ...x, limit: p.limit, unit: p.unit, exp: p.days ? inDays(p.days) : '', reset: p.reset }))
  }
  const submit = async () => {
    setTouched(true)
    if (!valid) return
    setBusy(true); setErr('')
    const body = {
      username: f.username, traffic_limit: limitBytes, expire_at: f.exp ? Math.floor(new Date(f.exp + 'T23:59:59').getTime() / 1000) : 0,
      reset_strategy: f.reset, device_limit: devN, speed_up: fromMbps(f.up), speed_down: fromMbps(f.down), note: f.note, group_ids: f.gids, sub_profile_id: Number(f.profile),
    }
    try {
      let id: number
      if (u) { await api(`/users/${u.id}`, { method: 'PATCH', body }); id = u.id }
      else id = (await api<{ id: number }>('/users', { method: 'POST', body })).id
      qc.invalidateQueries({ queryKey: ['users'] }); qc.invalidateQueries({ queryKey: ['user', id] }); qc.invalidateQueries({ queryKey: ['groups'] })
      flashRows([id])
      track({ text: u ? `已保存 ${f.username}` : `已创建 ${f.username}` })
      if (u) onClose()
      else setCreated({ id, username: f.username })
    } catch (e) {
      const m = (e as Error).message
      if (/exist|已存在|UNIQUE/i.test(m)) setErr('这个用户名已经存在'); else setErr(m)
    } finally { setBusy(false) }
  }
  const again = () => { setCreated(null); setF(init()); setPreset(''); setTouched(false); setErr('') }

  const csub = useQuery({ queryKey: ['user', created?.id, 'sub'], queryFn: () => api<SubInfo>(`/users/${created!.id}/sub`), enabled: !!created })
  if (created) {
    return (
      <ModalDialog isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title="用户已创建" label="用户已创建"
        footer={<div key="done" className="flex w-full animate-content-in flex-wrap justify-end gap-2"><Button variant="ghost" className="mr-auto" onPress={() => onOpen?.(created.id)}>查看详情</Button><Button onPress={again}><IconPlus size={14} />再建一个</Button>
          <CopyButton size="md" variant="primary" label="复制链接" text={csub.data?.url ?? ''} isDisabled={!csub.data} /></div>}>
        <CreatedBody c={created} sub={csub.data} />
      </ModalDialog>
    )
  }
  return (
    <ModalDialog wide isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={u ? `编辑 ${u.username}` : '新建用户'} dirty={dirty}
      footer={<>{err && <span className="mr-auto self-center text-[13px] text-bad">{err}</span>}<Button onPress={onClose}>取消</Button>
        <Button variant="primary" isPending={busy} isDisabled={!valid} onPress={submit}>{u ? '保存' : '创建'}</Button></>}>
      <form className="grid gap-5 md:grid-cols-[1fr_240px]" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <div className="flex min-w-0 flex-col gap-4">
          {!u && (
            <div>
              <div className="mb-1.5 text-[13px] font-medium text-subtle">套餐预设</div>
              <div className="flex flex-wrap gap-1.5">
                {presets.map((p) => (
                  <Chip key={p.id} active={preset === p.id} onPress={() => applyPreset(p.id)}>{p.label}<span className={cx('text-[11px]', preset === p.id ? 'opacity-80' : 'text-muted')}>{p.hint}</span></Chip>
                ))}
              </div>
            </div>
          )}
          <Field label="用户名" value={f.username} onChange={(v) => { set('username', v); setErr('') }} autoFocus={!u}
            isInvalid={!!nameErr} errorMessage={nameErr} description="字母、数字、. _ @ -" />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="uf-limit" className="text-[13px] font-medium text-subtle">流量额度</label>
                <Segmented label="单位" value={f.unit} onChange={(v) => set('unit', v)} options={[{ id: 'GB', label: 'GB' }, { id: 'TB', label: 'TB' }]} />
              </div>
              <input id="uf-limit" value={f.limit} onChange={(e) => { set('limit', e.target.value); setPreset('') }} placeholder="不限" inputMode="decimal"
                aria-invalid={Number.isNaN(limitBytes) || undefined}
                className={cx('h-9 w-full rounded-[10px] border bg-base px-3 text-sm outline-none transition-[border-color,box-shadow] duration-(--dur-1) placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/25', Number.isNaN(limitBytes) && 'border-bad')} />
              <span className={cx('text-xs', Number.isNaN(limitBytes) ? 'text-bad' : 'text-muted')}>{Number.isNaN(limitBytes) ? '格式不对，例如 100、1.5T、800M' : limitBytes ? `= ${bytes(limitBytes)}` : '留空为不限'}</span>
            </div>
            <Select label="用量重置" value={f.reset} onChange={(v) => set('reset', v)} options={resetOptions} />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="text-[13px] font-medium text-subtle">到期</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {[7, 30, 90, 365].map((n) => <Chip key={n} active={f.exp === inDays(n)} onPress={() => { set('exp', inDays(n)); setPreset('') }}>{n} 天</Chip>)}
              <Chip active={!f.exp} onPress={() => { set('exp', ''); setPreset('') }}>永久</Chip>
              <input type="date" aria-label="到期日期" value={f.exp} onChange={(e) => { set('exp', e.target.value); setPreset('') }}
                className="h-8 rounded-full border bg-base px-3 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/25" />
            </div>
            <span className="text-xs text-muted">{f.exp ? `${f.exp} 23:59 到期 · ${expiresIn(Math.floor(new Date(f.exp + 'T23:59:59').getTime() / 1000))}` : '永不过期'}</span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="设备上限" value={f.devices} onChange={(v) => set('devices', v)} placeholder="不限" inputMode="numeric" isInvalid={!!devErr} errorMessage={devErr} />
            <Field label="上行 Mbps" value={f.up} onChange={(v) => set('up', v)} placeholder="不限" inputMode="decimal" />
            <Field label="下行 Mbps" value={f.down} onChange={(v) => set('down', v)} placeholder="不限" inputMode="decimal" />
          </div>
          <Field label="备注" value={f.note} onChange={(v) => set('note', v)} />
        </div>
        <CheckList label="分组（决定能用哪些入站）" value={f.gids} onChange={(v) => set('gids', v)}
          options={groups.map((g) => ({ id: g.id, label: g.name, hint: `${g.inbound_ids.length} 个入站` }))}
          empty="还没有分组" />
        <ProfileSelect value={f.profile} onChange={(v) => set('profile', v)} />
        <button type="submit" hidden />
      </form>
    </ModalDialog>
  )
}

function CreatedBody({ c, sub }: { c: { id: number; username: string }; sub?: SubInfo }) {
  return (
    <div className="flex animate-content-in flex-col items-center gap-4 text-center sm:flex-row sm:items-start sm:text-left">
      {sub?.qr ? <img src={sub.qr} alt="订阅链接二维码" className="h-40 w-40 shrink-0 animate-content-in rounded-[12px] bg-white p-1.5 [image-rendering:pixelated]" /> : <Skeleton className="h-40 w-40 shrink-0" />}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-center justify-center gap-2 sm:justify-start"><span className="grid h-6 w-6 animate-check place-items-center rounded-full bg-good/15 text-good">✓</span><b className="text-[15px]">{c.username}</b></div>
        <p className="text-[13px] text-subtle">把订阅链接或二维码发给用户，导入客户端即可使用。</p>
        <div className="rounded-[10px] border bg-base px-3 py-2 text-left">{sub ? <CopyText text={sub.url} className="w-full" /> : <Skeleton className="h-4" />}</div>
        {sub && <a href={sub.formats.page} target="_blank" rel="noreferrer" className="text-[13px] text-accent hover:underline">打开用户自助页 ↗</a>}
      </div>
    </div>
  )
}

function BulkCreate({ groups, isOpen, onClose }: { groups: Group[]; isOpen: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const subUrl = useSubUrl()
  const [prefix, setPrefix] = useState('user')
  const [count, setCount] = useState('10')
  const [start, setStart] = useState('1')
  const [limit, setLimit] = useState('')
  const [days, setDays] = useState('')
  const [reset, setReset] = useState('month')
  const [gids, setGids] = useState<number[]>(groups.filter((g) => g.is_default).map((g) => g.id))
  const [done, setDone] = useState<User[] | null>(null)
  const n = Number(count) || 0
  const s = Number(start) || 1
  const countErr = !Number.isInteger(n) || n < 1 ? '至少 1 个' : n > 500 ? '一次最多 500 个' : ''
  const width = Math.max(2, String(s + n - 1).length)
  const preview = !countErr ? `${prefix}${String(s).padStart(width, '0')} … ${prefix}${String(s + n - 1).padStart(width, '0')}` : ''
  const run = useAction({
    fn: () => {
      const l = limit.trim() ? parseSize(limit) : 0
      if (Number.isNaN(l)) throw new Error('流量格式不对')
      return api<{ ids: number[] }>('/users/bulk', { method: 'POST', body: { prefix, count: n, start: s, traffic_limit: l, expire_days: Number(days) || 0, reset_strategy: reset, group_ids: gids } })
    },
    apply: true, success: (r) => `已创建 ${r.ids.length} 个用户`,
    onSuccess: async (r) => {
      flashRows(r.ids)
      await qc.invalidateQueries({ queryKey: ['users'] })
      qc.invalidateQueries({ queryKey: ['groups'] })
      const list = qc.getQueryData<User[]>(['users']) ?? []
      const ids = new Set(r.ids)
      setDone(list.filter((u) => ids.has(u.id)))
    },
  })
  const csv = () => {
    const rows = [['username', 'subscription_url'], ...(done ?? []).map((u) => [u.username, subUrl(u)])]
    const blob = new Blob(['﻿' + rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = `${prefix}-users.csv`; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  if (done) {
    return (
      <ModalDialog isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={`已创建 ${done.length} 个用户`}
        footer={<><Button className="mr-auto" onPress={csv}>导出 CSV</Button><CopyButton size="md" label="复制全部订阅链接" text={() => done.map((u) => `${u.username}\t${subUrl(u)}`).join('\n')} />
          <Button variant="primary" onPress={onClose}>完成</Button></>}>
        <ul className="max-h-[50vh] animate-content-in overflow-y-auto rounded-[10px] border bg-base text-[13px]">
          {done.map((u) => (
            <li key={u.id} className="flex items-center gap-3 border-b px-3 py-2 last:border-0">
              <span className="w-28 shrink-0 truncate font-medium">{u.username}</span>
              <CopyText text={subUrl(u)} className="min-w-0 flex-1" />
            </li>
          ))}
        </ul>
      </ModalDialog>
    )
  }
  return (
    <ModalDialog wide isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title="批量创建用户"
      footer={<><Button onPress={onClose}>取消</Button><Button variant="primary" isPending={run.isPending} isDisabled={!!countErr} onPress={() => run.mutate()}>创建 {countErr ? '' : n} 个</Button></>}>
      <div className="grid gap-5 md:grid-cols-[1fr_240px]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="用户名前缀" value={prefix} onChange={setPrefix} />
            <Field label="数量" value={count} onChange={setCount} inputMode="numeric" description="1–500" isInvalid={!!countErr} errorMessage={countErr} />
            <Field label="起始编号" value={start} onChange={setStart} inputMode="numeric" />
          </div>
          {preview && <div className="text-[13px] text-subtle">将创建 <span className="font-mono text-text">{preview}</span></div>}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="流量额度（GB）" value={limit} onChange={setLimit} placeholder="不限" />
            <Field label="有效天数" value={days} onChange={setDays} placeholder="永久" inputMode="numeric" />
            <Select label="用量重置" value={reset} onChange={setReset} options={resetOptions} />
          </div>
        </div>
        <CheckList label="分组" value={gids} onChange={setGids} options={groups.map((g) => ({ id: g.id, label: g.name }))} />
      </div>
    </ModalDialog>
  )
}

// ---- detail drawer --------------------------------------------------------------

type UserDetail = { user: User; ips: { ip: string; node: string; first_seen: number; last_seen: number; online: boolean }[] }
type DrawerTab = 'overview' | 'sub' | 'devices'

function UserDrawer({ id, isOpen, groups, ids, tab, onTab, onNav, onClose, onAct }: {
  id: number; isOpen: boolean; groups: Group[]; ids: number[]; tab: DrawerTab
  onTab: (t: DrawerTab) => void; onNav: (id: number) => void; onClose: () => void; onAct: (k: string) => void
}) {
  const qc = useQueryClient()
  const run = useUserBatch()
  const patch = useUserPatch()
  const toast = useToast()
  const subUrl = useSubUrl()
  const live = isOpen ? 10000 : false
  const d = useQuery({ queryKey: ['user', id], queryFn: () => api<UserDetail>(`/users/${id}`), refetchInterval: live, placeholderData: keepPreviousData, enabled: isOpen })
  const sub = useQuery({ queryKey: ['user', id, 'sub'], queryFn: () => api<SubInfo>(`/users/${id}/sub`), placeholderData: keepPreviousData, enabled: isOpen })
  const [from] = useState(() => Math.floor(Date.now() / 1000) - 7 * 86400)
  const series = useQuery({ queryKey: ['series', 'user', id], queryFn: () => api<SeriesResp>(`/traffic/series?step=3600&group=total&user=${id}&from=${from}`), placeholderData: keepPreviousData, enabled: isOpen })
  const domains = useQuery({ queryKey: ['top', 'domain', 'user', id], queryFn: () => api<TopRow[]>(`/traffic/top?dim=domain&user=${id}&from=${from}&limit=12`), placeholderData: keepPreviousData, enabled: isOpen })
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState<'' | 'rotate' | 'reset'>('')
  const [optEnabled, setOpt] = useState<boolean | null>(null)

  const u = d.data?.user
  useEffect(() => { setOpt(null) }, [u?.enabled, u?.id])
  const enabled = optEnabled ?? u?.enabled ?? false
  const s = series.data?.series[0]
  const gname = new Map(groups.map((g) => [g.id, g.name]))
  const i = ids.indexOf(id)
  const prev = i > 0 ? ids[i - 1] : undefined
  const next = i >= 0 && i < ids.length - 1 ? ids[i + 1] : undefined
  const switching = d.isPlaceholderData
  const used = u ? usedOf(u) : 0

  const setEnabled = (v: boolean) => {
    if (!u) return
    setOpt(v)
    qc.setQueryData<User[]>(['users'], (l) => l?.map((x) => (x.id === u.id ? { ...x, enabled: v } : x)))
    run([u.id], v ? 'enable' : 'disable', null, `已${v ? '启用' : '禁用'} ${u.username}`).catch(() => { setOpt(null); qc.invalidateQueries({ queryKey: ['users'] }) })
  }
  const rotate = useAction({ fn: () => api(`/users/${id}`, { method: 'PATCH', body: { rotate_secrets: true } }), apply: true, success: '密钥已更换', invalidate: [['user', id], ['users']] })

  const title = u
    ? <span className="flex min-w-0 items-center gap-2"><span className="truncate">{u.username}</span><UserStatus u={{ ...u, enabled }} /></span>
    : '用户'
  return (
    <Drawer isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={title} label={u ? `用户 ${u.username}` : '用户'} contentKey={u?.id}
      actions={<>
        <IconButton label="上一个（k）" isDisabled={prev === undefined} onPress={() => prev !== undefined && onNav(prev)}><IconChevron dir="up" /></IconButton>
        <IconButton label="下一个（j）" isDisabled={next === undefined} onPress={() => next !== undefined && onNav(next)}><IconChevron dir="down" /></IconButton>
      </>}>
      {!u ? (d.isError ? <Empty title="用户不存在" hint="它可能已被删除" /> : <div className="flex flex-col gap-4"><Skeleton className="h-9" /><Skeleton className="h-40" /><Skeleton className="h-64" /></div>) : (
        <Busy busy={switching} className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton label="复制订阅链接" variant="primary" text={subUrl(u)} />
            <DialogTrigger>
              <Button size="sm"><IconQr size={14} />二维码</Button>
              <Popover placement="bottom start" className={popoverCls}><Dialog aria-label="订阅二维码" className="p-2 outline-none"><QrBody id={u.id} /></Dialog></Popover>
            </DialogTrigger>
            <Button size="sm" onPress={() => setEditing(true)}><IconEdit size={14} />编辑</Button>
            <ActionMenu label="更多操作" onAction={(k) => k === 'reset' || k === 'rotate' ? setConfirm(k) : onAct(k)}
              items={[{ id: 'reset', label: '重置用量' }, { id: 'rotate', label: '更换密钥' }, { id: 'kick', label: '断开连接', isDisabled: u.online_ips === 0 }, 'sep', { id: 'delete', label: '删除用户', danger: true }]} />
            <div className="flex-1" />
            <Switch isSelected={enabled} onChange={setEnabled}>启用</Switch>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Box label="本期已用" value={bytes(used)} sub={u.traffic_limit ? `额度 ${bytes(u.traffic_limit)} · ${usedPct(u).toFixed(1)}%` : '不限额度'}
              bar={u.traffic_limit ? usedPct(u) : undefined}
              chips={<>
                <QuickChip onPress={() => run([u.id], 'add_traffic', 50 * GB, `${u.username} 已增加 50 GB`).catch(() => {})}>+50GB</QuickChip>
                <QuickChip onPress={() => run([u.id], 'add_traffic', 100 * GB, `${u.username} 已增加 100 GB`).catch(() => {})}>+100GB</QuickChip>
                <QuickChip isDisabled={!u.traffic_limit} onPress={() => patch(u, { traffic_limit: 0 }, `${u.username} 改为不限流量`).catch(() => {})}>不限</QuickChip>
              </>} />
            <Box label="到期" value={u.expire_at ? new Date(u.expire_at * 1000).toLocaleDateString('zh-CN') : '永久'} sub={u.expire_at ? expiresIn(u.expire_at) : `重置：${resetOptions.find((r) => r.id === (u.reset_strategy || 'none'))?.label}`}
              chips={<>
                {[7, 30, 90].map((n) => <QuickChip key={n} onPress={() => run([u.id], 'extend_days', n, `${u.username} 已续期 ${n} 天`).catch(() => {})}>+{n} 天</QuickChip>)}
                <QuickChip isDisabled={!u.expire_at} onPress={() => patch(u, { expire_at: 0 }, `${u.username} 改为永不过期`).catch(() => {})}>永久</QuickChip>
              </>} />
            <Box label="限速 ↑ / ↓" value={`${mbps(u.speed_up)} / ${mbps(u.speed_down)}`} sub={`设备上限 ${u.device_limit || '不限'}`} />
            <Box label="在线设备" value={String(u.online_ips)} sub={`累计 ${bytes(u.life_down + u.life_up)}`} />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {u.group_ids.length ? u.group_ids.map((g) => <Badge key={g} tone="accent">{gname.get(g) ?? g}</Badge>) : <Badge tone="bad">没有分组，无法使用任何入站</Badge>}
          </div>

          <div>
            <Tabs label="用户详情" value={tab} onChange={onTab} tabs={[
              { id: 'overview', label: '流量' }, { id: 'sub', label: '订阅', count: sub.data?.links.length },
              { id: 'devices', label: '设备与访问', count: d.data!.ips.length },
            ]} />
            <div key={tab} className="flex animate-content-in flex-col gap-4">
              {tab === 'overview' && <>
                <Card title="近 7 天流量（每小时）" busy={series.isPlaceholderData}>
                  {s ? <TimeChart height={180} step={3600} times={s.points.map((p) => p[0])}
                    series={[{ key: 'down', label: '下行', values: s.points.map((p) => p[2]), color: 'var(--s1)' }, { key: 'up', label: '上行', values: s.points.map((p) => p[1]), color: 'var(--s2)' }]} />
                    : series.data ? <div className="grid h-[180px] place-items-center text-[13px] text-muted">近 7 天没有流量</div> : <Skeleton className="h-[180px]" />}
                </Card>
                <Card title="访问的域名（7 天）" busy={domains.isPlaceholderData}>
                  <ShareList mono rows={(domains.data ?? []).map((r) => ({ key: r.key, label: r.label, value: r.up + r.down }))}
                    onSelect={(k) => go('traffic', { user: id, dim: 'host', q: k, range: '7d' })} />
                </Card>
              </>}
              {tab === 'sub' && (sub.data ? <SubPanel s={sub.data} busy={sub.isPlaceholderData} /> : <Skeleton className="h-48" />)}
              {tab === 'devices' && <Devices d={d.data!} access={sub.data?.access} />}
            </div>
          </div>
        </Busy>
      )}
      <Presence value={editing && u ? u : null}>
        {(uu, open) => <UserForm isOpen={open} u={uu} groups={groups} users={qc.getQueryData<User[]>(['users']) ?? []} onClose={() => setEditing(false)} />}
      </Presence>
      <Confirm isOpen={confirm === 'rotate'} onOpenChange={(v) => !v && setConfirm('')} danger title="更换密钥" confirmLabel="更换密钥"
        onConfirm={() => rotate.mutate()} body="UUID、密码和订阅令牌都会重新生成，旧的客户端配置和订阅链接立即失效。此操作不可撤销。" />
      <Confirm isOpen={confirm === 'reset'} onOpenChange={(v) => !v && setConfirm('')} title="重置本期用量" confirmLabel="重置"
        onConfirm={() => { if (u) run([u.id], 'reset_usage', null, `${u.username} 的本期用量已清零`).catch(() => {}); else toast('bad', '用户不存在') }}
        body="本期已用流量清零（累计用量和历史统计不变）。超额的用户会恢复正常。可以在提示里撤销。" />
    </Drawer>
  )
}

function QuickChip({ children, onPress, isDisabled }: { children: ReactNode; onPress: () => void; isDisabled?: boolean }) {
  return (
    <button type="button" disabled={isDisabled} onClick={onPress}
      className="h-6 cursor-pointer rounded-full bg-overlay px-2 text-xs font-medium text-subtle outline-none transition-[background-color,color,transform] duration-(--dur-1) hover:bg-accent/15 hover:text-accent active:scale-95 focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-overlay disabled:hover:text-subtle">
      {children}
    </button>
  )
}

function Devices({ d, access }: { d: UserDetail; access?: SubInfo['access'] }) {
  return <>
    <Card title="来源 IP" pad={false}>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] whitespace-nowrap">
          <thead className="text-left text-xs text-subtle"><tr className="border-b"><th className="px-5 py-2 font-medium">IP</th><th className="px-3 py-2 font-medium">节点</th><th className="px-3 py-2 font-medium">首次</th><th className="px-5 py-2 font-medium">最近</th></tr></thead>
          <tbody>
            {d.ips.map((x) => (
              <tr key={x.ip + x.node} className="border-b last:border-0">
                <td className="px-5 py-2 font-mono text-[12.5px]"><span className={cx('mr-2 inline-block h-1.5 w-1.5 rounded-full', x.online ? 'bg-good' : 'bg-hl-high')} />{x.ip}</td>
                <td className="px-3 py-2">{x.node}</td>
                <td className="px-3 py-2 tabular text-subtle"><RelTime ts={x.first_seen} text={dateTime(x.first_seen)} /></td>
                <td className="px-5 py-2 tabular text-subtle">{x.online ? <span className="text-good">在线</span> : <RelTime ts={x.last_seen} text={ago(x.last_seen)} />}</td>
              </tr>
            ))}
            {d.ips.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-muted">还没有连接记录</td></tr>}
          </tbody>
        </table>
      </div>
    </Card>
    <Card title="订阅访问记录" pad={false}>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] whitespace-nowrap">
          <thead className="text-left text-xs text-subtle"><tr className="border-b"><th className="px-5 py-2 font-medium">时间</th><th className="px-3 py-2 font-medium">IP</th><th className="px-3 py-2 font-medium">格式</th><th className="px-5 py-2 font-medium">客户端</th></tr></thead>
          <tbody>
            {(access ?? []).map((a, i) => (
              <tr key={i} className="border-b last:border-0">
                <td className="px-5 py-2 tabular text-subtle"><RelTime ts={a.ts} text={dateTime(a.ts)} /></td>
                <td className="px-3 py-2 font-mono text-[12.5px]">{a.ip}</td>
                <td className="px-3 py-2"><Badge>{a.format}</Badge></td>
                <td className="max-w-[220px] truncate px-5 py-2 text-xs text-muted" title={a.ua}>{a.ua || '—'}</td>
              </tr>
            ))}
            {access && access.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-muted">还没有客户端拉取过订阅</td></tr>}
          </tbody>
        </table>
      </div>
    </Card>
  </>
}

function SubPanel({ s, busy }: { s: SubInfo; busy?: boolean }) {
  const [fmt, setFmt] = useState<'singbox' | 'mihomo' | 'page'>('singbox')
  const fmtLabel = { singbox: 'sing-box', mihomo: 'Clash / mihomo', page: '用户自助页' }
  return (
    <Busy busy={busy} className="flex flex-col gap-4">
      {!s.active && <div className="rounded-[10px] bg-warn/10 px-3 py-2 text-[13px] text-warn">用户当前不可用（禁用/超额/到期），订阅会返回空节点列表，但仍带用量信息。</div>}
      <Card title="订阅链接">
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <div className="flex min-w-0 flex-col gap-3">
            <div className="rounded-[10px] border bg-base px-3 py-2"><CopyText text={s.url} className="w-full" /></div>
            <div className="flex flex-wrap items-center gap-2">
              <CopyButton label="复制订阅链接" variant="primary" text={s.url} />
              <a href={s.formats.page} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center rounded-full px-3 text-[13px] text-accent hover:bg-overlay">在新窗口预览自助页 ↗</a>
            </div>
            <p className="text-xs text-muted">通用链接按客户端 User-Agent 自动返回 sing-box / Clash 配置或 base64 节点列表；浏览器打开是自助页。</p>
          </div>
          {s.qr && <img src={s.qr} alt="订阅链接二维码" className="mx-auto h-36 w-36 rounded-[10px] bg-white p-1.5 [image-rendering:pixelated]" />}
        </div>
        <details className="group mt-4 rounded-[10px] border">
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-[13px] text-subtle outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
            其他格式（sing-box、Clash、自助页）<span className="transition-transform duration-(--dur-2) group-open:rotate-180"><IconChevron dir="down" size={14} /></span>
          </summary>
          <div className="flex animate-content-in flex-col gap-3 border-t px-3 py-3">
            <Segmented label="格式" value={fmt} onChange={setFmt} options={(Object.keys(fmtLabel) as (keyof typeof fmtLabel)[]).map((k) => ({ id: k, label: fmtLabel[k] }))} />
            <div className="rounded-[10px] border bg-base px-3 py-2"><CopyText text={s.formats[fmt]} className="w-full" /></div>
          </div>
        </details>
      </Card>
      <Card title={`节点链接（${s.links.length}）`} pad={false}>
        {s.links.length === 0 ? <div className="px-5 py-8 text-center text-[13px] text-muted">没有可用节点：检查用户分组是否包含已启用的入站</div> : (
          <ul>
            {s.links.map((l, i) => (
              <li key={i} className="flex items-center gap-3 border-b px-5 py-2.5 last:border-0">
                <Badge tone="accent">{l.type}</Badge>
                <span className="min-w-0 flex-1 truncate text-[13px]">{l.remark}</span>
                <CopyText text={l.uri} display="复制" />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Busy>
  )
}

function Box({ label, value, sub, chips, bar }: { label: string; value: string; sub?: string; chips?: ReactNode; bar?: number }) {
  return (
    <div className="rounded-[12px] border bg-base p-3">
      <div className="text-xs text-subtle">{label}</div>
      <div key={value} className="mt-1 animate-num text-[17px] font-semibold tabular">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted tabular">{sub}</div>}
      {bar !== undefined && <div className="mt-2"><Progress value={bar} /></div>}
      {chips && <div className="mt-2.5 flex flex-wrap gap-1">{chips}</div>}
    </div>
  )
}

export const usersHref = (f: FilterId) => href('users', { f })

/** Per-user routing profile override (订阅 → 分流规则). */
function ProfileSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const profiles = useQuery({ queryKey: ['routing-profiles'], queryFn: () => api<ProfileMeta[]>('/routing/profiles') })
  return (
    <Select label="分流配置" value={value} onChange={onChange} description="Clash / sing-box / Surge 订阅使用的规则；跟随分组时按分组 → 默认配置"
      options={[{ id: '0', label: '跟随分组 / 默认' }, ...(profiles.data ?? []).map((p) => ({ id: String(p.id), label: p.name }))]} />
  )
}
