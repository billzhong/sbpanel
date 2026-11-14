import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileTrigger } from 'react-aria-components'
import { api, apiUpload, SUB_CLIENTS, type SiteSettings, type SubSupportLink, type SubTheme, type SubThemeField, type User } from '../../lib/api'
import { href } from '../../lib/router'
import { useAction } from '../../lib/actions'
import {
  Badge, Button, Callout, Card, CheckList, Confirm, Field, IconButton, ModalDialog, Presence, Segmented, Select, Skeleton, Switch, cx, useSticky,
} from '../../ui/kit'
import { IconPlus, IconTrash } from '../../ui/icons'

const ICONS = [{ id: 'link', label: '链接' }, { id: 'telegram', label: 'Telegram' }, { id: 'chat', label: '群聊' }, { id: 'book', label: '教程' }, { id: 'mail', label: '邮件' }]

/** 订阅 → 订阅页: what users see when they open their link in a browser. */
export function SubPageTab() {
  const [previewId, setPreviewId] = useState('')
  const themes = useQuery({ queryKey: ['sub-themes'], queryFn: () => api<SubTheme[]>('/sub-themes') })
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<SiteSettings>('/settings') })
  const list = themes.data ?? []
  const preview = list.find((t) => t.id === previewId) ?? list.find((t) => t.active)
  // Bump the preview whenever saved content or theme data changes.
  const version = `${themes.dataUpdatedAt}-${settings.dataUpdatedAt}`
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
      <div className="flex min-w-0 flex-col gap-4">
        <Callout>
          用户在浏览器里打开订阅链接时看到的页面。页面运行在隔离沙箱中（独立 origin、无 Cookie），主题无法访问面板。
          主题开发见 <span className="font-mono">docs/SUB-THEMES.md</span>。面板自身的配色在 <a href={href('settings', { s: 'appearance' })} className="font-medium text-accent hover:underline">设置 → 外观</a>。
        </Callout>
        <SiteContent />
        <Themes list={list} loading={themes.isLoading} previewId={preview?.id} onPreview={setPreviewId} />
      </div>
      {preview && <Preview theme={preview} version={version} />}
    </div>
  )
}

function SiteContent() {
  const s = useQuery({ queryKey: ['settings'], queryFn: () => api<SiteSettings>('/settings') })
  const [ann, setAnn] = useState('')
  const [logo, setLogo] = useState('')
  const [links, setLinks] = useState<SubSupportLink[]>([])
  const [clients, setClients] = useState<string[]>([])
  useEffect(() => {
    if (!s.data) return
    setAnn(s.data.sub_announcement ?? '')
    setLogo(s.data.sub_logo_url ?? '')
    try { setLinks(JSON.parse(s.data.sub_support_links || '[]') ?? []) } catch { setLinks([]) }
    setClients(s.data.sub_clients ? s.data.sub_clients.split(',') : SUB_CLIENTS.map((c) => c.id))
  }, [s.data])
  const save = useAction({
    fn: () => api('/settings', {
      method: 'PUT', body: {
        sub_announcement: ann, sub_logo_url: logo,
        sub_support_links: JSON.stringify(links.filter((l) => l.label.trim() || l.url.trim())),
        // all selected = no allow-list, so clients added later show up automatically
        sub_clients: clients.length === SUB_CLIENTS.length ? '' : SUB_CLIENTS.filter((c) => clients.includes(c.id)).map((c) => c.id).join(','),
      },
    }),
    success: '订阅页内容已保存', invalidate: [['settings'], ['sub-themes']],
  })
  const setLink = (i: number, p: Partial<SubSupportLink>) => setLinks(links.map((l, j) => (j === i ? { ...l, ...p } : l)))
  return (
    <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
      <Card title="页面内容" action={<Button size="sm" variant="primary" isPending={save.isPending} onPress={() => save.mutate()}>保存</Button>}>
        <div className="flex flex-col gap-4">
          <Field label="公告" multiline rows={4} value={ann} onChange={setAnn} placeholder="例如：11 月 20 日 02:00 东京节点维护" description="显示在页面顶部，可换行，最多 2000 字。留空则不显示。" />
          <Field label="Logo 地址" value={logo} onChange={setLogo} placeholder="https://…/logo.png" description="正方形图片，需 https。留空时显示站点名首字。站点名在「订阅」页设置。" />
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium text-subtle">帮助与联系方式</span>
            {links.length === 0 && <span className="text-[13px] text-muted">还没有联系方式。</span>}
            {links.map((l, i) => (
              <div key={i} className="grid grid-cols-[112px_minmax(0,1fr)_auto] items-center gap-2 rounded-[10px] border bg-base p-2.5">
                <Select hideLabel label="图标" value={l.icon || 'link'} onChange={(v) => setLink(i, { icon: v })} options={ICONS} />
                <Field hideLabel label="名称" value={l.label} onChange={(v) => setLink(i, { label: v })} placeholder="名称，如 Telegram 群组" />
                <IconButton label="删除联系方式" onPress={() => setLinks(links.filter((_, j) => j !== i))}><IconTrash size={15} /></IconButton>
                <Field hideLabel label="链接" className="col-span-3" mono value={l.url} onChange={(v) => setLink(i, { url: v })} placeholder="https:// · mailto: · tg://" />
              </div>
            ))}
            <div><Button size="sm" isDisabled={links.length >= 8} onPress={() => setLinks([...links, { label: '', url: '', icon: 'link' }])}><IconPlus size={14} />添加</Button></div>
          </div>
        </div>
      </Card>
      <Card title="一键导入的客户端" action={<Button size="sm" variant="primary" isPending={save.isPending} onPress={() => save.mutate()}>保存</Button>}>
        <CheckList label="在订阅页显示" options={SUB_CLIENTS} value={clients} onChange={setClients} />
        <p className="mt-3 text-xs text-muted">订阅页会按访问设备（iOS / Android / 桌面）把对应客户端排在前面。主题也可以在自己的设置里进一步筛选。</p>
      </Card>
    </div>
  )
}

