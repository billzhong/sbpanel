import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileTrigger } from 'react-aria-components'
import { useAction } from '../lib/actions'
import { api, type ImportReport, type Node, type Settings } from '../lib/api'
import { useRoute, href } from '../lib/router'
import { Badge, Button, Callout, Card, Checkbox, Confirm, CopyText, Field, IconButton, ModalDialog, PageHeader, Select, cx, useIndicator, useToast } from '../ui/kit'
import { AppearanceSettings } from './settings/Appearance'
import { ApiAgents } from './settings/ApiAgents'
import { ApiDocs } from './settings/ApiDocs'

// ---- one scrolling page, section nav (vertical by default, horizontal below 1024px or by choice) ----

type IconC = (p: { size?: number; className?: string }) => ReactNode
const Svg = ({ size = 18, className, children }: { size?: number; className?: string; children: ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>{children}</svg>
)
const IconShield: IconC = (p) => <Svg {...p}><path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.3 7.5 9.5 4.4-1.2 7.5-4.9 7.5-9.5V6z" /><path d="m9 12 2 2 4-4" /></Svg>
const IconPalette: IconC = (p) => <Svg {...p}><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.8-1.9 0-.5-.2-.9-.5-1.3-.3-.3-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3z" /><circle cx="7.5" cy="11.5" r="1" /><circle cx="10" cy="7.5" r="1" /><circle cx="15" cy="7.5" r="1" /></Svg>
const IconBellS: IconC = (p) => <Svg {...p}><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10 21a2 2 0 0 0 4 0" /></Svg>
const IconSliders: IconC = (p) => <Svg {...p}><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" /><circle cx="15" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="18" r="2" /></Svg>
const IconArchive: IconC = (p) => <Svg {...p}><ellipse cx="12" cy="5.5" rx="8" ry="2.5" /><path d="M4 5.5v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-6" /><path d="M4 11.5v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-6" /></Svg>
const IconImport: IconC = (p) => <Svg {...p}><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /><path d="M12 3v11M8 10l4 4 4-4" /></Svg>
const IconAgent: IconC = (p) => <Svg {...p}><rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 7V4M9 3h6" /><circle cx="9" cy="13" r="1.2" /><circle cx="15" cy="13" r="1.2" /><path d="M2 12v2M22 12v2" /></Svg>
const IconNavSide: IconC = (p) => <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16" /></Svg>
const IconNavTop: IconC = (p) => <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 9h18" /></Svg>

type SectionId = 'account' | 'api' | 'appearance' | 'notify' | 'policy' | 'backup' | 'import'
const SECTIONS: { id: SectionId; label: string; desc: string; icon: IconC; el: () => ReactNode }[] = [
  { id: 'account', label: '账户与安全', desc: '登录密码和两步验证', icon: IconShield, el: () => <Account /> },
  { id: 'api', label: 'API 与智能体', desc: '带权限的 API 密钥、MCP 智能体接入与接口文档', icon: IconAgent, el: () => <ApiAgents /> },
  { id: 'appearance', label: '外观', desc: '面板配色、强调色、圆角与密度', icon: IconPalette, el: () => <AppearanceSettings /> },
  { id: 'notify', label: '通知', desc: 'Telegram / Webhook 渠道与事件', icon: IconBellS, el: () => <Notify /> },
  { id: 'policy', label: '策略', desc: '设备数策略、数据保留与节点接入', icon: IconSliders, el: () => <Policy /> },
  { id: 'backup', label: '备份与恢复', desc: '下载数据库与恢复步骤', icon: IconArchive, el: () => <Backup /> },
  { id: 'import', label: '从 3x-ui 迁移', desc: '导入 3x-ui 的入站和用户', icon: IconImport, el: () => <Import /> },
]
const isSection = (v: string | null): v is SectionId => SECTIONS.some((x) => x.id === v)
// Old ?tab= links (and the removed 订阅页 tab) map onto sections.
const LEGACY_TAB: Record<string, SectionId> = { account: 'account', api: 'api', tokens: 'api', appearance: 'appearance', subpage: 'appearance', notify: 'notify', policy: 'policy', backup: 'backup', import: 'import' }

const NAV_KEY = 'sbp-settings-nav'
type NavPref = 'vertical' | 'horizontal'
function readNavPref(): NavPref {
  try { return localStorage.getItem(NAV_KEY) === 'horizontal' ? 'horizontal' : 'vertical' } catch { return 'vertical' }
}
function useMedia(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches)
  useEffect(() => { const mq = window.matchMedia(q); const on = () => setM(mq.matches); mq.addEventListener('change', on); return () => mq.removeEventListener('change', on) }, [q])
  return m
}
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const HEADER = 56

