import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type User, type TopRow, type SeriesResp } from '../lib/api'
import { bytes, date, dateTime, parseSize, pct, ago } from '../lib/fmt'
import { useRoute, go } from '../lib/router'
import { Badge, Button, Card, Confirm, CopyText, Drawer, Empty, Field, ModalDialog, PageHeader, Progress, Segmented, Skeleton, Switch, useToast, cx } from '../ui/kit'
import { ShareList, TimeChart } from '../ui/charts'
import { IconPlus, IconSearch } from '../ui/icons'

const statusInfo: Record<string, { tone: 'good' | 'warn' | 'bad' | 'neutral'; text: string }> = {
  active: { tone: 'good', text: '正常' },
  limited: { tone: 'warn', text: '超额' },
  expired: { tone: 'bad', text: '已过期' },
}

function UserStatus({ u }: { u: User }) {
  if (!u.enabled) return <Badge tone="neutral" dot>已禁用</Badge>
  const s = statusInfo[u.status] ?? { tone: 'neutral', text: u.status }
  return <Badge tone={s.tone} dot>{s.text}</Badge>
}

export function UsersPage() {
  const { params } = useRoute()
  const openId = params.get('id')
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<User[]>('/users'), refetchInterval: 10000 })
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'online' | 'problem'>('all')
  const [creating, setCreating] = useState(false)

  const rows = useMemo(() => (users.data ?? []).filter((u) =>
    (!q || u.username.toLowerCase().includes(q.toLowerCase()) || u.note.toLowerCase().includes(q.toLowerCase())) &&
    (filter === 'all' || (filter === 'online' ? u.online_ips > 0 : !u.enabled || u.status !== 'active'))), [users.data, q, filter])

  return (
    <>
      <PageHeader title="用户" subtitle="流量额度、到期时间和在线设备。超额或到期的用户会在几秒内从所有节点移除并断线"
        actions={<Button variant="primary" onPress={() => setCreating(true)}><IconPlus size={16} />新建用户</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="relative">
          <IconSearch size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索用户名或备注" aria-label="搜索用户"
            className="h-9 w-64 rounded-full border bg-surface pr-3 pl-9 text-sm outline-none focus:border-accent" />
        </label>
        <Segmented label="筛选" value={filter} onChange={setFilter}
          options={[{ id: 'all', label: '全部' }, { id: 'online', label: '在线' }, { id: 'problem', label: '超额/过期/禁用' }]} />
      </div>
      <Card pad={false}>
        {users.isLoading ? <div className="p-5"><Skeleton className="h-40" /></div> : rows.length === 0 ? (
          <Empty title={users.data?.length ? '没有匹配的用户' : '还没有用户'} hint={users.data?.length ? undefined : '新建用户后，它会被下发到所有节点的所有入站'}
            action={users.data?.length ? undefined : <Button variant="primary" onPress={() => setCreating(true)}>新建用户</Button>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-xs text-subtle">
                <tr className="border-b">
                  <th className="px-5 py-2.5 font-medium">用户</th><th className="px-3 py-2.5 font-medium">状态</th>
                  <th className="w-[260px] px-3 py-2.5 font-medium">本期用量</th><th className="px-3 py-2.5 font-medium">到期</th>
                  <th className="px-3 py-2.5 font-medium">在线</th><th className="hidden px-5 py-2.5 text-right font-medium lg:table-cell">累计</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => {
                  const used = u.used_up + u.used_down
                  return (
                    <tr key={u.id} onClick={() => go('users', { id: u.id })} className="cursor-pointer border-b last:border-0 hover:bg-hl-low">
                      <td className="px-5 py-3"><div className="font-medium">{u.username}</div>{u.note && <div className="max-w-[220px] truncate text-xs text-muted">{u.note}</div>}</td>
                      <td className="px-3 py-3"><UserStatus u={u} /></td>
                      <td className="px-3 py-3">
                        <div className="mb-1 flex justify-between text-xs tabular"><span>{bytes(used)}</span><span className="text-muted">{u.traffic_limit ? bytes(u.traffic_limit, 0) : '不限'}</span></div>
                        <Progress value={u.traffic_limit ? pct(used, u.traffic_limit) : 0} />
                      </td>
                      <td className={cx('px-3 py-3 tabular', u.expire_at > 0 && u.expire_at * 1000 < Date.now() + 3 * 86400e3 && 'text-warn')}>{u.expire_at ? date(u.expire_at) : '永久'}</td>
                      <td className="px-3 py-3">{u.online_ips > 0 ? <Badge tone="good">{u.online_ips} 设备</Badge> : <span className="text-muted">—</span>}</td>
                      <td className="hidden px-5 py-3 text-right text-subtle tabular lg:table-cell">{bytes(u.life_up + u.life_down)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && <CreateUser onClose={() => setCreating(false)} />}
      {openId && <UserDrawer id={Number(openId)} onClose={() => go('users')} />}
    </>
  )
}

function CreateUser({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [username, setUsername] = useState('')
  const [limit, setLimit] = useState('')
  const [days, setDays] = useState('')
  const [note, setNote] = useState('')
  const create = useMutation({
    mutationFn: () => {
      const l = limit.trim() ? parseSize(limit) : 0
      if (Number.isNaN(l)) throw new Error('流量格式不对，例如 100 或 1.5T')
      const d = days.trim() ? Number(days) : 0
      return api<{ id: number }>('/users', { method: 'POST', body: { username, traffic_limit: l, expire_at: d > 0 ? Math.floor(Date.now() / 1000 + d * 86400) : 0, note } })
    },
    onSuccess: (r) => { toast('good', '用户已创建，正在下发到节点'); qc.invalidateQueries({ queryKey: ['users'] }); onClose(); go('users', { id: r.id }) },
    onError: (e) => toast('bad', (e as Error).message),
  })
  return (
    <ModalDialog isOpen onOpenChange={(v) => !v && onClose()} title="新建用户"
      footer={<><Button onPress={onClose}>取消</Button><Button variant="primary" isDisabled={!username || create.isPending} onPress={() => create.mutate()}>创建</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="用户名" value={username} onChange={setUsername} autoFocus description="字母、数字、. _ @ -" />
        <div className="grid grid-cols-2 gap-4">
          <Field label="流量额度（GB）" value={limit} onChange={setLimit} placeholder="不限" description="支持 500 / 1.5T / 800M" />
          <Field label="有效天数" value={days} onChange={setDays} placeholder="永久" />
        </div>
        <Field label="备注" value={note} onChange={setNote} />
      </div>
    </ModalDialog>
  )
}

type UserDetail = { user: User; ips: { ip: string; node: string; first_seen: number; last_seen: number; online: boolean }[] }

function UserDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const d = useQuery({ queryKey: ['user', id], queryFn: () => api<UserDetail>(`/users/${id}`), refetchInterval: 10000 })
  const from = Math.floor(Date.now() / 1000) - 7 * 86400
  const series = useQuery({ queryKey: ['series', 'user', id], queryFn: () => api<SeriesResp>(`/traffic/series?step=3600&group=total&user=${id}&from=${from}`) })
  const domains = useQuery({ queryKey: ['top', 'domain', 'user', id], queryFn: () => api<TopRow[]>(`/traffic/top?dim=domain&user=${id}&from=${from}&limit=12`) })
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState<'' | 'delete' | 'rotate' | 'reset'>('')
  const patch = useMutation({
    mutationFn: (body: object) => api(`/users/${id}`, { method: 'PATCH', body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); qc.invalidateQueries({ queryKey: ['user', id] }); toast('good', '已更新') },
    onError: (e) => toast('bad', (e as Error).message),
  })
  const remove = useMutation({
    mutationFn: () => api(`/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); toast('good', '用户已删除'); onClose() },
  })
  const kick = useMutation({ mutationFn: () => api(`/users/${id}/kick`, { method: 'POST' }), onSuccess: () => toast('good', '已断开该用户的所有连接') })

  const u = d.data?.user
  const s = series.data?.series[0]
  return (
    <Drawer isOpen onOpenChange={(v) => !v && onClose()} title={u ? <span className="flex items-center gap-2">{u.username}<UserStatus u={u} /></span> : '用户'}>
      {!u ? <Skeleton className="h-64" /> : (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-3">
            <Box label="本期已用" value={bytes(u.used_up + u.used_down)} sub={u.traffic_limit ? `额度 ${bytes(u.traffic_limit)} · ${pct(u.used_up + u.used_down, u.traffic_limit).toFixed(1)}%` : '不限额度'} />
            <Box label="到期" value={u.expire_at ? date(u.expire_at) : '永久'} sub={`创建于 ${date(u.created_at)}`} />
            <Box label="下行 / 上行" value={`${bytes(u.used_down)} / ${bytes(u.used_up)}`} sub={`累计 ${bytes(u.life_down + u.life_up)}`} />
            <Box label="在线设备" value={String(u.online_ips)} sub="按来源 IP 计" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Switch isSelected={u.enabled} onChange={(v) => patch.mutate({ enabled: v })}>启用</Switch>
            <div className="flex-1" />
            <Button size="sm" onPress={() => setEditing(true)}>编辑额度</Button>
            <Button size="sm" onPress={() => setConfirm('reset')}>重置用量</Button>
            <Button size="sm" onPress={() => kick.mutate()}>断开连接</Button>
            <Button size="sm" onPress={() => setConfirm('rotate')}>更换密钥</Button>
            <Button size="sm" variant="danger" onPress={() => setConfirm('delete')}>删除</Button>
          </div>

          <Card title="近 7 天流量（每小时）">
            {s ? <TimeChart height={180} step={3600} times={s.points.map((p) => p[0])}
              series={[{ key: 'down', label: '下行', values: s.points.map((p) => p[2]), color: 'var(--s1)' }, { key: 'up', label: '上行', values: s.points.map((p) => p[1]), color: 'var(--s2)' }]} />
              : series.data ? <div className="py-8 text-center text-[13px] text-muted">近 7 天没有流量</div> : <Skeleton className="h-[180px]" />}
          </Card>

          <Card title="访问的域名（7 天）">
            <ShareList mono rows={(domains.data ?? []).map((r) => ({ key: r.key, label: r.label, value: r.up + r.down }))}
              onSelect={(k) => go('traffic', { user: id, dim: 'host', q: k, range: '7d' })} />
          </Card>

          <Card title="来源 IP" pad={false}>
            <table className="w-full text-[13px]">
              <thead className="text-left text-xs text-subtle"><tr className="border-b"><th className="px-5 py-2 font-medium">IP</th><th className="px-3 py-2 font-medium">节点</th><th className="px-3 py-2 font-medium">首次</th><th className="px-5 py-2 font-medium">最近</th></tr></thead>
              <tbody>
                {d.data!.ips.map((x) => (
                  <tr key={x.ip + x.node} className="border-b last:border-0">
                    <td className="px-5 py-2 font-mono text-[12.5px]"><span className={cx('mr-2 inline-block h-1.5 w-1.5 rounded-full', x.online ? 'bg-good' : 'bg-hl-high')} />{x.ip}</td>
                    <td className="px-3 py-2">{x.node}</td>
                    <td className="px-3 py-2 tabular text-subtle">{dateTime(x.first_seen)}</td>
                    <td className="px-5 py-2 tabular text-subtle">{x.online ? '在线' : ago(x.last_seen)}</td>
                  </tr>
                ))}
                {d.data!.ips.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-muted">还没有连接记录</td></tr>}
              </tbody>
            </table>
          </Card>

          <Card title="凭据">
            <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-2 text-[13px]">
              <dt className="text-subtle">UUID</dt><dd className="min-w-0"><CopyText text={u.uuid} /></dd>
              <dt className="text-subtle">密码</dt><dd className="min-w-0"><CopyText text={u.password ?? ''} display="••••••••（点击复制）" /></dd>
              <dt className="text-subtle">订阅令牌</dt><dd className="min-w-0"><CopyText text={u.sub_token} /></dd>
            </dl>
            <p className="mt-3 text-xs text-muted">订阅链接将在 M2 提供（按客户端自动输出 sing-box / mihomo / URI 格式）。</p>
          </Card>
        </div>
      )}
      {editing && u && <EditQuota u={u} onClose={() => setEditing(false)} onSave={(b) => { patch.mutate(b); setEditing(false) }} />}
      <Confirm isOpen={confirm === 'delete'} onOpenChange={(v) => !v && setConfirm('')} danger title="删除用户" confirmLabel="删除"
        onConfirm={() => remove.mutate()} body={<>删除 <b className="text-text">{u?.username}</b> 会立刻从所有节点移除并断线。历史流量记录保留。</>} />
      <Confirm isOpen={confirm === 'rotate'} onOpenChange={(v) => !v && setConfirm('')} title="更换密钥" confirmLabel="更换"
        onConfirm={() => patch.mutate({ rotate_secrets: true })} body="UUID、密码和订阅令牌都会重新生成，旧的客户端配置和订阅链接立即失效。" />
      <Confirm isOpen={confirm === 'reset'} onOpenChange={(v) => !v && setConfirm('')} title="重置本期用量" confirmLabel="重置"
        onConfirm={() => patch.mutate({ reset_usage: true })} body="本期已用流量清零（累计用量和历史统计不变）。超额的用户会恢复正常。" />
    </Drawer>
  )
}

function Box({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[12px] border bg-base p-3">
      <div className="text-xs text-subtle">{label}</div>
      <div className="mt-1 text-[17px] font-semibold tabular">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted tabular">{sub}</div>}
    </div>
  )
}

function EditQuota({ u, onClose, onSave }: { u: User; onClose: () => void; onSave: (b: object) => void }) {
  const [limit, setLimit] = useState(u.traffic_limit ? String(+(u.traffic_limit / 1024 ** 3).toFixed(2)) : '')
  const [exp, setExp] = useState(u.expire_at ? new Date(u.expire_at * 1000).toISOString().slice(0, 10) : '')
  const [note, setNote] = useState(u.note)
  const toast = useToast()
  return (
    <ModalDialog isOpen onOpenChange={(v) => !v && onClose()} title="编辑额度"
      footer={<><Button onPress={onClose}>取消</Button><Button variant="primary" onPress={() => {
        const l = limit.trim() ? parseSize(limit) : 0
        if (Number.isNaN(l)) { toast('bad', '流量格式不对'); return }
        const e = exp ? Math.floor(new Date(exp + 'T23:59:59').getTime() / 1000) : 0
        onSave({ traffic_limit: l, expire_at: e, note })
      }}>保存</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="流量额度（GB，留空不限）" value={limit} onChange={setLimit} />
        <Field label="到期日期（留空永久）" type="date" value={exp} onChange={setExp} />
        <Field label="备注" value={note} onChange={setNote} />
      </div>
    </ModalDialog>
  )
}
