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
import { tr, useT } from '../../i18n'
import { A } from '../../i18n/appearance'

const MODES = (): { id: Mode; label: string }[] => { const t = tr(A); return [{ id: 'system', label: t.m_system }, { id: 'light', label: t.m_light }, { id: 'dark', label: t.m_dark }] }
const RADII = (): { id: Radius; label: string }[] => { const t = tr(A); return [{ id: 'default', label: t.r_default }, { id: 'sharp', label: t.r_sharp }, { id: 'round', label: t.r_round }] }
const DENSITIES = (): { id: Density; label: string }[] => { const t = tr(A); return [{ id: 'default', label: t.d_default }, { id: 'compact', label: t.d_compact }] }

function describe(a: Appearance) {
  const p = PALETTES.find((x) => x.id === (a.palette ?? 'neutral'))?.label
  const t = tr(A)
  const m = MODES().find((x) => x.id === (a.mode ?? 'system'))?.label
  return [p, m, a.accent ? t.customAccent : null, a.radius && a.radius !== 'default' ? t.radiusX(RADII().find((x) => x.id === a.radius)?.label ?? '') : null,
    a.density === 'compact' ? t.d_compact : null].filter(Boolean).join(' · ')
}

export function AppearanceSettings() {
  const t = useT(A)
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
    success: t.savedDefault, invalidate: [['settings']],
    onSuccess: () => setServerDefault(a),
  })
  const resolved = a.accent ? (dark ? a.accent.dark : a.accent.light) : null

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <a href="#/subscriptions?tab=subpage" className="group flex items-center gap-3 rounded-[12px] border border-dashed bg-surface px-4 py-3 text-[13px] text-subtle outline-none transition-colors duration-(--dur-1) hover:border-accent hover:text-text focus-visible:ring-2 focus-visible:ring-accent xl:col-span-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] bg-overlay text-accent">→</span>
        <span>{t.subpageHint()}</span>
      </a>
      <Card className="xl:col-span-2" title={t.palette}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="radiogroup" aria-label={t.palette}>
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

      <Card title={t.modeShape}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-[13px] text-subtle">{t.mode}</span>
            <Segmented label={t.mode} value={a.mode ?? 'system'} onChange={(m) => setLocal({ mode: m })} options={MODES()} /></div>
          <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-[13px] text-subtle">{t.radius}</span>
            <Segmented label={t.radius} value={a.radius ?? 'default'} onChange={(r) => setLocal({ radius: r })} options={RADII()} /></div>
          <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-[13px] text-subtle">{t.density}</span>
            <Segmented label={t.density} value={a.density ?? 'default'} onChange={(d) => setLocal({ density: d })} options={DENSITIES()} /></div>
        </div>
      </Card>

      <Card title={t.accent} action={a.accent && <Button size="sm" onPress={() => setAccent(null)}>{t.usePaletteAccent}</Button>}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={t.accent}>
            {ACCENT_PRESETS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={a.accent?.source === c} aria-label={c} onClick={() => { setCustom(c); setAccent(c) }}
                className={cx('grid h-8 w-8 cursor-pointer place-items-center rounded-full outline-none transition-transform duration-(--dur-1) hover:scale-110 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                  a.accent?.source === c && 'ring-2 ring-text ring-offset-2 ring-offset-surface')} style={{ background: c }}>
                {a.accent?.source === c && <IconCheck size={14} className="text-white" />}
              </button>
            ))}
            <label className="ml-1 flex h-8 cursor-pointer items-center gap-2 rounded-full bg-overlay pr-3 pl-1 text-[13px] text-subtle">
              <input type="color" value={custom} onChange={(e) => { setCustom(e.target.value); setAccent(e.target.value) }}
                className="h-6 w-6 cursor-pointer rounded-full border-0 bg-transparent p-0" aria-label={t.customAccent} />{t.custom}
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex h-8 items-center rounded-full bg-accent px-4 text-sm font-medium text-on-accent">{t.primaryBtn}</span>
            <span className="text-sm font-medium text-accent">{t.linkText}</span>
            <Badge tone="accent">{t.tag}</Badge>
          </div>
          <p className="text-xs text-muted">
            {resolved && a.accent?.source && resolved.accent !== a.accent.source.toLowerCase()
              ? t.adjusted(dark, resolved.accent, contrast(resolved.accent, resolved.onAccent).toFixed(1))
              : t.autoAdjust}
          </p>
        </div>
      </Card>

      <Card className="xl:col-span-2" title={t.whereSaved}>
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-subtle">
            {t.savedHint()}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
            <dt className="text-subtle">{t.thisBrowser}</dt><dd>{describe(a)}{!hasLocal && <span className="ml-2 text-muted">{t.followDefault}</span>}</dd>
            <dt className="text-subtle">{t.siteDefault}</dt><dd>{s.data?.ui_appearance ? describe(server) : t.builtinDefault}</dd>
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" isPending={saveDefault.isPending} onPress={() => saveDefault.mutate()}>{t.setDefault}</Button>
            <Button isDisabled={!hasLocal} onPress={() => clearLocal()}>{t.revert}</Button>
          </div>
          {palette === 'rosepine' && <Callout>{t.rosepineNote}</Callout>}
        </div>
      </Card>
    </div>
  )
}