function sectionFromURL(params: URLSearchParams): SectionId | null {
  const s = params.get('s')
  if (isSection(s)) return s
  const t = params.get('tab')
  return t ? LEGACY_TAB[t] ?? null : null
}

export function SettingsPage() {
  const { params } = useRoute()
  // 设置 → API 与智能体 → API 文档 is a sub-view of this page (#/settings?view=api-docs)
  return params.get('view') === 'api-docs' ? <ApiDocs /> : <SettingsSections />
}

function SettingsSections() {
  const { params } = useRoute()
  const wide = useMedia('(min-width: 1024px)')
  const [pref, setPref] = useState<NavPref>(readNavPref)
  const layout: NavPref = wide ? pref : 'horizontal'
  const [active, setActive] = useState<SectionId>(() => sectionFromURL(params) ?? 'account')
  const [pulse, setPulse] = useState<{ id: SectionId; n: number } | null>(null)
  const locked = useRef(false)
  const barRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef(active)
  activeRef.current = active

  // Distance from the viewport top where a section header should land (sticky app header + horizontal bar).
  const offset = () => HEADER + (layout === 'horizontal' ? (barRef.current?.offsetHeight ?? 52) : 0) + 16

  const writeURL = (id: SectionId) => history.replaceState(null, '', href('settings', { s: id }))

  /** Scrolls to a section; the scroll-spy is locked until the scroll settles so it does not flicker. */
  const scrollTo = useCallback((id: SectionId, animate: boolean) => {
    const el = document.getElementById(`set-${id}`)
    if (!el) return
    const smooth = animate && !reducedMotion()
    locked.current = true
    setActive(id)
    writeURL(id)
    const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0
    const arrived = () => Math.abs(el.getBoundingClientRect().top - margin) < 2 ||
      window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2
    let finished = false
    const done = () => {
      if (finished) return
      finished = true
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('scrollend', done)
      clearTimeout(max)
      // A smooth scroll can be cut short (throttled or interrupted tab): land exactly anyway.
      if (!arrived()) el.scrollIntoView({ behavior: 'auto', block: 'start' })
      requestAnimationFrame(() => { locked.current = false })
      if (smooth) setPulse((p) => ({ id, n: (p?.n ?? 0) + 1 }))
    }
    const onScroll = () => { if (arrived()) done() }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('scrollend', done)
    const max = window.setTimeout(done, 1200)
    el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' })
    if (arrived()) done()
  }, [])

  // Deep link on first load (?s= or legacy ?tab=): jump without animation. Runs after the app's
  // scroll-to-top on page change, and once more after the first data render settles the layout.
  useEffect(() => {
    const id = sectionFromURL(params)
    if (params.get('tab')) writeURL(id ?? 'account')
    if (!id || id === 'account') return
    const r = requestAnimationFrame(() => scrollTo(id, false))
    const t = setTimeout(() => { if (activeRef.current === id) scrollTo(id, false) }, 350)
    return () => { cancelAnimationFrame(r); clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // In-app navigation to another section while already on this page (⌘K, links): smooth scroll.
  const wanted = sectionFromURL(params)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    if (wanted && wanted !== activeRef.current) scrollTo(wanted, true)
  }, [wanted, scrollTo])

  // Scroll-spy: the active section is the last one whose top has passed the anchor line.
  useEffect(() => {
    const els = SECTIONS.map((x) => document.getElementById(`set-${x.id}`)).filter(Boolean) as HTMLElement[]
    let raf = 0
    const pick = () => {
      raf = 0
      if (locked.current) return
      const line = offset() + 8
      let cur: SectionId = SECTIONS[0].id
      for (const el of els) if (el.getBoundingClientRect().top <= line) cur = el.id.slice(4) as SectionId
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) cur = SECTIONS[SECTIONS.length - 1].id
      if (cur !== activeRef.current) { setActive(cur); writeURL(cur) }
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(pick) }
    const io = new IntersectionObserver(schedule, { rootMargin: `-${offset()}px 0px 0px 0px`, threshold: [0, 0.25, 0.5, 0.75, 1] })
    els.forEach((el) => io.observe(el))
    window.addEventListener('scroll', schedule, { passive: true })
    return () => { io.disconnect(); window.removeEventListener('scroll', schedule); cancelAnimationFrame(raf) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout])

  // Switching nav mode keeps the current section in view.
  const prevLayout = useRef(layout)
  useEffect(() => {
    if (prevLayout.current === layout) return
    prevLayout.current = layout
    const id = activeRef.current
    requestAnimationFrame(() => scrollTo(id, false))
  }, [layout, scrollTo])

  const togglePref = () => {
    const next: NavPref = pref === 'vertical' ? 'horizontal' : 'vertical'
    try { localStorage.setItem(NAV_KEY, next) } catch { /* storage blocked */ }
    setPref(next)
  }

  const nav = <SectionNav orientation={layout} active={active} onSelect={(id) => scrollTo(id, true)} />
  const marginTop = layout === 'horizontal' ? HEADER + 52 + 16 : HEADER + 16
  return (
    <>
      <PageHeader title="设置" subtitle="账户安全、API 与智能体、面板外观、通知、策略、备份与迁移" actions={
        <span className="hidden lg:inline-flex">
          <IconButton label="导航：竖版 / 横版" onPress={togglePref}>
            <span title="导航：竖版 / 横版" className="inline-flex">{pref === 'vertical' ? <IconNavTop size={18} /> : <IconNavSide size={18} />}</span>
          </IconButton>
        </span>
      } />
      <div className={cx('min-w-0', layout === 'vertical' && 'grid grid-cols-[200px_minmax(0,1fr)] gap-6')}>
        {layout === 'vertical' ? (
          <div key="v" className="animate-page-in"><div className="sticky top-[72px]">{nav}</div></div>
        ) : (
          <div key="h" ref={barRef} className="animate-page-in sticky top-14 z-20 -mx-1 mb-2 min-w-0 bg-base/90 px-1 py-2 backdrop-blur">{nav}</div>
        )}
        <div className="flex min-w-0 flex-col gap-10">
          {SECTIONS.map((x) => (
            <section key={x.id} id={`set-${x.id}`} aria-labelledby={`set-${x.id}-h`} style={{ scrollMarginTop: marginTop }} className="min-w-0">
              <header key={pulse?.id === x.id ? pulse.n : 0}
                className={cx('-mx-2 mb-4 flex items-center gap-3 rounded-[12px] px-2 py-1.5', pulse?.id === x.id && 'animate-[rp-flash_600ms_var(--ease-out)_both]')}>
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-accent/12 text-accent"><x.icon size={18} /></span>
                <div className="min-w-0">
                  <h2 id={`set-${x.id}-h`} className="text-[16px] leading-6 font-semibold">{x.label}</h2>
                  <p className="truncate text-[13px] text-subtle">{x.desc}</p>
                </div>
              </header>
              {x.el()}
            </section>
          ))}
        </div>
      </div>
    </>
  )
}

/** The section nav, shared by both layouts: vertical list with a sliding bar, or a horizontal scrollable tab bar with a sliding pill. */
function SectionNav({ orientation, active, onSelect }: { orientation: NavPref; active: SectionId; onSelect: (id: SectionId) => void }) {
  const [ref, ind] = useIndicator<HTMLElement>('[aria-current=true]', active + orientation)
  const vertical = orientation === 'vertical'
  // Keep the active chip visible in the horizontal bar without moving the page.
  useEffect(() => {
    if (vertical) return
    const nav = ref.current, a = nav?.querySelector<HTMLElement>('[aria-current=true]')
    if (nav && a) nav.scrollTo({ left: a.offsetLeft - nav.clientWidth / 2 + a.offsetWidth / 2, behavior: reducedMotion() ? 'auto' : 'smooth' })
  }, [active, vertical, ref])
  return (
    <nav ref={ref} aria-label="设置分区"
      className={cx('relative', vertical ? 'flex flex-col gap-0.5' : 'no-scrollbar flex gap-1 overflow-x-auto')}>
      {ind && (vertical
        ? <span aria-hidden className={cx('pointer-events-none absolute top-0 left-0 z-10 w-[3px] rounded-full bg-accent', ind.ready && 'rp-slide')} style={{ transform: `translateY(${ind.y + 8}px)`, height: ind.h - 16 }} />
        : <span aria-hidden className={cx('pointer-events-none absolute top-0 left-0 rounded-full bg-overlay', ind.ready && 'rp-slide')} style={{ transform: `translate(${ind.x}px, ${ind.y}px)`, width: ind.w, height: ind.h }} />)}
      {SECTIONS.map((x) => {
        const on = x.id === active
        return (
          <a key={x.id} href={href('settings', { s: x.id })} aria-current={on}
            onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); onSelect(x.id) }}
            className={cx('relative flex shrink-0 items-center gap-2.5 text-[13.5px] whitespace-nowrap outline-none transition-colors duration-(--dur-1) focus-visible:ring-2 focus-visible:ring-accent',
              vertical ? 'h-9 rounded-[10px] px-3 hover:bg-hl-low' : 'h-8 rounded-full px-3',
              on ? 'font-medium text-text' : 'text-subtle hover:text-text')}>
            <x.icon size={16} className={cx('shrink-0 transition-colors duration-(--dur-1)', on ? 'text-accent' : 'text-muted')} />
            {x.label}
          </a>
        )
      })}
    </nav>
  )
}

