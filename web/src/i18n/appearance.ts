import { createElement as h, Fragment, type ReactNode } from 'react'
import { dict } from '.'

/** Palette names (lib/appearance.ts). The settings form copy is in i18n/settings.ts. */
export const P = dict({
  neutral: 'Graphite', neutralHint: 'Neutral grey (default)', rosepineHint: 'Warm and soft', nordHint: 'Cool Nordic',
}, {
  neutral: '石墨', neutralHint: '中性灰，默认', rosepineHint: '暖调柔和', nordHint: '冷调北欧',
})

const frag = (...c: ReactNode[]) => h(Fragment, null, ...c)

/** Settings → Appearance (pages/settings/Appearance.tsx). */
export const A = dict({
  m_system: 'System', m_light: 'Light', m_dark: 'Dark', r_default: 'Standard', r_sharp: 'Sharp', r_round: 'Rounded',
  d_default: 'Comfortable', d_compact: 'Compact', customAccent: 'Custom accent', radiusX: (r: string) => `${r} corners`,
  savedDefault: 'Set as the site-wide default',
  subpageHint: () => frag('The subscription page’s look and theme live in ', h('b', { className: 'font-medium text-accent group-hover:underline' }, 'Subscriptions → Subscription page'), '; this only affects the admin panel.'),
  palette: 'Palette', modeShape: 'Mode & shape', mode: 'Mode', radius: 'Corners', density: 'Density',
  accent: 'Accent colour', usePaletteAccent: 'Use the palette’s own', custom: 'Custom',
  primaryBtn: 'Primary button', linkText: 'Link text', tag: 'Tag',
  adjusted: (dark: boolean, hex: string, ratio: string) => frag(`For readability it is adjusted in ${dark ? 'dark' : 'light'} mode to `, h('span', { className: 'font-mono' }, hex), ` (button text contrast ${ratio}:1).`),
  autoAdjust: 'Brightness is adjusted automatically so the colour meets WCAG AA (≥ 4.5:1) as text and as a button on every background.',
  whereSaved: 'Where it’s saved',
  savedHint: () => frag('Changes apply immediately and are ', h('b', { className: 'font-medium text-text' }, 'saved in this browser only'), '. Set them as the site-wide default to apply them to every admin and new device that hasn’t made its own choice.'),
  thisBrowser: 'This browser', followDefault: '(follows the site-wide default)', siteDefault: 'Site-wide default', builtinDefault: 'Graphite · System (built-in)',
  setDefault: 'Set as site-wide default', revert: 'Revert to site-wide default',
  rosepineNote: 'Rosé Pine’s secondary text is brightened from the official values to meet contrast requirements.',
}, {
  m_system: '跟随系统', m_light: '浅色', m_dark: '深色', r_default: '标准', r_sharp: '锐利', r_round: '圆润',
  d_default: '舒适', d_compact: '紧凑', customAccent: '自定义强调色', radiusX: (r) => `${r}圆角`,
  savedDefault: '已设为全站默认',
  subpageHint: () => frag('订阅页的外观与主题在 ', h('b', { className: 'font-medium text-accent group-hover:underline' }, '订阅 → 订阅页'), '；这里只影响管理面板。'),
  palette: '配色', modeShape: '明暗与形状', mode: '明暗', radius: '圆角', density: '密度',
  accent: '强调色', usePaletteAccent: '使用配色自带', custom: '自定义',
  primaryBtn: '主要按钮', linkText: '链接文字', tag: '标签',
  adjusted: (dark, hex, ratio) => frag(`为保证可读性，${dark ? '深色' : '浅色'}模式下自动调整为 `, h('span', { className: 'font-mono' }, hex), `（按钮文字对比度 ${ratio}:1）。`),
  autoAdjust: '所选颜色会自动调整亮度，保证在所有背景上作为文字和按钮都满足 WCAG AA（≥ 4.5:1）。',
  whereSaved: '保存位置',
  savedHint: () => frag('以上选择立即生效，并', h('b', { className: 'font-medium text-text' }, '只保存在当前浏览器'), '。设为全站默认后，所有没有自己选择的管理员和新设备都会使用它。'),
  thisBrowser: '当前浏览器', followDefault: '（跟随全站默认）', siteDefault: '全站默认', builtinDefault: '石墨 · 跟随系统（内置）',
  setDefault: '设为全站默认', revert: '恢复为全站默认',
  rosepineNote: 'Rosé Pine 的辅助文字已在官方色值基础上提亮，以满足对比度要求。',
})
