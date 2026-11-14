import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type SiteSettings } from '../../lib/api'
import { useAction } from '../../lib/actions'
import {
  ACCENT_PRESETS, PALETTES, clearLocal, contrast, isHex, resolveAccent, setLocal, setServerDefault, useAppearance,
  type Appearance, type Density, type Mode, type Palette, type Radius,
} from '../../lib/appearance'
import { Badge, Button, Callout, Card, Segmented, cx } from '../../ui/kit'
import { IconCheck } from '../../ui/icons'

const MODES: { id: Mode; label: string }[] = [{ id: 'system', label: '跟随系统' }, { id: 'light', label: '浅色' }, { id: 'dark', label: '深色' }]
const RADII: { id: Radius; label: string }[] = [{ id: 'default', label: '标准' }, { id: 'sharp', label: '锐利' }, { id: 'round', label: '圆润' }]
const DENSITIES: { id: Density; label: string }[] = [{ id: 'default', label: '舒适' }, { id: 'compact', label: '紧凑' }]

function describe(a: Appearance) {
  const p = PALETTES.find((x) => x.id === (a.palette ?? 'neutral'))?.label
  const m = MODES.find((x) => x.id === (a.mode ?? 'system'))?.label
  return [p, m, a.accent ? '自定义强调色' : null, a.radius && a.radius !== 'default' ? RADII.find((x) => x.id === a.radius)?.label + '圆角' : null,
    a.density === 'compact' ? '紧凑' : null].filter(Boolean).join(' · ')
}