function Themes({ list, loading, previewId, onPreview }: { list: SubTheme[]; loading: boolean; previewId?: string; onPreview: (id: string) => void }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<SubTheme | null>(null)
  const [deleting, setDeleting] = useState<SubTheme | null>(null)
  const [uploadErr, setUploadErr] = useState('')
  const activate = useAction({ fn: (id: string) => api('/sub-themes/active', { method: 'PUT', body: { id } }), success: '已启用，用户刷新页面即可看到', invalidate: [['sub-themes']] })
  const del = useAction({ fn: (id: string) => api(`/sub-themes/${id}`, { method: 'DELETE' }), success: '主题已删除', invalidate: [['sub-themes']] })
  const upload = useAction({
    fn: (f: File) => apiUpload<SubTheme>('/sub-themes', f),
    success: (t) => `已安装 ${t.name} ${t.version}`, invalidate: [['sub-themes']],
    onSuccess: (t) => { setUploadErr(''); onPreview(t.id) },
  })
  const delSticky = useSticky(deleting)
  useEffect(() => { if (upload.error) setUploadErr((upload.error as Error).message) }, [upload.error])

  return (
    <Card title="主题" action={
      <FileTrigger acceptedFileTypes={['.zip', 'application/zip']} onSelect={(fl) => { const f = fl?.[0]; if (f) { setUploadErr(''); upload.mutate(f) } }}>
        <Button size="sm" variant="primary" isPending={upload.isPending}><IconPlus size={14} />上传主题</Button>
      </FileTrigger>
    }>
      {uploadErr && <div className="mb-3"><Callout tone="bad"><b>上传失败：</b>{uploadErr}</Callout></div>}
      {loading && <Skeleton className="h-32" />}
      <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
        {list.map((t) => (
          <article key={t.id} className={cx('flex min-w-0 flex-col overflow-hidden rounded-[12px] border bg-base', t.active && 'border-accent ring-1 ring-accent')}>
            <button type="button" onClick={() => onPreview(t.id)} aria-label={`预览 ${t.name}`} aria-pressed={previewId === t.id}
              className="relative aspect-[16/10] cursor-pointer overflow-hidden bg-overlay outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset">
              <Thumb theme={t} />
              {previewId === t.id && <span className="absolute top-2 left-2 rounded-full bg-surface/90 px-2 py-0.5 text-[11px] font-medium text-subtle">预览中</span>}
            </button>
            <div className="flex flex-1 flex-col gap-2 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{t.name} <span className="font-mono text-xs text-muted">{t.version}</span></div>
                  <div className="truncate text-xs text-muted">{t.author || '—'}{t.builtin && ' · 内置'}</div>
                </div>
                {t.active && <Badge tone="good" dot>使用中</Badge>}
              </div>
              {t.description && <p className="line-clamp-2 text-xs text-subtle">{t.description}</p>}
              <div className="mt-auto flex flex-wrap gap-2 pt-1">
                {!t.active && <Button size="sm" variant="primary" isPending={activate.isPending && activate.variables === t.id} onPress={() => activate.mutate(t.id)}>启用</Button>}
                <Button size="sm" isDisabled={t.schema.every((f) => f.type === 'title')} onPress={() => setEditing(t)}>主题设置</Button>
                {!t.builtin && <Button size="sm" variant="danger" onPress={() => setDeleting(t)}>删除</Button>}
              </div>
            </div>
          </article>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">主题包是包含 <span className="font-mono">sbp-theme.json</span> 和 <span className="font-mono">index.html</span> 的 zip（≤ 20 MB）。同 id 再次上传即升级，设置会保留。</p>
      <Presence value={editing}>{(t, open) => <ThemeSettings theme={t} isOpen={open} onClose={() => setEditing(null)} onSaved={() => qc.invalidateQueries({ queryKey: ['sub-themes'] })} />}</Presence>
      <Confirm isOpen={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} danger title="删除主题" confirmLabel="删除主题"
        onConfirm={() => deleting && del.mutate(deleting.id)}
        body={<>删除 <b className="text-text">{delSticky?.name}</b> 及其设置。{delSticky?.active && '它正在使用中，订阅页会切回内置主题。'}</>} />
    </Card>
  )
}

/** Theme thumbnail from the manifest's preview image; a drawn placeholder when absent or broken. */
function Thumb({ theme }: { theme: SubTheme }) {
  const [broken, setBroken] = useState(false)
  if (theme.preview_url && !broken) {
    return <img src={theme.preview_url} alt="" onError={() => setBroken(true)} className="h-full w-full object-cover object-top" loading="lazy" />
  }
  return (
    <span aria-hidden className="flex h-full flex-col gap-2 bg-[linear-gradient(135deg,var(--overlay),var(--hl-low))] p-4 text-left">
      <span className="flex items-center gap-2"><span className="grid h-6 w-6 place-items-center rounded-[7px] bg-accent text-[11px] font-bold text-on-accent">{theme.name.slice(0, 1)}</span><span className="h-2 w-16 rounded-full bg-hl-high" /></span>
      <span className="flex flex-1 gap-2">
        <span className="flex-[2] rounded-[8px] border bg-surface p-2"><span className="block h-2 w-1/2 rounded-full bg-hl-high" /><span className="mt-2 block h-6 w-6 rounded-full border-[3px] border-accent" /></span>
        <span className="flex-1 rounded-[8px] border bg-surface p-2"><span className="block h-2 w-3/4 rounded-full bg-hl-high" /><span className="mt-2 block h-3 rounded-[4px] bg-accent/70" /></span>
      </span>
      <span className="text-[11px] text-muted">{broken ? '预览图加载失败' : '无预览图'} · 点击实时预览</span>
    </span>
  )
}

const SAMPLES = [{ id: 's:active', label: '示例用户 · 正常' }, { id: 's:limited', label: '示例用户 · 流量用完' }, { id: 's:expired', label: '示例用户 · 已过期' }]

function Preview({ theme, version }: { theme: SubTheme; version: string }) {
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<User[]>('/users') })
  const [who, setWho] = useState('s:active')
  const [wide, setWide] = useState(false)
  const [scheme, setScheme] = useState<'auto' | 'light' | 'dark'>('auto')
  const src = useMemo(() => {
    const q = new URLSearchParams(who.startsWith('s:') ? { state: who.slice(2) } : { user: who })
    q.set('v', version)
    return `/api/sub-themes/${encodeURIComponent(theme.id)}/preview?${q}`
  }, [theme.id, who, version])
  const options = [...SAMPLES, ...(users.data ?? []).slice(0, 200).map((u) => ({ id: String(u.id), label: `${u.username}${u.status !== 'active' || !u.enabled ? '（不可用）' : ''}` }))]
  return (
    <Card title={<>实时预览 <span className="text-[13px] font-normal text-muted">{theme.name}</span></>} className="xl:sticky xl:top-20 xl:self-start">
      <div className="mb-3 flex flex-col gap-2">
        <Select hideLabel label="预览用户" value={who} onChange={setWho} options={options} />
        <div className="flex flex-wrap gap-2">
          <Segmented label="宽度" value={wide ? 'w' : 'n'} onChange={(v) => setWide(v === 'w')} options={[{ id: 'n', label: '手机 375' }, { id: 'w', label: '桌面' }]} />
          <Segmented label="明暗" value={scheme} onChange={setScheme} options={[{ id: 'auto', label: '跟随面板' }, { id: 'light', label: '浅色' }, { id: 'dark', label: '深色' }]} />
        </div>
      </div>
      <div className={cx('mx-auto overflow-hidden rounded-[16px] border bg-base', !wide && 'max-w-[377px]')}>
        {/* The page is served with a CSP sandbox (opaque origin). Its prefers-color-scheme follows this element's color-scheme. */}
        <div className={cx(wide && 'overflow-x-auto')}>
          <iframe key={src + scheme} title={`${theme.name} 预览`} src={src} style={scheme === 'auto' ? undefined : { colorScheme: scheme }}
            className={cx('block h-[680px] border-0', wide ? 'w-[1100px] max-w-none origin-top-left' : 'w-full')} />
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">{who.startsWith('s:') ? '示例数据，不含真实用户信息。' : '该用户的真实数据，仅管理员可见。'}保存后自动刷新。</p>
    </Card>
  )
}

function ThemeSettings({ theme, isOpen, onClose, onSaved }: { theme: SubTheme; isOpen: boolean; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState<Record<string, unknown>>(theme.settings)
  const dirty = JSON.stringify(v) !== JSON.stringify(theme.settings)
  const save = useAction({
    fn: () => api(`/sub-themes/${encodeURIComponent(theme.id)}/settings`, { method: 'PUT', body: v }),
    success: '主题设置已保存', onSuccess: () => { onSaved(); onClose() },
  })
  return (
    <ModalDialog isOpen={isOpen} onOpenChange={(o) => !o && onClose()} title={`${theme.name} · 主题设置`} wide dirty={dirty}
      footer={<><Button onPress={onClose}>取消</Button><Button variant="primary" isPending={save.isPending} isDisabled={!dirty} onPress={() => save.mutate()}>保存</Button></>}>
      <div className="flex flex-col gap-4">
        {theme.schema.map((f, i) => <SchemaField key={f.key ?? `t${i}`} f={f} value={f.key ? v[f.key] : undefined} onChange={(x) => f.key && setV({ ...v, [f.key]: x })} />)}
      </div>
    </ModalDialog>
  )
}

/** Renders one manifest setting (see SubThemeField). */
function SchemaField({ f, value, onChange }: { f: SubThemeField; value: unknown; onChange: (v: unknown) => void }) {
  const help = f.help || undefined
  switch (f.type) {
    case 'title':
      return <h3 className="-mb-1 border-t pt-4 text-[13px] font-semibold first:border-0 first:pt-0">{f.label}</h3>
    case 'switch':
      return <div className="flex flex-col gap-1"><Switch isSelected={!!value} onChange={onChange}>{f.label}</Switch>{help && <span className="pl-11 text-xs text-muted">{help}</span>}</div>
    case 'select':
      return <Select label={f.label} description={help} value={String(value ?? '')} onChange={onChange} options={(f.options ?? []).map((o) => ({ id: o.value, label: o.label }))} />
    case 'multiselect':
      return <div><CheckList label={f.label} options={(f.options ?? []).map((o) => ({ id: o.value, label: o.label }))} value={(value as string[]) ?? []} onChange={onChange} />{help && <p className="mt-1 text-xs text-muted">{help}</p>}</div>
    case 'color': {
      const s = String(value ?? '')
      return (
        <div className="flex items-end gap-2">
          <input type="color" aria-label={`${f.label} 取色`} value={/^#[0-9a-f]{6}$/i.test(s) ? s : '#1f6a88'} onChange={(e) => onChange(e.target.value)}
            className="h-9 w-11 shrink-0 cursor-pointer rounded-[10px] border bg-base p-1" />
          <Field className="flex-1" label={f.label} description={help} mono value={s} onChange={onChange} placeholder="#RRGGBB，留空为默认" />
        </div>
      )
    }
    case 'number':
      return <Field label={f.label} description={help} inputMode="decimal" value={value == null ? '' : String(value)} onChange={(x) => onChange(x === '' ? 0 : Number(x))} />
    case 'textarea':
      return <Field label={f.label} description={help} multiline rows={4} value={String(value ?? '')} onChange={onChange} />
    default:
      return <Field label={f.label} description={help} value={String(value ?? '')} onChange={onChange} placeholder={f.type === 'url' ? 'https://…' : undefined} />
  }
}
