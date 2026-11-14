import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Event, type AuditRow } from '../lib/api'
import { dateTime } from '../lib/fmt'
import { Badge, Card, Empty, PageHeader, RelTime, Skeleton, Tabs } from '../ui/kit'

const kinds: Record<string, { tone: 'good' | 'warn' | 'bad' | 'neutral' | 'accent'; text: string }> = {
  node_enrolled: { tone: 'accent', text: '节点接入' },
  node_online: { tone: 'good', text: '节点上线' },
  node_offline: { tone: 'bad', text: '节点离线' },
  apply_failed: { tone: 'warn', text: '配置失败' },
  quota_exceeded: { tone: 'warn', text: '超额' },
  user_expired: { tone: 'bad', text: '到期' },
  users_expired: { tone: 'bad', text: '到期' },
  user_reactivated: { tone: 'good', text: '恢复' },
  node_quota: { tone: 'warn', text: '节点流量' },
  device_limit: { tone: 'warn', text: '设备超限' },
  usage_reset: { tone: 'neutral', text: '用量重置' },
  cert_renewed: { tone: 'good', text: '证书续期' },
  cert_renew_failed: { tone: 'bad', text: '续期失败' },
  cert_expiring: { tone: 'warn', text: '证书将过期' },
  inbound_unreachable: { tone: 'bad', text: '入站不可达' },
  inbound_recovered: { tone: 'good', text: '入站恢复' },
}

export function EventsPage() {
  const [tab, setTab] = useState<'events' | 'audit'>('events')
  return (
    <>
      <PageHeader title="事件与审计" subtitle="系统事件（节点上下线、下发失败、超额、到期）和管理员操作记录" />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'events', label: '系统事件' }, { id: 'audit', label: '操作审计' }]} />
      {tab === 'events' ? <EventList /> : <AuditList />}
    </>
  )
}

function AuditList() {
  const a = useQuery({ queryKey: ['audit'], queryFn: () => api<AuditRow[]>('/audit?limit=300'), refetchInterval: 15000 })
  return (
    <Card pad={false}>
      {a.isLoading ? <div className="p-5"><Skeleton className="h-40" /></div> : a.data?.length === 0 ? <Empty title="暂无记录" /> : (
        <>
        <ul className="sm:hidden">
          {a.data?.map((x, i) => (
            <li key={i} className="flex flex-col gap-1 border-b px-4 py-3 text-[13px] last:border-0">
              <div className="flex items-center justify-between gap-2">
                <Badge tone={x.action === 'login.failed' ? 'bad' : x.action.endsWith('delete') ? 'warn' : 'neutral'}>{x.action}</Badge>
                <span className="text-xs text-subtle tabular"><RelTime ts={x.ts} text={dateTime(x.ts)} /></span>
              </div>
              <div className="min-w-0 truncate font-mono text-xs text-subtle">{[x.target, x.detail].filter(Boolean).join(' · ') || '—'}</div>
              <div className="text-xs text-muted">{x.admin} · {x.ip}</div>
            </li>
          ))}
        </ul>
        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full text-[13px] whitespace-nowrap">
            <thead className="text-left text-xs text-subtle"><tr className="border-b"><th className="px-5 py-2 font-medium">时间</th><th className="px-3 py-2 font-medium">操作人</th><th className="px-3 py-2 font-medium">操作</th><th className="px-3 py-2 font-medium">对象</th><th className="px-5 py-2 font-medium">来源 IP</th></tr></thead>
            <tbody>
              {a.data?.map((x, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="px-5 py-2 whitespace-nowrap text-subtle tabular">{dateTime(x.ts)}</td>
                  <td className="px-3 py-2">{x.admin}</td>
                  <td className="px-3 py-2"><Badge tone={x.action === 'login.failed' ? 'bad' : x.action.endsWith('delete') ? 'warn' : 'neutral'}>{x.action}</Badge></td>
                  <td className="max-w-[320px] truncate px-3 py-2 font-mono text-xs text-subtle" title={x.detail}>{[x.target, x.detail].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="px-5 py-2 font-mono text-xs">{x.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
    </Card>
  )
}

function EventList() {
  const ev = useQuery({ queryKey: ['events'], queryFn: () => api<Event[]>('/events?limit=300'), refetchInterval: 10000 })
  return (
    <>
      <Card pad={false}>
        {ev.isLoading ? <div className="p-5"><Skeleton className="h-40" /></div> : ev.data?.length === 0 ? <Empty title="暂无事件" /> : (
          <ul>
            {ev.data?.map((e, i) => {
              const k = kinds[e.kind] ?? { tone: 'neutral' as const, text: e.kind }
              return (
                <li key={i} className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1 border-b px-4 py-3 text-[13px] last:border-0 sm:flex sm:gap-4 sm:px-5">
                  <span className="shrink-0 sm:order-2 sm:w-[76px]"><Badge tone={k.tone}>{k.text}</Badge></span>
                  <span className="self-center text-right text-xs text-subtle tabular sm:order-1 sm:w-[92px] sm:shrink-0 sm:text-left sm:text-[13px]"><RelTime ts={e.ts} text={dateTime(e.ts)} /></span>
                  <span className="col-span-2 min-w-0 flex-1 sm:order-3">
                    {e.node && <span className="font-medium">{e.node}</span>}
                    {e.node && e.user && <span className="mx-1.5 text-muted">·</span>}
                    {e.user && <a className="font-medium text-accent hover:underline" href={`#/users?id=${e.user_id}`}>{e.user}</a>}
                    {e.detail && <span className="mt-0.5 block font-mono text-xs break-all text-muted sm:mt-0 sm:ml-2 sm:inline">{e.detail}</span>}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </>
  )
}