function Account() {
  const qc = useQueryClient()
  const toast = useToast()
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<{ username: string; totp: boolean }>('/auth/me') })
  const [oldPw, setOld] = useState('')
  const [newPw, setNew] = useState('')
  const [newPw2, setNew2] = useState('')
  const pw = useMutation({
    mutationFn: () => {
      if (newPw !== newPw2) throw new Error('两次输入的新密码不一致')
      return api('/me/password', { method: 'POST', body: { old: oldPw, new: newPw } })
    },
    onSuccess: () => { toast('good', '密码已修改'); setOld(''); setNew(''); setNew2('') },
    onError: (e) => toast('bad', (e as Error).message),
  })
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null)
  const [code, setCode] = useState('')
  const [disablePw, setDisablePw] = useState('')
  const [disabling, setDisabling] = useState(false)
  const startTotp = useAction({ fn: () => api<{ secret: string; uri: string; qr: string }>('/me/totp/setup', { method: 'POST' }), onSuccess: setSetup })
  const enableTotp = useMutation({
    mutationFn: () => api('/me/totp/enable', { method: 'POST', body: { code } }),
    onSuccess: () => { toast('good', '两步验证已开启'); setSetup(null); setCode(''); qc.invalidateQueries({ queryKey: ['me'] }) },
    onError: (e) => toast('bad', (e as Error).message),
  })
  const disableTotp = useMutation({
    mutationFn: () => api('/me/totp/disable', { method: 'POST', body: { password: disablePw } }),
    onSuccess: () => { toast('good', '两步验证已关闭'); setDisabling(false); setDisablePw(''); qc.invalidateQueries({ queryKey: ['me'] }) },
    onError: (e) => toast('bad', (e as Error).message),
  })
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="修改密码">
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); pw.mutate() }}>
          <input type="text" name="username" autoComplete="username" value={me.data?.username ?? ''} readOnly hidden />
          <Field label="原密码" type="password" value={oldPw} onChange={setOld} autoComplete="current-password" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="新密码" type="password" value={newPw} onChange={setNew} autoComplete="new-password" description="至少 8 位" />
            <Field label="确认新密码" type="password" value={newPw2} onChange={setNew2} autoComplete="new-password" />
          </div>
          <div><Button type="submit" variant="primary" isPending={pw.isPending} isDisabled={!oldPw || newPw.length < 8}>修改密码</Button></div>
        </form>
      </Card>
      <Card title="两步验证（TOTP）" action={me.data?.totp ? <Badge tone="good" dot>已开启</Badge> : <Badge>未开启</Badge>}>
        {me.data?.totp ? (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-subtle">登录时除密码外还需要验证器 App 里的 6 位动态码。忘记时可以在服务器上运行 <span className="font-mono">sbmaster reset-admin</span>。</p>
            <div><Button variant="danger" onPress={() => setDisabling(true)}>关闭两步验证</Button></div>
          </div>
        ) : setup ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-5">
            <img src={setup.qr} alt="两步验证二维码" className="h-40 w-40 shrink-0 rounded-[10px] bg-white p-1.5 [image-rendering:pixelated]" />
            <div className="flex min-w-0 flex-col gap-3">
              <p className="text-[13px] text-subtle">用 Google Authenticator、1Password 等扫码，或手动输入密钥：</p>
              <CopyText text={setup.secret} />
              <Field label="6 位验证码" value={code} onChange={setCode} autoFocus />
              <div className="flex gap-2"><Button variant="primary" isPending={enableTotp.isPending} isDisabled={code.length !== 6} onPress={() => enableTotp.mutate()}>验证并开启</Button><Button onPress={() => setSetup(null)}>取消</Button></div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-subtle">开启后，即使密码泄露也无法登录面板。</p>
            <div><Button variant="primary" isPending={startTotp.isPending} onPress={() => startTotp.mutate()}>开启两步验证</Button></div>
          </div>
        )}
      </Card>
      <ModalDialog isOpen={disabling} onOpenChange={setDisabling} title="关闭两步验证"
        footer={<><Button onPress={() => setDisabling(false)}>取消</Button><Button variant="danger-solid" isPending={disableTotp.isPending} isDisabled={!disablePw} onPress={() => disableTotp.mutate()}>关闭两步验证</Button></>}>
        <Field label="输入密码确认" type="password" value={disablePw} onChange={setDisablePw} autoFocus />
      </ModalDialog>
    </div>
  )
}

