import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Group, type Inbound, type Node, type User } from '../lib/api'
import { useAction } from '../lib/actions'
import { href } from '../lib/router'
import { Badge, Button, Card, Checkbox, Confirm, Empty, Field, IconButton, ModalDialog, PageHeader, Presence, Select, Skeleton, Switch, useSticky } from '../ui/kit'
import type { ProfileMeta } from '../lib/routing'
import { IconEdit, IconPlus, IconTrash } from '../ui/icons'
import { tr, useT } from '../i18n'
import { C } from '../i18n/common'
import { D } from '../i18n/groups'

export function GroupsPage() {
  const t = useT(D)
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => api<Group[]>('/groups') })
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<User[]>('/users') })
  const inbounds = useQuery({ queryKey: ['inbounds'], queryFn: () => api<Inbound[]>('/inbounds') })
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<Node[]>('/nodes') })
  const profiles = useQuery({ queryKey: ['routing-profiles'], queryFn: () => api<ProfileMeta[]>('/routing/profiles') })
  const pname = new Map((profiles.data ?? []).map((p) => [p.id, p.name]))
  const [editing, setEditing] = useState<Group | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Group | null>(null)
  const del = useAction({
    fn: (id: number) => api(`/groups/${id}`, { method: 'DELETE' }),
    apply: true, success: t.deleted, invalidate: [['groups'], ['users'], ['inbounds']],
  })
  const delSticky = useSticky(deleting)
  // Users whose only group is the one being deleted lose every inbound.
  const orphans = delSticky ? (users.data ?? []).filter((u) => u.group_ids.length === 1 && u.group_ids[0] === delSticky.id).length : 0
  const ibName = new Map((inbounds.data ?? []).map((i) => [i.id, `${i.node} / ${i.tag}`]))
  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle}
        actions={<Button variant="primary" onPress={() => setEditing('new')}><IconPlus size={16} />{t.newGroup}</Button>} />
      {groups.isLoading && <Skeleton className="h-40" />}
      {groups.data?.length === 0 && <Card><Empty title={t.emptyTitle} hint={t.emptyHint} action={<Button variant="primary" onPress={() => setEditing('new')}>{t.newGroup}</Button>} /></Card>}
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {groups.data?.map((g) => (
          <section key={g.id} className="rounded-[16px] border bg-surface p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2"><span className="truncate font-semibold">{g.name}</span>{g.is_default && <Badge tone="accent">{tr(C).default}</Badge>}</div>
                {g.remark && <div className="mt-1 text-xs text-muted">{g.remark}</div>}
              </div>
              <div className="flex shrink-0">
                <IconButton label={t.editGroup} onPress={() => setEditing(g)}><IconEdit size={16} /></IconButton>
                <IconButton label={t.deleteGroup} onPress={() => setDeleting(g)}><IconTrash size={16} /></IconButton>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-[13px]">
              <div><div className="text-xs text-subtle">{tr(C).users}</div><div className="mt-0.5 text-lg font-semibold tabular">{g.users}</div></div>
              <div><div className="text-xs text-subtle">{tr(C).inbounds}</div><div className="mt-0.5 text-lg font-semibold tabular">{g.inbound_ids.length}</div></div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {g.inbound_ids.map((id) => <Badge key={id}>{ibName.get(id) ?? `#${id}`}</Badge>)}
              {g.inbound_ids.length === 0 && <span className="text-xs text-warn">{t.noInbounds}</span>}
            </div>
            {!!g.sub_profile_id && <div className="mt-3 text-xs text-subtle">{t.routing}<a className="text-accent hover:underline" href={href('subscriptions', { tab: 'routing', profile: g.sub_profile_id })}>{pname.get(g.sub_profile_id) ?? g.sub_profile_id}</a></div>}
          </section>
        ))}
      </div>
      <Presence value={editing}>
        {(e, open) => <GroupForm isOpen={open} g={e === 'new' ? undefined : e} inbounds={inbounds.data ?? []} nodes={nodes.data ?? []} profiles={profiles.data ?? []} onClose={() => setEditing(null)} />}
      </Presence>
      <Confirm isOpen={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} danger title={t.deleteGroup} confirmLabel={t.deleteGroup}
        onConfirm={() => deleting && del.mutate(deleting.id)}
        body={t.deleteBody(delSticky?.name, delSticky?.users ?? 0, orphans > 0 ? orphans : null,
          (label) => <a className="text-accent underline" href={href('users', { g: delSticky?.id })}>{label}</a>)} />
    </>
  )
}