export function AppearanceSettings() {
  const { appearance: a, dark, server, hasLocal } = useAppearance()
  const palette = a.palette ?? 'neutral'
  const [custom, setCustom] = useState(a.accent?.source ?? '#1f6a88')
  const s = useQuery({ queryKey: ['settings'], queryFn: () => api<SiteSettings>('/settings') })

  const setPalette = (p: Palette) => setLocal({ palette: p, accent: a.accent?.source ? { ...resolveAccent(a.accent.source, p), source: a.accent.source } : undefined })
  const setAccent = (hex: string | null) => {
    if (hex && !isHex(hex)) return
    setLocal({ accent: hex ? { ...resolveAccent(hex, palette), source: hex } : undefined })
  }
  const saveDefault = useAction({
    fn: () => api('/settings', { method: 'PUT', body: { ui_appearance: JSON.stringify(a) } }),
    success: '已设为全站默认', invalidate: [['settings']],
    onSuccess: () => setServerDefault(a),
  })
  const resolved = a.accent ? (dark ? a.accent.dark : a.accent.light) : null

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <a href="#/subscriptions?tab=subpage" className="group flex items-center gap-3 rounded-[12px] border border-dashed bg-surface px-4 py-3 text-[13px] text-subtle outline-none transition-colors duration-(--dur-1) hover:border-accent hover:text-text focus-visible:ring-2 focus-visible:ring-accent xl:col-span-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] bg-overlay text-accent">→</span>
        <span>订阅页的外观与主题在 <b className="font-medium text-accent group-hover:underline">订阅 → 订阅页</b>；这里只影响管理面板。</span>
      </a>
      <Card className="xl:col-span-2" title="配色">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="radiogroup" aria-label="配色">
          {PALETTES.map((p) => {
            const on = p.id === palette
            return (
              <button key={p.id} type="button" role="radio" aria-checked={on} onClick={() => setPalette(p.id)}
                className={cx('group flex cursor-pointer flex-col gap-3 rounded-[12px] border p-3 text-left outline-none transition-[border-color,box-shadow] duration-(--dur-1) focus-visible:ring-2 focus-visible:ring-accent',
                  on ? 'border-accent ring-1 ring-accent' : 'hover:border-hl-high')}>
                <span className="flex h-16 overflow-hidden rounded-[8px] border">
                  {(['light', 'dark'] as const).map((m) => (
                    <span key={m} className="flex flex-1 items-end gap-1 p-2" style={{ background: p.swatch[m][0] }}>
                      <span className="h-8 flex-1 rounded-[5px] p-1.5" style={{ background: p.swatch[m][1] }}>
                        <span className="block h-1.5 w-3/4 rounded-full" style={{ background: p.swatch[m][3] }} />
                        <span className="mt-1.5 block h-2.5 w-1/2 rounded-full" style={{ background: p.swatch[m][2] }} />
                      </span>
                    </span>
                  ))}
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span><span className="block text-sm font-medium">{p.label}</span><span className="text-xs text-muted">{p.hint}</span></span>
                  {on && <IconCheck size={16} className="animate-check text-accent" />}
                </span>
              </button>
            )
          })}
        </div>
      </Card>

      <Card title="明暗与形状">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-[13px] text-subtle">明暗</span>
            <Segmented label="明暗" value={a.mode ?? 'system'} onChange={(m) => setLocal({ mode: m })} options={MODES} /></div>
          <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-[13px] text-subtle">圆角</span>
            <Segmented label="圆角" value={a.radius ?? 'default'} onChange={(r) => setLocal({ radius: r })} options={RADII} /></div>
          <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-[13px] text-subtle">密度</span>
            <Segmented label="密度" value={a.density ?? 'default'} onChange={(d) => setLocal({ density: d })} options={DENSITIES} /></div>
        </div>
      </Card>

      <Card title="强调色" action={a.accent && <Button size="sm" onPress={() => setAccent(null)}>使用配色自带</Button>}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="强调色">
            {ACCENT_PRESETS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={a.accent?.source === c} aria-label={c} onClick={() => { setCustom(c); setAccent(c) }}
                className={cx('grid h-8 w-8 cursor-pointer place-items-center rounded-full outline-none transition-transform duration-(--dur-1) hover:scale-110 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                  a.accent?.source === c && 'ring-2 ring-text ring-offset-2 ring-offset-surface')} style={{ background: c }}>
                {a.accent?.source === c && <IconCheck size={14} className="text-white" />}
              </button>
            ))}
            <label className="ml-1 flex h-8 cursor-pointer items-center gap-2 rounded-full bg-overlay pr-3 pl-1 text-[13px] text-subtle">
              <input type="color" value={custom} onChange={(e) => { setCustom(e.target.value); setAccent(e.target.value) }}
                className="h-6 w-6 cursor-pointer rounded-full border-0 bg-transparent p-0" aria-label="自定义强调色" />自定义
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex h-8 items-center rounded-full bg-accent px-4 text-sm font-medium text-on-accent">主要按钮</span>
            <span className="text-sm font-medium text-accent">链接文字</span>
            <Badge tone="accent">标签</Badge>
          </div>
          <p className="text-xs text-muted">
            {resolved && a.accent?.source && resolved.accent !== a.accent.source.toLowerCase()
              ? <>为保证可读性，{dark ? '深色' : '浅色'}模式下自动调整为 <span className="font-mono">{resolved.accent}</span>（按钮文字对比度 {contrast(resolved.accent, resolved.onAccent).toFixed(1)}:1）。</>
              : '所选颜色会自动调整亮度，保证在所有背景上作为文字和按钮都满足 WCAG AA（≥ 4.5:1）。'}
          </p>
        </div>
      </Card>

      <Card className="xl:col-span-2" title="保存位置">
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-subtle">
            以上选择立即生效，并<b className="font-medium text-text">只保存在当前浏览器</b>。设为全站默认后，所有没有自己选择的管理员和新设备都会使用它。
          </p>
          <dl className="grid grid-cols-[96px_1fr] gap-y-1.5 text-[13px]">
            <dt className="text-subtle">当前浏览器</dt><dd>{describe(a)}{!hasLocal && <span className="ml-2 text-muted">（跟随全站默认）</span>}</dd>
            <dt className="text-subtle">全站默认</dt><dd>{s.data?.ui_appearance ? describe(server) : '石墨 · 跟随系统（内置）'}</dd>
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" isPending={saveDefault.isPending} onPress={() => saveDefault.mutate()}>设为全站默认</Button>
            <Button isDisabled={!hasLocal} onPress={() => clearLocal()}>恢复为全站默认</Button>
          </div>
          {palette === 'rosepine' && <Callout>Rosé Pine 的辅助文字已在官方色值基础上提亮，以满足对比度要求。</Callout>}
        </div>
      </Card>
    </div>
  )
}
