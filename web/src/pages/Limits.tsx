import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { api, type Group, type Inbound, type Limit, type LimitUser, type Node, type User } from '../lib/api'
import { useAction } from '../lib/actions'
import { bytes, date, parseSize } from '../lib/fmt'
import { Badge, Button, Card, CheckList, Checkbox, Confirm, Empty, Field, IconButton, ModalDialog, PageHeader, Presence, Segmented, Select, Skeleton, Switch, cx, useSticky } from '../ui/kit'
import { IconEdit, IconPlus, IconTrash } from '../ui/icons'
import { href } from '../lib/router'
import { useT } from '../i18n'
import { C } from '../i18n/common'
import { D } from '../i18n/limits'

/** Inbounds grouped by node, in node order: [[node name, inbounds]]. */
function byNode(ids: number[], inbounds: Inbound[], nodes: Node[]) {
  const want = new Set(ids)
  return nodes
    .map((n) => [n.name, inbounds.filter((i) => i.node_id === n.id && want.has(i.id))] as const)
    .filter(([, l]) => l.length > 0)
}

export function LimitsPage() {
  const t = useT(D)
  const limits = useQuery({ queryKey: ['limits'], queryFn: () => api<Limit[]>('/limits'), refetchInterval: 15000 })
  const inbounds = useQuery({ queryKey: ['inbounds'], queryFn: () => api<Inbound[]>('/inbounds') })
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<Node[]>('/nodes') })
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => api<Group[]>('/groups') })
  const [editing, setEditing] = useState<Limit | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Limit | null>(null)
  const [usersOf, setUsersOf] = useState<Limit | null>(null)
  const delSticky = useSticky(deleting)
  const del = useAction({ fn: (id: number) => api(`/limits/${id}`, { method: 'DELETE' }), apply: true, success: t.deleted, invalidate: [['limits'], ['user']] })
  const toggle = useAction({
    fn: (l: Limit) => api(`/limits/${l.id}`, { method: 'PATCH', body: { enabled: !l.enabled } }),
    apply: true, invalidate: [['limits'], ['user']],
  })
  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle}
        actions={<Button variant="primary" onPress={() => setEditing('new')}><IconPlus size={16} />{t.newLimit}</Button>} />
      {limits.isLoading && <Skeleton className="h-40" />}
      {limits.data?.length === 0 && <Card><Empty title={t.emptyTitle} hint={t.emptyHint} action={<Button variant="primary" onPress={() => setEditing('new')}>{t.newLimit}</Button>} /></Card>}
      <div className="grid items-start gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {limits.data?.map((l) => {
          const groupsOf = byNode(l.inbound_ids, inbounds.data ?? [], nodes.data ?? [])
          return (
            <section key={l.id} className={cx('rounded-[16px] border bg-surface p-5 transition-opacity', !l.enabled && 'opacity-70')}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2"><span className="truncate font-semibold">{l.name}</span>{!l.enabled && <Badge>{t.disabled}</Badge>}</div>
                  <div className="mt-1 text-xs text-muted">
                    {t.perUser(bytes(l.traffic_limit))} · {l.period === 'month' ? <>{t.monthly(l.reset_day)} · {t.nextReset(date(l.next_reset))}</> : t.withCycle}
                  </div>
                  {l.note && <div className="mt-1 text-xs text-subtle">{l.note}</div>}
                </div>
                <div className="flex shrink-0 items-center">
                  <Switch label={t.enabledSwitch} isSelected={l.enabled} onChange={() => toggle.mutate(l)} />
                  <IconButton label={t.edit} onPress={() => setEditing(l)}><IconEdit size={16} /></IconButton>
                  <IconButton label={t.del} onPress={() => setDeleting(l)}><IconTrash size={16} /></IconButton>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3 text-[13px]">
                <div><div className="text-xs text-subtle">{t.users}</div><div className="mt-0.5 text-lg font-semibold tabular">{l.users}</div></div>
                <div><div className="text-xs text-subtle">{t.over}</div><div className={cx('mt-0.5 text-lg font-semibold tabular', l.limited > 0 && 'text-bad')}>{l.limited}</div></div>
                <div><div className="text-xs text-subtle">{t.usedPeriod}</div><div className="mt-0.5 text-lg font-semibold tabular">{bytes(l.used)}</div></div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="sm" onPress={() => setUsersOf(l)}>{t.usersBtn(l.users)}</Button>
                {l.overrides > 0 && <span className="text-xs text-muted">{t.overrides(l.overrides)}</span>}
              </div>
              <ul className="mt-3 flex flex-col gap-1.5 border-t pt-3 text-[13px]">
                {groupsOf.map(([node, ins]) => (
                  <li key={node} className="flex min-w-0 gap-2">
                    <span className="w-24 shrink-0 truncate text-xs leading-5 font-semibold text-subtle">{node}</span>
                    <span className="min-w-0 truncate text-text" title={ins.map((i) => i.tag).join(', ')}>{ins.map((i) => i.remark || i.tag).join(' · ')}</span>
                  </li>
                ))}
                {groupsOf.length === 0 && <li className="text-xs text-warn">{t.noInbounds}</li>}
              </ul>
            </section>
          )
        })}
      </div>
      <Presence value={editing}>
        {(e, open) => <LimitForm isOpen={open} l={e === 'new' ? undefined : e} inbounds={inbounds.data ?? []} nodes={nodes.data ?? []} groups={groups.data ?? []} onClose={() => setEditing(null)} />}
      </Presence>
      <Confirm isOpen={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} danger title={t.del} confirmLabel={t.del}
        onConfirm={() => deleting && del.mutate(deleting.id)} body={t.deleteBody(delSticky?.name, delSticky?.users ?? 0, delSticky?.limited ?? 0)} />
      <Presence value={usersOf}>
        {(l, open) => <LimitUsers isOpen={open} l={l} onClose={() => setUsersOf(null)} />}
      </Presence>
    </>
  )
}