const notifyKinds = [
  { id: 'node_offline', label: '节点离线（超过 60 秒）' }, { id: 'node_online', label: '节点上线' }, { id: 'apply_failed', label: '配置下发失败' },
  { id: 'node_quota', label: '节点月流量 80% / 100%' }, { id: 'quota_exceeded', label: '用户流量用尽' }, { id: 'user_expired', label: '用户到期' },
  { id: 'device_limit', label: '设备数超限' }, { id: 'node_enrolled', label: '新节点接入' }, { id: 'usage_reset', label: '用量周期重置' },
  { id: 'cert_expiring', label: '证书即将过期（≤14 天）' }, { id: 'cert_renew_failed', label: '证书续期失败' }, { id: 'cert_renewed', label: '证书已续期' },
  { id: 'inbound_unreachable', label: '入站不可达（连通性检查）' }, { id: 'inbound_recovered', label: '入站恢复' },
]

function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/settings') })
}

function Notify() {
  const qc = useQueryClient()
  const toast = useToast()
  const s = useSettings()
  const [tgToken, setTgToken] = useState('')
  const [chat, setChat] = useState('')
  const [hook, setHook] = useState('')
  const [kinds, setKinds] = useState<string[]>([])
  useEffect(() => {
    if (s.data) { setChat(s.data.tg_chat); setHook(s.data.webhook_url); setKinds(s.data.notify_events.split(',').filter(Boolean)) }
  }, [s.data])
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, string> = { tg_chat: chat, webhook_url: hook, notify_events: kinds.join(',') }
      if (tgToken) body.tg_token = tgToken
      return api('/settings', { method: 'PUT', body })
    },
    onSuccess: () => { toast('good', '已保存'); setTgToken(''); qc.invalidateQueries({ queryKey: ['settings'] }) },
    onError: (e) => toast('bad', (e as Error).message),
  })
  const test = useMutation({ mutationFn: () => api('/notify/test', { method: 'POST' }), onSuccess: () => toast('good', '测试消息已发送'), onError: (e) => toast('bad', (e as Error).message) })
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="渠道" action={<Button size="sm" variant="primary" isPending={save.isPending} onPress={() => save.mutate()}>保存</Button>}>
        <div className="flex flex-col gap-4">
          <Field label="Telegram Bot Token" type="password" value={tgToken} onChange={setTgToken} autoComplete="off"
            placeholder={s.data?.tg_token_set ? '已设置（留空保持不变）' : '从 @BotFather 获取'} />
          <Field label="Telegram Chat ID" value={chat} onChange={setChat} placeholder="例如 123456789" />
          <Field label="Webhook URL" value={hook} onChange={setHook} placeholder="https://…" description={'POST JSON：{"text": "...", "ts": 1700000000}'} />
          <div className="flex gap-2"><Button onPress={() => test.mutate()} isPending={test.isPending}>发送测试消息</Button></div>
        </div>
      </Card>
      <Card title="通知哪些事件" action={<Button size="sm" variant="primary" isPending={save.isPending} onPress={() => save.mutate()}>保存</Button>}>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {notifyKinds.map((k) => (
            <Checkbox key={k.id} isSelected={kinds.includes(k.id)} onChange={(v) => setKinds(v ? [...kinds, k.id] : kinds.filter((x) => x !== k.id))}>{k.label}</Checkbox>
          ))}
        </div>
      </Card>
    </div>
  )
}

