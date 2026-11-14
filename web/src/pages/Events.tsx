import { useQuery } from '@tanstack/react-query'
import { api, type Event } from '../lib/api'
import { dateTime } from '../lib/fmt'
import { Badge, Card, Empty, PageHeader, Skeleton } from '../ui/kit'

const kinds: Record<string, { tone: 'good' | 'warn' | 'bad' | 'neutral' | 'accent'; text: string }> = {
  node_enrolled: { tone: 'accent', text: '节点接入' },
  node_online: { tone: 'good', text: '节点上线' },
  node_offline: { tone: 'bad', text: '节点离线' },
  apply_failed: { tone: 'warn', text: '配置失败' },
  quota_exceeded: { tone: 'warn', text: '超额' },
  user_expired: { tone: 'bad', text: '到期' },
  users_expired: { tone: 'bad', text: '到期' },
  user_reactivated: { tone: 'good', text: '恢复' },
}

export function EventsPage() {
  const ev = useQuery({ queryKey: ['events'], queryFn: () => api<Event[]>('/events?limit=300'), refetchInterval: 10000 })
  return (
    <>
      <PageHeader title="事件" subtitle="节点上下线、配置下发失败、用户超额与到期" />
      <Card pad={false}>
        {ev.isLoading ? <div className="p-5"><Skeleton className="h-40" /></div> : ev.data?.length === 0 ? <Empty title="暂无事件" /> : (
          <ul>
            {ev.data?.map((e, i) => {
              const k = kinds[e.kind] ?? { tone: 'neutral' as const, text: e.kind }
              return (
                <li key={i} className="flex items-start gap-4 border-b px-5 py-3 text-[13px] last:border-0">
                  <span className="w-[92px] shrink-0 text-subtle tabular">{dateTime(e.ts)}</span>
                  <span className="w-[76px] shrink-0"><Badge tone={k.tone}>{k.text}</Badge></span>
                  <span className="min-w-0 flex-1">
                    {e.node && <span className="font-medium">{e.node}</span>}
                    {e.user && <a className="font-medium text-accent hover:underline" href={`#/users?id=${e.user_id}`}>{e.user}</a>}
                    {e.detail && <span className="ml-2 font-mono text-xs break-all text-muted">{e.detail}</span>}
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
