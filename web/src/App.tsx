import { useEffect, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './lib/api'
import { useRoute, href } from './lib/router'
import { cx, IconButton } from './ui/kit'
import { IconOverview, IconChart, IconServer, IconPlug, IconUsers, IconBell, IconSun, IconMoon, IconLogout } from './ui/icons'
import { Login } from './pages/Login'
import { OverviewPage } from './pages/Overview'
import { TrafficPage } from './pages/Traffic'
import { NodesPage } from './pages/Nodes'
import { InboundsPage } from './pages/Inbounds'
import { UsersPage } from './pages/Users'
import { EventsPage } from './pages/Events'

type NavItem = { id: string; label: string; icon: ReactNode; el: () => ReactNode }
const groups: { label: string; items: NavItem[] }[] = [
  {
    label: '观测', items: [
      { id: 'overview', label: '概览', icon: <IconOverview />, el: () => <OverviewPage /> },
      { id: 'traffic', label: '流量分析', icon: <IconChart />, el: () => <TrafficPage /> },
      { id: 'events', label: '事件', icon: <IconBell />, el: () => <EventsPage /> },
    ],
  },
  {
    label: '管理', items: [
      { id: 'users', label: '用户', icon: <IconUsers />, el: () => <UsersPage /> },
      { id: 'nodes', label: '节点', icon: <IconServer />, el: () => <NodesPage /> },
      { id: 'inbounds', label: '入站', icon: <IconPlug />, el: () => <InboundsPage /> },
    ],
  },
]
const allItems = groups.flatMap((g) => g.items)

function useTheme() {
  const [theme, setTheme] = useState<string>(() => {
    try { return localStorage.getItem('sbp-theme') ?? '' } catch { return '' }
  })
  const dark = theme ? theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
  const toggle = () => {
    const next = dark ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try { localStorage.setItem('sbp-theme', next) } catch { /* private mode */ }
    setTheme(next)
  }
  return { dark, toggle }
}

export function App() {
  const qc = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<{ username: string }>('/auth/me'), retry: false })
  const route = useRoute()
  const { dark, toggle } = useTheme()

  useEffect(() => {
    const on = () => qc.setQueryData(['me'], null)
    window.addEventListener('sbp:unauthorized', on)
    return () => window.removeEventListener('sbp:unauthorized', on)
  }, [qc])

  useEffect(() => {
    // g + key page jumps, as in doona
    let armed = 0
    const keys: Record<string, string> = { o: 'overview', t: 'traffic', e: 'events', u: 'users', n: 'nodes', i: 'inbounds' }
    const on = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'g') { armed = Date.now(); return }
      if (Date.now() - armed < 800 && keys[e.key]) { location.hash = href(keys[e.key]); armed = 0 }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  if (me.isLoading) return null
  if (!me.data) return <Login onDone={() => qc.invalidateQueries()} />

  const current = allItems.find((i) => i.id === route.page) ?? allItems[0]
  const logout = async () => { await api('/auth/logout', { method: 'POST' }); qc.setQueryData(['me'], null) }

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-30 border-b bg-base/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-4 lg:px-6">
          <a href={href('overview')} className="flex items-center gap-2.5 font-semibold outline-none">
            <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-accent text-on-accent">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M5 16c3-9 11-9 14 0" /><circle cx="12" cy="17" r="1.6" fill="currentColor" /></svg>
            </span>
            <span className="text-[15px]">sbpanel</span>
            <span className="hidden rounded-full bg-overlay px-2 py-0.5 text-[11px] font-medium text-subtle sm:inline">sing-box</span>
          </a>
          <div className="flex-1" />
          <span className="hidden text-[13px] text-subtle sm:inline">{me.data.username}</span>
          <IconButton label={dark ? '切换到浅色' : '切换到深色'} onPress={toggle}>{dark ? <IconSun /> : <IconMoon />}</IconButton>
          <IconButton label="退出登录" onPress={logout}><IconLogout /></IconButton>
        </div>
      </header>
      <div className="mx-auto flex max-w-[1600px]">
        <nav aria-label="主导航" className="sticky top-14 hidden h-[calc(100vh-56px)] w-[240px] shrink-0 flex-col gap-5 overflow-y-auto px-3 py-5 lg:flex">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="px-3 pb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">{g.label}</div>
              <ul className="flex flex-col gap-0.5">
                {g.items.map((it) => {
                  const active = it.id === current.id
                  return (
                    <li key={it.id}>
                      <a href={href(it.id)} aria-current={active ? 'page' : undefined}
                        className={cx('relative flex h-9 items-center gap-3 rounded-[8px] px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent',
                          active ? 'bg-[color-mix(in_srgb,var(--accent)_10%,var(--overlay))] font-medium text-text' : 'text-subtle hover:bg-overlay hover:text-text')}>
                        {active && <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-full bg-accent" />}
                        <span className={active ? 'text-accent' : ''}>{it.icon}</span>{it.label}
                      </a>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
          <div className="mt-auto px-3 text-[11px] text-muted">按 <kbd className="rounded bg-overlay px-1">g</kbd> + 首字母跳转页面</div>
        </nav>
        <main className="min-w-0 flex-1 px-4 pt-5 pb-24 lg:px-6 lg:pb-10">
          <div key={current.id} className="animate-fade">{current.el()}</div>
        </main>
      </div>
      <nav aria-label="底部导航" className="fixed inset-x-0 bottom-0 z-30 flex border-t bg-surface/95 backdrop-blur lg:hidden">
        {allItems.map((it) => (
          <a key={it.id} href={href(it.id)} aria-current={it.id === current.id ? 'page' : undefined}
            className={cx('flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]', it.id === current.id ? 'text-accent' : 'text-subtle')}>
            {it.icon}{it.label}
          </a>
        ))}
      </nav>
    </div>
  )
}