function Policy() {
  const qc = useQueryClient()
  const toast = useToast()
  const s = useSettings()
  const [dp, setDp] = useState('reject')
  useEffect(() => { if (s.data) setDp(s.data.device_policy) }, [s.data])
  const save = useMutation({
    mutationFn: () => api('/settings', { method: 'PUT', body: { device_policy: dp } }),
    onSuccess: () => { toast('good', '已保存'); qc.invalidateQueries({ queryKey: ['settings'] }) },
    onError: (e) => toast('bad', (e as Error).message),
  })
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="设备数超限时" action={<Button size="sm" variant="primary" isPending={save.isPending} onPress={() => save.mutate()}>保存</Button>}>
        <Select label="策略" value={dp} onChange={setDp} options={[{ id: 'reject', label: '拒绝新设备（先连上的保留）' }, { id: 'kick_oldest', label: '踢掉最早的设备（新设备优先）' }]} />
        <p className="mt-3 text-xs text-muted">按用户在所有节点上同时在线的来源 IP 计数。节点本地会立即拒绝超额的新 IP，master 每 10 秒做一次跨节点校正。</p>
      </Card>
      <Card title="数据保留">
        <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-[13px]">
          <dt className="text-subtle">分钟级流量</dt><dd>{s.data?.keep_minute_days} 天</dd>
          <dt className="text-subtle">小时级流量</dt><dd>{s.data?.keep_hour_days} 天</dd>
          <dt className="text-subtle">域名 / 来源 IP 明细</dt><dd>{s.data?.keep_dim_days} 天</dd>
          <dt className="text-subtle">时区</dt><dd>{s.data?.tz}</dd>
        </dl>
        <p className="mt-3 text-xs text-muted">在启动参数里调整（--tz 等）。</p>
      </Card>
      <Card className="xl:col-span-2" title="节点接入">
        <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-[13px]">
          <dt className="text-subtle">gRPC 监听</dt><dd className="font-mono">{s.data?.grpc_listen}</dd>
          <dt className="text-subtle">节点连接地址</dt><dd className="font-mono">{s.data?.public_grpc || '（按访问面板的域名推断，建议用 --public-grpc 指定）'}</dd>
          <dt className="text-subtle">CA 指纹</dt><dd className="min-w-0"><CopyText text={s.data?.ca_sha256 ?? ''} /></dd>
        </dl>
      </Card>
    </div>
  )
}