function GroupForm({ g, inbounds, nodes, profiles, onClose, isOpen }: { g?: Group; inbounds: Inbound[]; nodes: Node[]; profiles: ProfileMeta[]; onClose: () => void; isOpen: boolean }) {
  const t = useT(D)
  const c = useT(C)
  const [name, setName] = useState(g?.name ?? '')
  const [remark, setRemark] = useState(g?.remark ?? '')
  const [isDefault, setDefault] = useState(g?.is_default ?? false)
  const [ids, setIds] = useState<number[]>(g?.inbound_ids ?? [])
  const [profile, setProfile] = useState(String(g?.sub_profile_id ?? 0))
  const save = useAction({
    fn: () => {
      const body = { name, remark, is_default: isDefault, inbound_ids: ids, sub_profile_id: Number(profile) }
      return g ? api(`/groups/${g.id}`, { method: 'PATCH', body }) : api('/groups', { method: 'POST', body })
    },
    apply: true, success: t.savedX(name), invalidate: [['groups'], ['inbounds'], ['users']], onSuccess: onClose,
  })
  const dirty = name !== (g?.name ?? '') || remark !== (g?.remark ?? '') || isDefault !== (g?.is_default ?? false) || ids.join() !== (g?.inbound_ids ?? []).join() || profile !== String(g?.sub_profile_id ?? 0)
  const toggle = (id: number, v: boolean) => setIds(v ? [...ids, id] : ids.filter((x) => x !== id))
  return (
    <ModalDialog wide isOpen={isOpen} onOpenChange={(v) => !v && onClose()} title={g ? t.editX(g.name) : t.newGroup} dirty={dirty}
      footer={<><Button onPress={onClose}>{c.cancel}</Button><Button variant="primary" isPending={save.isPending} isDisabled={!name.trim()} onPress={() => save.mutate()}>{c.save}</Button></>}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={c.name} value={name} onChange={setName} autoFocus={!g} />
          <Field label={c.remark} value={remark} onChange={setRemark} />
        </div>
        <Switch isSelected={isDefault} onChange={setDefault}>{t.defaultSwitch}</Switch>
        <Select label={t.profileLabel} value={profile} onChange={setProfile}
          options={[{ id: '0', label: t.useDefault }, ...profiles.map((p) => ({ id: String(p.id), label: p.name + (p.is_default ? t.defaultSuffix : '') }))]}
          description={t.profileDesc} />
        <div>
          <div className="mb-2 flex items-center justify-between text-[13px] font-medium text-subtle">
            <span>{t.included(ids.length)}</span>
            <span className="flex gap-2">
              <Button size="sm" variant="ghost" onPress={() => setIds(inbounds.map((i) => i.id))}>{t.selectAll}</Button>
              <Button size="sm" variant="ghost" onPress={() => setIds([])}>{t.clear}</Button>
            </span>
          </div>
          {inbounds.length === 0 ? <div className="text-[13px] text-muted">{t.noInboundsYet}</div> : (
            <div className="flex max-h-[360px] flex-col gap-3 overflow-y-auto rounded-[12px] border bg-base p-3">
              {nodes.filter((n) => inbounds.some((i) => i.node_id === n.id)).map((n) => (
                <div key={n.id}>
                  <div className="mb-1.5 text-xs font-semibold text-subtle">{n.name}</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {inbounds.filter((i) => i.node_id === n.id).map((i) => (
                      <Checkbox key={i.id} isSelected={ids.includes(i.id)} onChange={(v) => toggle(i.id, v)}>
                        <span className="truncate">{i.tag} <span className="text-xs text-muted">{i.type} :{i.port}{i.enabled ? '' : t.stopped}</span></span>
                      </Checkbox>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </ModalDialog>
  )
}