const gbText = (n: number) => (n ? String(+(n / 1024 ** 3).toFixed(2)) : '')

function LimitForm({ l, inbounds, nodes, groups, onClose, isOpen }: {
  l?: Limit; inbounds: Inbound[]; nodes: Node[]; groups: Group[]; onClose: () => void; isOpen: boolean
}) {
  const t = useT(D)
  const c = useT(C)
  const [name, setName] = useState(l?.name ?? '')
  const [note, setNote] = useState(l?.note ?? '')
  const [size, setSize] = useState(gbText(l?.traffic_limit ?? 0))
  const [period, setPeriod] = useState<'user' | 'month'>(l?.period ?? 'user')
  const [day, setDay] = useState(String(l?.reset_day ?? 1))
  const [ids, setIds] = useState<number[]>(l?.inbound_ids ?? [])
  const [pick, setPick] = useState('')
  const bytesVal = parseSize(size)
  const sizeOk = size.trim() !== '' && bytesVal > 0
  const save = useAction({
    fn: () => {
      const body = { name: name.trim(), note, traffic_limit: bytesVal, period, reset_day: Number(day), inbound_ids: ids }
      return l ? api(`/limits/${l.id}`, { method: 'PATCH', body }) : api('/limits', { method: 'POST', body })
    },
    apply: true, success: t.savedX(name), invalidate: [['limits'], ['user']], onSuccess: onClose,
  })
  const dirty = name !== (l?.name ?? '') || note !== (l?.note ?? '') || size !== gbText(l?.traffic_limit ?? 0) || period !== (l?.period ?? 'user')
    || day !== String(l?.reset_day ?? 1) || ids.join() !== (l?.inbound_ids ?? []).join()
  const toggle = (id: number, v: boolean) => setIds(v ? [...ids, id] : ids.filter((x) => x !== id))
  const addGroup = (gid: string) => {
    const g = groups.find((x) => String(x.id) === gid)
    if (g) setIds([...new Set([...ids, ...g.inbound_ids])])
    setPick('')
  }
  return (
    <ModalDialog wide isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={l ? t.editX(l.name) : t.newLimit} dirty={dirty}
      footer={<><Button onPress={onClose}>{c.cancel}</Button><Button variant="primary" isPending={save.isPending} isDisabled={!name.trim() || !sizeOk} onPress={() => save.mutate()}>{c.save}</Button></>}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.name} value={name} onChange={setName} placeholder={t.namePh} autoFocus={!l} />
          <Field label={t.limit} value={size} onChange={setSize} inputMode="decimal" placeholder="50"
            description={size.trim() && sizeOk ? `= ${bytes(bytesVal)}` : t.limitDesc} isInvalid={size.trim() !== '' && !sizeOk} errorMessage={t.limitBad} />
        </div>
        <div className="flex flex-col gap-2">
          <div className="text-[13px] font-medium text-subtle">{t.period}</div>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented label={t.period} value={period} onChange={setPeriod} options={[{ id: 'user', label: t.pUser }, { id: 'month', label: t.pMonth }]} />
            {period === 'month' && <Select hideLabel label={t.resetDay} value={day} onChange={setDay} className="w-28"
              options={Array.from({ length: 28 }, (_, i) => ({ id: String(i + 1), label: t.dayN(i + 1) }))} />}
          </div>
          <div className="text-xs text-muted">{period === 'month' ? t.pMonthDesc : t.pUserDesc}</div>
        </div>
        <div>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-[13px] font-medium text-subtle">
            <span>{t.inbounds(ids.length)}</span>
            <span className="flex items-center gap-2">
              {groups.length > 0 && <Select hideLabel label={t.fromGroup} placeholder={t.fromGroup} value={pick} onChange={addGroup} className="w-48"
                options={groups.map((g) => ({ id: String(g.id), label: `${g.name} (${g.inbound_ids.length})` }))} />}
              <Button size="sm" variant="ghost" onPress={() => setIds([])}>{t.clear}</Button>
            </span>
          </div>
          <div className="mb-2 text-xs text-muted">{t.inboundsDesc}</div>
          <div className="flex max-h-[320px] flex-col gap-3 overflow-y-auto rounded-[12px] border bg-base p-3">
            {nodes.filter((n) => inbounds.some((i) => i.node_id === n.id)).map((n) => (
              <div key={n.id}>
                <div className="mb-1.5 text-xs font-semibold text-subtle">{n.name}</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {inbounds.filter((i) => i.node_id === n.id).map((i) => (
                    <Checkbox key={i.id} isSelected={ids.includes(i.id)} onChange={(v) => toggle(i.id, v)}>
                      <span className="truncate">{i.remark || i.tag} <span className="text-xs text-muted">{i.tag} · {i.type} :{i.port}{i.enabled ? '' : t.stopped}</span></span>
                    </Checkbox>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {!l && <div className="mt-2 text-xs text-muted">{t.backfill}</div>}
        </div>
        <Field label={t.note} value={note} onChange={setNote} />
      </div>
    </ModalDialog>
  )
}


/** Who a preset is attached to: usage, size, remove; attach it to more users. */
function LimitUsers({ l, isOpen, onClose }: { l: Limit; isOpen: boolean; onClose: () => void }) {
  const t = useT(D)
  const c = useT(C)
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['limits', l.id, 'users'], queryFn: () => api<LimitUser[]>(`/limits/${l.id}/users`), enabled: isOpen })
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<User[]>('/users'), enabled: isOpen })
  const [adding, setAdding] = useState(false)
  const [pick, setPick] = useState<number[]>([])
  const on = new Set((list.data ?? []).map((u) => u.user_id))
  const free = (users.data ?? []).filter((u) => !on.has(u.id))
  const inv = [['limits'], ['user'], ['users']]
  const batch = useAction({
    fn: (v: { ids: number[]; attach: boolean }) => api('/users/batch', { method: 'POST', body: { ids: v.ids, action: 'set_limit', value: { rule_id: l.id, attach: v.attach } } }),
    apply: true, invalidate: inv,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['limits', l.id, 'users'] }); setAdding(false); setPick([]) },
  })
  return (
    <ModalDialog wide isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={t.usersTitle(l.name)}
      footer={adding
        ? <><Button onPress={() => { setAdding(false); setPick([]) }}>{c.cancel}</Button><Button variant="primary" isDisabled={!pick.length} isPending={batch.isPending} onPress={() => batch.mutate({ ids: pick, attach: true })}>{t.attachN(pick.length)}</Button></>
        : <><Button onPress={onClose}>{c.close}</Button><Button variant="primary" isDisabled={!free.length} onPress={() => setAdding(true)}><IconPlus size={14} />{t.addUsers}</Button></>}>
      {adding ? (
        <div className="flex flex-col gap-2">
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onPress={() => setPick(free.map((u) => u.id))}>{t.selectAll}</Button>
            <Button size="sm" variant="ghost" onPress={() => setPick([])}>{t.clear}</Button>
          </div>
          <div className="max-h-[360px] overflow-y-auto">
            <CheckList label={t.pickUsers} value={pick} onChange={setPick} empty={t.allHave}
              options={free.map((u) => ({ id: u.id, label: u.username, hint: u.enabled ? undefined : c.disabled }))} />
          </div>
        </div>
      ) : list.isLoading ? <Skeleton className="h-40" /> : (list.data ?? []).length === 0 ? <Empty title={t.noUsersOn} /> : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] whitespace-nowrap">
            <thead className="text-left text-xs text-subtle"><tr className="border-b"><th className="py-2 pr-3 font-medium">{t.colUser}</th><th className="w-[45%] px-3 py-2 font-medium">{t.colUsed}</th><th className="py-2 pl-3" /></tr></thead>
            <tbody>
              {list.data!.map((u) => {
                const pct = u.traffic_limit ? Math.min(100, (u.used / u.traffic_limit) * 100) : 0
                return (
                  <tr key={u.user_id} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      <a className="font-medium hover:text-accent hover:underline" href={href('users', { id: u.user_id, tab: 'lines' })}>{u.username}</a>
                      {u.override && <span className="ml-2"><Badge>{t.own}</Badge></span>}
                      {u.exhausted && <span className="ml-2"><Badge tone="bad">{t.exhausted}</Badge></span>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-3">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-overlay"><div className={cx('h-full rounded-full', u.exhausted ? 'bg-bad' : pct >= 80 ? 'bg-warn' : 'bg-accent')} style={{ width: `${u.exhausted ? 100 : pct}%` }} /></div>
                        <span className="w-32 text-right tabular">{t.ofLimit(bytes(u.used), bytes(u.traffic_limit))}</span>
                      </div>
                    </td>
                    <td className="py-2 pl-3 text-right"><Button size="sm" variant="ghost" onPress={() => batch.mutate({ ids: [u.user_id], attach: false })}>{t.remove}</Button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </ModalDialog>
  )
}