function Backup() {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="下载备份">
        <p className="mb-4 text-[13px] text-subtle">导出完整的 SQLite 数据库（用户、节点、入站、模板、流量统计、CA 私钥）。请妥善保管：它可以签发节点证书。</p>
        <a href="/api/backup" download className="inline-flex h-8 items-center rounded-full bg-accent px-4 text-sm font-medium text-on-accent hover:brightness-110">下载 sbmaster.db</a>
      </Card>
      <Card title="恢复">
        <ol className="list-decimal space-y-1.5 pl-5 text-[13px] text-subtle">
          <li>停止 sbmaster</li>
          <li>把备份文件放到数据目录，命名为 <span className="font-mono text-text">sbmaster.db</span>（删除同目录的 -wal / -shm 文件）</li>
          <li>启动 sbmaster。节点证书由同一个 CA 签发，节点会自动重连</li>
        </ol>
        <p className="mt-3 text-xs text-muted">忘记密码：<span className="font-mono">sbmaster reset-admin --password 新密码</span></p>
      </Card>
    </div>
  )
}

function Import() {
  const qc = useQueryClient()
  const toast = useToast()
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<Node[]>('/nodes') })
  const [node, setNode] = useState('')
  const [data, setData] = useState('')
  const [file, setFile] = useState('')
  const [rep, setRep] = useState<ImportReport | null>(null)
  const [err, setErr] = useState('')
  const [confirm, setConfirm] = useState(false)
  useEffect(() => { if (!node && nodes.data?.[0]) setNode(nodes.data[0].id) }, [nodes.data, node])
  // Any change to the input invalidates the preview: the import button only works on what was previewed.
  const reset = () => { setRep((r) => (r?.dry_run ? null : r)); setErr('') }
  const run = useMutation({
    mutationFn: (dry: boolean) => api<ImportReport>('/import/3xui', { method: 'POST', body: { node_id: node, data, dry_run: dry } }),
    onMutate: () => setErr(''),
    onSuccess: (r) => {
      setRep(r)
      if (!r.dry_run) { toast('good', `已导入 ${r.users} 个用户、${r.inbounds?.length ?? 0} 个入站`); qc.invalidateQueries() }
    },
    onError: (e) => { setRep(null); setErr((e as Error).message) },
  })
  const onFile = async (f: File | undefined) => { if (f) { setFile(f.name); setData(await f.text()); reset() } }
  return (
    <div className="flex flex-col gap-4">
      <Callout>
        导出方式：在 3x-ui 所在机器执行 <span className="font-mono">curl -s -b cookie https://面板地址/panel/api/inbounds/list</span>（或用 API 令牌），把返回的 JSON 粘贴到下面；
        也可以在服务器上直接 <span className="font-mono">sbmaster import-3xui --node ID --db /etc/x-ui/x-ui.db</span>。用户按邮箱匹配，UUID、密码、subId 保持不变，3x-ui 的订阅链接 <span className="font-mono">/sub/&lt;subId&gt;</span> 继续可用。
      </Callout>
      <Card title="1 · 选择目标节点并提供数据">
        <div className="flex flex-col gap-4">
          <Select className="sm:w-64" label="导入到节点" value={node} onChange={(v) => { setNode(v); reset() }} options={(nodes.data ?? []).map((n) => ({ id: n.id, label: n.name }))} />
          <Field label="3x-ui 入站列表 JSON" multiline rows={8} mono value={data} onChange={(v) => { setData(v); setFile(''); reset() }} placeholder='{"success":true,"obj":[{"id":1,"protocol":"vless",...}]}' />
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-subtle">
            <FileTrigger acceptedFileTypes={['.json', 'application/json']} onSelect={(fl) => onFile(fl?.[0])}>
              <Button size="sm">选择 JSON 文件…</Button>
            </FileTrigger>
            <span className="min-w-0 truncate">{file ? <>已读取 <span className="font-mono text-text">{file}</span></> : '或从文件读取'}</span>
          </div>
          {err && <Callout tone="bad"><b>{run.variables === false ? "导入失败" : "预览失败"}：</b>{err}</Callout>}
          <div className="flex flex-wrap gap-2">
            <Button isPending={run.isPending && run.variables === true} isDisabled={!node || !data.trim() || run.isPending} onPress={() => run.mutate(true)}>预览（不写入）</Button>
            <Button variant="primary" isPending={run.isPending && run.variables === false} isDisabled={!rep?.dry_run || run.isPending} onPress={() => setConfirm(true)}>导入</Button>
            {!rep?.dry_run && data.trim() && !err && <span className="self-center text-xs text-muted">先预览，确认结果后才能导入</span>}
          </div>
        </div>
      </Card>
      {rep && (
        <Card title={rep.dry_run ? '2 · 预览结果' : '导入完成'} className="animate-content-in">
          <div className="flex flex-wrap gap-3 text-[13px]">
            <Badge tone="accent">{rep.users} 个用户{rep.updated ? `（${rep.updated} 个已存在，已更新）` : ''}</Badge>
            <Badge tone="accent">{rep.inbounds?.length ?? 0} 个入站</Badge>
            {(rep.skipped?.length ?? 0) > 0 && <Badge tone="warn">跳过 {rep.skipped!.length} 个</Badge>}
          </div>
          {rep.inbounds && rep.inbounds.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-[13px] whitespace-nowrap">
                <thead className="text-left text-xs text-subtle"><tr className="border-b"><th className="py-2 pr-3 font-medium">入站</th><th className="py-2 pr-3 font-medium">协议</th><th className="py-2 pr-3 font-medium">端口</th><th className="py-2 font-medium">用户</th></tr></thead>
                <tbody>{rep.inbounds.map((i) => <tr key={i.tag} className="border-b last:border-0"><td className="py-1.5 pr-3">{i.remark || i.tag}<span className="ml-2 font-mono text-xs text-muted">{i.tag}</span></td><td className="py-1.5 pr-3">{i.type}</td><td className="py-1.5 pr-3 tabular">{i.port}</td><td className="py-1.5 tabular">{i.users}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          {(rep.groups?.length ?? 0) > 0 && <><h3 className="mt-4 mb-1 text-[13px] font-medium">将创建的分组</h3><ul className="list-disc pl-5 text-[13px] text-subtle">{rep.groups!.map((g) => <li key={g}>{g}</li>)}</ul></>}
          {(rep.skipped?.length ?? 0) > 0 && <><h3 className="mt-4 mb-1 text-[13px] font-medium text-warn">跳过</h3><ul className="list-disc pl-5 text-[13px] text-subtle">{rep.skipped!.map((g) => <li key={g}>{g}</li>)}</ul></>}
          {(rep.warnings?.length ?? 0) > 0 && <><h3 className="mt-4 mb-1 text-[13px] font-medium text-warn">注意</h3><ul className="list-disc pl-5 text-[13px] text-subtle">{[...new Set(rep.warnings!)].map((g) => <li key={g}>{g}</li>)}</ul></>}
        </Card>
      )}
      <Confirm isOpen={confirm} onOpenChange={setConfirm} title="确认导入" confirmLabel="导入" onConfirm={() => run.mutate(false)}
        body={`将在节点上创建 ${rep?.inbounds?.length ?? 0} 个入站、导入 ${rep?.users ?? 0} 个用户。端口与节点上已有入站冲突时会整体回滚。`} />
    </div>
  )
}
