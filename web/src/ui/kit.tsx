import {
  createContext, Fragment, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
} from 'react'
import {
  Button as RButton, type ButtonProps, Dialog, Heading, Modal, ModalOverlay, TextField, Label, Input, TextArea,
  Switch as RSwitch, ToggleButton, ToggleButtonGroup, type Key, Select as RSelect, SelectValue, Popover, ListBox,
  ListBoxItem, FieldError, Text, Checkbox as RCheckbox, MenuTrigger, Menu, MenuItem, Separator, type PopoverProps,
} from 'react-aria-components'
import { IconX, IconCheck, IconAlert, IconCopy, IconMore } from './icons'

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ')
}

// ---- presence helpers -------------------------------------------------------

/**
 * Keeps an overlay mounted after `value` turns falsy so its exit animation can play,
 * and remounts the children (fresh form state) every time it opens again.
 */
export function Presence<T>({ value, children }: { value: T | null | undefined | false; children: (v: T, isOpen: boolean) => ReactNode }) {
  const open = !!value
  const [s, setS] = useState<{ v: T | null; k: number; open: boolean }>({ v: open ? (value as T) : null, k: 0, open })
  if (open !== s.open || (open && value !== s.v)) {
    setS({ v: open ? (value as T) : s.v, k: open && !s.open ? s.k + 1 : s.k, open })
  }
  useEffect(() => {
    if (s.open || s.v == null) return
    const t = setTimeout(() => setS((x) => (x.open ? x : { ...x, v: null })), 600)
    return () => clearTimeout(t)
  }, [s.open, s.v])
  if (s.v == null) return null
  return <Fragment key={s.k}>{children(s.v, s.open)}</Fragment>
}

/** The last non-null value, so overlay text does not blank out while it animates away. */
export function useSticky<T>(v: T | null | undefined): T | null | undefined {
  const r = useRef(v)
  if (v != null) r.current = v
  return v ?? r.current
}

/** Measures the element marked by `selector` inside the returned ref so a single indicator can slide to it. */
export function useIndicator<E extends HTMLElement>(selector: string, dep: unknown) {
  const ref = useRef<E>(null)
  const [st, setSt] = useState<{ x: number; y: number; w: number; h: number; ready: boolean } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const a = el.querySelector<HTMLElement>(selector)
      if (!a) { setSt(null); return }
      setSt((s) => {
        const n = { x: a.offsetLeft, y: a.offsetTop, w: a.offsetWidth, h: a.offsetHeight }
        if (s && s.x === n.x && s.y === n.y && s.w === n.w && s.h === n.h) return s
        return { ...n, ready: !!s }
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    el.querySelectorAll(':scope > *').forEach((c) => ro.observe(c))
    return () => ro.disconnect()
  }, [selector, dep])
  return [ref, st] as const
}

// ---- buttons ----------------------------------------------------------------

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <span aria-hidden className={cx('inline-block shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent', className)} style={{ width: size, height: size }} />
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-solid'
const variants: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent hover:brightness-110 data-[pressed]:brightness-95',
  secondary: 'bg-overlay text-text hover:bg-hl-med/70',
  ghost: 'bg-transparent text-subtle hover:bg-overlay hover:text-text',
  danger: 'bg-love/10 text-love hover:bg-love/20',
  'danger-solid': 'bg-love text-on-accent hover:brightness-110 data-[pressed]:brightness-95',
}

export function Button({ variant = 'secondary', size = 'md', className, children, isPending, ...p }: ButtonProps & { variant?: Variant; size?: 'sm' | 'md' }) {
  return (
    <RButton
      {...p}
      isPending={isPending}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-full font-medium whitespace-nowrap outline-none select-none',
        'transition-[filter,background-color,color,transform] duration-(--dur-1) data-[pressed]:scale-[.97]',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base',
        'disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer data-[pending]:cursor-wait',
        size === 'sm' ? 'h-7 px-3 text-[13px]' : 'h-8 px-4 text-sm',
        variants[variant], className as string,
      )}
    >
      {(rp) => <>{isPending && <Spinner size={size === 'sm' ? 12 : 14} />}{typeof children === 'function' ? children(rp) : children}</>}
    </RButton>
  )
}

export function IconButton({ label, className, ...p }: ButtonProps & { label: string }) {
  return (
    <RButton
      aria-label={label}
      {...p}
      className={cx('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-subtle outline-none transition-[background-color,color,transform] duration-(--dur-1) cursor-pointer data-[pressed]:scale-90',
        'hover:bg-overlay hover:text-text focus-visible:ring-2 focus-visible:ring-accent',
        'disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-subtle', className as string)}
    />
  )
}

// ---- surfaces ---------------------------------------------------------------

export function Card({ className, children, title, action, pad = true, busy }: {
  className?: string; children: ReactNode; title?: ReactNode; action?: ReactNode; pad?: boolean
  /** Refetching with placeholder data: dim the body and show a small spinner instead of unmounting. */
  busy?: boolean
}) {
  return (
    <section className={cx('min-w-0 rounded-[16px] border bg-surface', className)} aria-busy={busy || undefined}>
      {(title || action || busy) && (
        <header className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-1">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold">{title}<Spinner size={12} className={cx('text-muted transition-opacity duration-150', busy ? 'opacity-100' : 'opacity-0')} /></h2>
          <div className="flex items-center gap-2">{action}</div>
        </header>
      )}
      <div className={cx(pad ? 'p-5 pt-3' : '', 'transition-opacity duration-150', busy && 'opacity-60')}>{children}</div>
    </section>
  )
}

/** Wraps content that is being refetched with placeholder data. */
export function Busy({ busy, children, className }: { busy?: boolean; children: ReactNode; className?: string }) {
  return <div aria-busy={busy || undefined} className={cx('transition-opacity duration-150', busy && 'opacity-60', className)}>{children}</div>
}

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent'
const tones: Record<Tone, string> = {
  neutral: 'bg-overlay text-subtle',
  good: 'bg-good/12 text-good',
  warn: 'bg-warn/15 text-warn',
  bad: 'bg-bad/12 text-bad',
  accent: 'bg-accent/12 text-accent',
}
export function Badge({ tone = 'neutral', children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={cx('inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap transition-colors duration-(--dur-1)', tones[tone])}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

export const inputCls = cx('w-full rounded-[10px] border border-border-strong bg-base px-3 text-sm outline-none transition-[border-color,box-shadow] duration-(--dur-1)',
  'placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/25 data-[invalid]:border-bad data-[invalid]:focus:ring-bad/25')

export function Field({ label, description, multiline, mono, className, hideLabel, ...p }: {
  label: string; description?: ReactNode; multiline?: boolean; mono?: boolean; className?: string; hideLabel?: boolean
  value?: string; onChange?: (v: string) => void; placeholder?: string; type?: string; isRequired?: boolean
  autoFocus?: boolean; isInvalid?: boolean; errorMessage?: string; rows?: number; name?: string; autoComplete?: string
  inputMode?: 'numeric' | 'decimal' | 'text'
}) {
  const { inputMode, ...rest } = p
  const cls = cx(inputCls, mono && 'font-mono text-[13px]')
  return (
    <TextField {...rest} aria-label={hideLabel ? label : undefined} className={cx('flex flex-col gap-1.5', className)}>
      {!hideLabel && <Label className="text-[13px] font-medium [overflow-wrap:anywhere] text-subtle">{label}</Label>}
      {multiline ? <TextArea rows={p.rows ?? 6} className={cx(cls, 'py-2 leading-5')} /> : <Input inputMode={inputMode} className={cx(cls, 'h-9')} />}
      {description && !p.isInvalid && <Text slot="description" className="text-xs text-muted">{description}</Text>}
      <FieldError className="text-xs text-bad">{p.errorMessage}</FieldError>
    </TextField>
  )
}

export function Switch({ isSelected, onChange, children, label, isDisabled }: { isSelected: boolean; onChange: (v: boolean) => void; children?: ReactNode; label?: string; isDisabled?: boolean }) {
  return (
    <RSwitch isSelected={isSelected} onChange={onChange} aria-label={label} isDisabled={isDisabled} className="group inline-flex items-center gap-2 text-sm cursor-pointer outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50">
      <span className="flex h-5 w-9 items-center rounded-full bg-hl-high p-0.5 transition-colors duration-(--dur-2) group-data-[selected]:bg-accent group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-accent/40">
        <span className="h-4 w-4 rounded-full bg-surface shadow transition-transform duration-(--dur-2) ease-(--ease-std) group-data-[selected]:translate-x-4 group-data-[pressed]:scale-90" />
      </span>
      {children}
    </RSwitch>
  )
}

export function Segmented<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; options: { id: T; label: ReactNode }[]; label: string
}) {
  const [ref, ind] = useIndicator<HTMLDivElement>('[data-selected]', value)
  return (
    <ToggleButtonGroup
      ref={ref}
      aria-label={label}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={new Set<Key>([value])}
      onSelectionChange={(k) => { const v = [...k][0]; if (v !== undefined) onChange(v as T) }}
      className="no-scrollbar relative inline-flex max-w-full overflow-x-auto rounded-full bg-overlay p-0.5"
    >
      {ind && <span aria-hidden className={cx('absolute top-0 left-0 rounded-full bg-surface shadow-sm', ind.ready && 'rp-slide')}
        style={{ transform: `translate(${ind.x}px, ${ind.y}px)`, width: ind.w, height: ind.h }} />}
      {options.map((o) => (
        <ToggleButton key={o.id} id={o.id}
          className="relative h-7 shrink-0 rounded-full px-3 text-[13px] font-medium whitespace-nowrap text-subtle outline-none transition-colors duration-(--dur-1) cursor-pointer hover:text-text data-[selected]:text-text focus-visible:ring-2 focus-visible:ring-accent">
          {o.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  )
}

export const popoverCls = cx('rounded-[12px] border bg-surface p-1 shadow-[0_8px_24px_rgb(0_0_0/0.12)] outline-none',
  'origin-(--trigger-anchor-point) data-[entering]:animate-pop-in data-[exiting]:animate-pop-out')
export const menuItemCls = 'flex cursor-pointer items-center gap-2 rounded-[8px] px-3 py-1.5 text-sm outline-none transition-colors duration-(--dur-1) data-[focused]:bg-overlay data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40'

export function Select<T extends string>({ label, value, onChange, options, className, description, placeholder, hideLabel }: {
  label: string; value: T; onChange: (v: T) => void; options: { id: T; label: string }[]; className?: string
  description?: ReactNode; placeholder?: string; hideLabel?: boolean
}) {
  return (
    <RSelect selectedKey={value} onSelectionChange={(k) => k !== null && onChange(k as T)} aria-label={hideLabel ? label : undefined} className={cx('flex flex-col gap-1.5', className)}>
      {!hideLabel && <Label className="text-[13px] font-medium [overflow-wrap:anywhere] text-subtle">{label}</Label>}
      <RButton className="flex h-9 items-center justify-between gap-2 rounded-[10px] border border-border-strong bg-base px-3 text-left text-sm outline-none cursor-pointer transition-[border-color,box-shadow] duration-(--dur-1) focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25">
        <SelectValue className="truncate data-[placeholder]:text-muted">{({ selectedText, isPlaceholder }) => isPlaceholder ? (placeholder ?? '请选择') : selectedText}</SelectValue>
        <span aria-hidden className="text-muted">▾</span>
      </RButton>
      {description && <Text slot="description" className="text-xs text-muted">{description}</Text>}
      <Popover className={cx('min-w-(--trigger-width)', popoverCls)}>
        <ListBox className="max-h-72 overflow-auto outline-none">
          {options.map((o) => (
            <ListBoxItem key={o.id} id={o.id} textValue={o.label}
              className="flex cursor-pointer items-center justify-between gap-3 rounded-[8px] px-3 py-1.5 text-sm outline-none transition-colors duration-(--dur-1) data-[focused]:bg-overlay data-[selected]:text-accent">
              {({ isSelected }) => <>{o.label}{isSelected && <IconCheck size={14} className="animate-check" />}</>}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </RSelect>
  )
}

export type MenuEntry = { id: string; label: ReactNode; danger?: boolean; isDisabled?: boolean; icon?: ReactNode } | 'sep'

/** "⋯" style menu. */
export function ActionMenu({ label, items, onAction, trigger, placement = 'bottom end', triggerClassName }: {
  label: string; items: MenuEntry[]; onAction: (id: string) => void; trigger?: ReactNode; placement?: PopoverProps['placement']; triggerClassName?: string
}) {
  return (
    <MenuTrigger>
      {trigger ?? <IconButton label={label} className={triggerClassName}><IconMore /></IconButton>}
      <Popover placement={placement} className={cx('min-w-[180px]', popoverCls)}>
        <Menu aria-label={label} className="outline-none" onAction={(k) => onAction(String(k))}
          disabledKeys={items.filter((i) => i !== 'sep' && i.isDisabled).map((i) => (i as { id: string }).id)}>
          {items.map((it, i) => it === 'sep'
            ? <Separator key={'s' + i} className="my-1 h-px bg-hl-med/70" />
            : <MenuItem key={it.id} id={it.id} textValue={typeof it.label === 'string' ? it.label : it.id}
              className={cx(menuItemCls, it.danger && 'text-love data-[focused]:bg-love/10')}>{it.icon}{it.label}</MenuItem>)}
        </Menu>
      </Popover>
    </MenuTrigger>
  )
}

// ---- overlays ---------------------------------------------------------------

function useGuardedClose(onOpenChange: (v: boolean) => void, dirty?: boolean) {
  const [ask, setAsk] = useState(false)
  const request = useCallback((v: boolean) => {
    if (!v && dirty) { setAsk(true); return }
    onOpenChange(v)
  }, [dirty, onOpenChange])
  const guard = (
    <Confirm isOpen={ask} onOpenChange={setAsk} title="放弃未保存的修改？" danger confirmLabel="放弃修改"
      body="表单里有还没保存的修改，关闭后会丢失。" onConfirm={() => onOpenChange(false)} />
  )
  return [request, guard] as const
}

export function ModalDialog({ isOpen, onOpenChange, title, children, footer, wide, dirty, label }: {
  isOpen: boolean; onOpenChange: (v: boolean) => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean
  /** Ask before closing (unsaved form). */
  dirty?: boolean; label?: string
}) {
  const [request, guard] = useGuardedClose(onOpenChange, dirty)
  return (
    <ModalOverlay isOpen={isOpen} onOpenChange={request} isDismissable
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-3 pt-[6vh] backdrop-blur-[2px] data-[entering]:animate-fade-in data-[exiting]:animate-fade-out sm:p-4 sm:pt-[8vh]">
      <Modal className={cx('w-full rounded-[16px] border bg-surface shadow-[0_8px_24px_rgb(0_0_0/0.18)] outline-none data-[entering]:animate-modal-in data-[exiting]:animate-modal-out', wide ? 'max-w-[860px]' : 'max-w-[560px]')}>
        <Dialog className="outline-none" aria-label={label ?? (typeof title === 'string' ? title : undefined)}>
          <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-2 sm:px-6">
            <Heading slot="title" className="min-w-0 text-lg font-semibold [overflow-wrap:anywhere]">{title}</Heading>
            <IconButton label="关闭" onPress={() => request(false)}><IconX /></IconButton>
          </div>
          <div className="px-5 py-3 sm:px-6">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t px-5 py-4 sm:px-6">{footer}</div>}
        </Dialog>
      </Modal>
      {guard}
    </ModalOverlay>
  )
}

/** Side panel on desktop, bottom sheet below 640px. Changing `contentKey` cross-fades the body without re-sliding. */
export function Drawer({ isOpen, onOpenChange, title, label, children, actions, contentKey, dirty }: {
  isOpen: boolean; onOpenChange: (v: boolean) => void; title: ReactNode; label?: string; children: ReactNode
  actions?: ReactNode; contentKey?: string | number; dirty?: boolean
}) {
  const [request, guard] = useGuardedClose(onOpenChange, dirty)
  return (
    <ModalOverlay isOpen={isOpen} onOpenChange={request} isDismissable className="fixed inset-0 z-50 bg-black/25 data-[entering]:animate-fade-in data-[exiting]:animate-fade-out">
      <Modal className={cx('fixed flex flex-col bg-surface shadow-[0_8px_24px_rgb(0_0_0/0.18)] outline-none',
        'inset-x-0 bottom-0 max-h-[92vh] rounded-t-[20px] border-t data-[entering]:animate-sheet-in data-[exiting]:animate-sheet-out',
        'sm:inset-y-0 sm:right-0 sm:left-auto sm:max-h-none sm:w-full sm:max-w-[640px] sm:rounded-none sm:border-t-0 sm:border-l sm:data-[entering]:animate-drawer-in sm:data-[exiting]:animate-drawer-out')}>
        <Dialog className="flex min-h-0 flex-1 flex-col outline-none" aria-label={label ?? (typeof title === 'string' ? title : '详情')}>
          <div className="shrink-0 border-b bg-surface">
            <div className="flex justify-center pt-2 sm:hidden" aria-hidden><span className="h-1 w-10 rounded-full bg-hl-high" /></div>
            <div className="flex items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4">
              <div key={contentKey} className="min-w-0 flex-1 animate-content-in text-lg font-semibold">{title}</div>
              <div className="flex shrink-0 items-center gap-1">
                {actions}
                <IconButton label="关闭" onPress={() => request(false)}><IconX /></IconButton>
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div key={contentKey} className="animate-content-in-late p-4 pb-[calc(16px+env(safe-area-inset-bottom))] sm:p-6">{children}</div>
          </div>
        </Dialog>
      </Modal>
      {guard}
    </ModalOverlay>
  )
}

export function Confirm({ isOpen, onOpenChange, title, body, confirmLabel = '确认', onConfirm, danger, requireText }: {
  isOpen: boolean; onOpenChange: (v: boolean) => void; title: string; body: ReactNode; confirmLabel?: string; onConfirm: () => void; danger?: boolean
  /** The user must type this exactly (e.g. the number of affected users) before confirming. */
  requireText?: string
}) {
  const [typed, setTyped] = useState('')
  const sticky = useSticky(isOpen ? { body, requireText, confirmLabel } : null)
  useEffect(() => { if (isOpen) setTyped('') }, [isOpen])
  const blocked = !!sticky?.requireText && typed.trim() !== sticky.requireText
  const go = () => { if (blocked) return; onConfirm(); onOpenChange(false) }
  return (
    <ModalDialog isOpen={isOpen} onOpenChange={onOpenChange} title={title}
      footer={<>
        <Button onPress={() => onOpenChange(false)}>取消</Button>
        <Button variant={danger ? 'danger-solid' : 'primary'} isDisabled={blocked} onPress={go}>{sticky?.confirmLabel}</Button>
      </>}>
      <div className="text-sm text-subtle">{sticky?.body}</div>
      {sticky?.requireText && (
        <form className="mt-4" onSubmit={(e) => { e.preventDefault(); go() }}>
          <Field label={`输入 ${sticky.requireText} 确认`} value={typed} onChange={setTyped} autoFocus inputMode="numeric" />
        </form>
      )}
    </ModalDialog>
  )
}

// ---- data display -----------------------------------------------------------

export function Progress({ value, tone }: { value: number; tone?: 'auto' | 'accent' }) {
  const v = Math.max(0, Math.min(100, value))
  const color = tone === 'accent' ? 'bg-accent' : v >= 95 ? 'bg-bad' : v >= 80 ? 'bg-warn' : 'bg-accent'
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-overlay" role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx('h-full rounded-full transition-[width,background-color] duration-300', color)} style={{ width: `${v}%` }} />
    </div>
  )
}

export function Empty({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex animate-content-in flex-col items-center justify-center gap-2 px-4 py-12 text-center">
      <div className="text-[15px] font-medium">{title}</div>
      {hint && <div className="max-w-sm text-[13px] text-subtle">{hint}</div>}
      {action && <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} />
}

export function Stat({ label, value, sub, icon }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="min-w-0 animate-content-in rounded-[16px] border bg-surface p-4 sm:p-5">
      <div className="flex items-center gap-2 text-[13px] text-subtle">{icon}{label}</div>
      <div key={typeof value === 'string' ? value : undefined} className="mt-2 animate-num text-[20px] leading-7 font-semibold tabular sm:text-[24px] sm:leading-8">{value}</div>
      {sub && <div className="mt-1 text-xs text-subtle tabular">{sub}</div>}
    </div>
  )
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[22px] leading-7 font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 text-[13px] text-subtle">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** Relative time in a <time> element; the absolute time shows on hover. */
export function RelTime({ ts, text, className }: { ts: number; text: string; className?: string }) {
  if (!ts) return <span className={className}>{text}</span>
  const d = new Date(ts * 1000)
  return <time dateTime={d.toISOString()} title={d.toLocaleString('zh-CN', { hour12: false })} className={className}>{text}</time>
}

// ---- toasts -----------------------------------------------------------------

export type ToastTone = 'good' | 'bad' | 'info' | 'pending'
export type ToastOpts = { tone?: ToastTone; text: ReactNode; action?: { label: string; onPress: () => void }; duration?: number; link?: { label: string; href: string } }
type ToastItem = ToastOpts & { id: number; leaving?: boolean }
export type ToastApi = ((tone: ToastTone, text: ReactNode) => number) & {
  show: (o: ToastOpts) => number
  update: (id: number, o: Partial<ToastOpts>) => void
  dismiss: (id: number) => void
}
const noop = Object.assign(() => 0, { show: () => 0, update: () => {}, dismiss: () => {} }) as ToastApi
const ToastCtx = createContext<ToastApi>(noop)
export const useToast = () => useContext(ToastCtx)

const toastLife = (o: ToastOpts) => o.duration ?? (o.tone === 'pending' ? 0 : o.action ? 8000 : o.tone === 'bad' ? 6000 : 3000)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const seq = useRef(0)
  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id)); timers.current.delete(id)
    setItems((x) => x.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 160)
  }, [])
  const arm = useCallback((id: number, o: ToastOpts) => {
    clearTimeout(timers.current.get(id))
    const life = toastLife(o)
    if (life > 0) timers.current.set(id, setTimeout(() => dismiss(id), life))
  }, [dismiss])
  const api = useMemo<ToastApi>(() => {
    const show = (o: ToastOpts) => {
      const id = ++seq.current
      setItems((x) => [...x.slice(-3), { ...o, tone: o.tone ?? 'good', id }])
      arm(id, o)
      return id
    }
    const update = (id: number, o: Partial<ToastOpts>) => {
      setItems((x) => x.map((t) => {
        if (t.id !== id) return t
        const n = { ...t, ...o }
        arm(id, n)
        return n
      }))
    }
    return Object.assign((tone: ToastTone, text: ReactNode) => show({ tone, text }), { show, update, dismiss })
  }, [arm, dismiss])
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-[calc(72px+env(safe-area-inset-bottom)+var(--toast-lift,0px))] left-1/2 z-[60] flex w-max max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col items-center gap-2 transition-[bottom] duration-(--dur-3) lg:bottom-[calc(16px+var(--toast-lift,0px))]" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx('pointer-events-auto flex max-w-[min(560px,calc(100vw-32px))] items-center gap-2.5 rounded-[18px] border bg-surface py-2 pr-2 pl-4 text-sm shadow-[0_8px_24px_rgb(0_0_0/0.14)]',
            t.leaving ? 'animate-toast-out' : 'animate-toast-in')}>
            <span key={t.tone} className="grid shrink-0 animate-check place-items-center">
              {t.tone === 'good' ? <IconCheck size={16} className="text-good" />
                : t.tone === 'bad' ? <IconAlert size={16} className="text-bad" />
                  : t.tone === 'pending' ? <Spinner size={14} className="text-accent" />
                    : <span className="m-1 h-2 w-2 rounded-full bg-accent" />}
            </span>
            <span key={String(t.text)} className="min-w-0 animate-content-in py-0.5">{t.text}</span>
            {t.link && <a href={t.link.href} onClick={() => dismiss(t.id)} className="shrink-0 rounded-full px-2 py-1 text-[13px] font-medium text-accent hover:bg-overlay">{t.link.label}</a>}
            {t.action && (
              <button type="button" onClick={() => { t.action!.onPress(); dismiss(t.id) }}
                className="shrink-0 cursor-pointer rounded-full bg-overlay px-3 py-1 text-[13px] font-medium text-text outline-none hover:bg-hl-med focus-visible:ring-2 focus-visible:ring-accent">{t.action.label}</button>
            )}
            {(t.tone === 'bad' || t.action || t.tone === 'pending' || t.link) ? (
              <button type="button" aria-label="关闭通知" onClick={() => dismiss(t.id)}
                className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-full text-muted outline-none hover:bg-overlay hover:text-text focus-visible:ring-2 focus-visible:ring-accent"><IconX size={14} /></button>
            ) : <span className="w-2" />}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

// ---- copy -------------------------------------------------------------------

/** Clipboard write with a textarea fallback for plain-http panels (no Clipboard API there). */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return } catch { /* fall through */ }
  }
  const host = (document.activeElement?.closest('[role=dialog]') as HTMLElement | null) ?? document.body
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0'
  host.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  if (!ok) throw new Error('复制失败')
}

export function useCopy() {
  const [copied, setCopied] = useState(false)
  const toast = useToast()
  const t = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(t.current), [])
  const copy = useCallback((text: string) => {
    copyText(text).then(() => {
      setCopied(true)
      clearTimeout(t.current)
      t.current = setTimeout(() => setCopied(false), 1500)
    }, () => toast('bad', '复制失败，请手动选择文本'))
  }, [toast])
  return [copied, copy] as const
}

export function CopyIcon({ copied, size = 14, className }: { copied: boolean; size?: number; className?: string }) {
  return copied
    ? <IconCheck key="ok" size={size} className={cx('shrink-0 animate-check text-good', className)} />
    : <IconCopy key="cp" size={size} className={cx('shrink-0 animate-content-in', className)} />
}

export function CopyText({ text, display, className }: { text: string; display?: string; className?: string }) {
  const [copied, copy] = useCopy()
  return (
    <RButton
      onPress={() => copy(text)}
      aria-label={copied ? '已复制' : `复制 ${display ?? ''}`.trim()}
      className={cx('group inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-[8px] font-mono text-[12px] text-subtle outline-none cursor-pointer hover:text-text focus-visible:ring-2 focus-visible:ring-accent', className)}
    >
      <span className={cx('truncate', copied && display && 'text-good')}>{copied && display ? '已复制' : (display ?? text)}</span>
      <CopyIcon copied={copied} className={copied ? '' : 'opacity-60 group-hover:opacity-100'} />
      {copied && !display && <span className="shrink-0 animate-content-in font-sans text-[11px] text-good">已复制</span>}
    </RButton>
  )
}

/** A regular button that copies and confirms inline. */
export function CopyButton({ text, label = '复制', size = 'sm', variant = 'secondary', className, isDisabled }: {
  text: string | (() => string); label?: string; size?: 'sm' | 'md'; variant?: Variant; className?: string; isDisabled?: boolean
}) {
  const [copied, copy] = useCopy()
  return (
    <Button size={size} variant={variant} className={className} isDisabled={isDisabled} onPress={() => copy(typeof text === 'function' ? text() : text)}>
      <CopyIcon copied={copied} />
      <span key={String(copied)} className="animate-content-in">{copied ? '已复制' : label}</span>
    </Button>
  )
}

// ---- form bits --------------------------------------------------------------

export function Checkbox({ isSelected, onChange, children, isDisabled, isIndeterminate, label, className }: {
  isSelected: boolean; onChange: (v: boolean) => void; children?: ReactNode; isDisabled?: boolean; isIndeterminate?: boolean; label?: string; className?: string
}) {
  return (
    <RCheckbox isSelected={isSelected} onChange={onChange} isDisabled={isDisabled} isIndeterminate={isIndeterminate} aria-label={label}
      className={cx('group inline-flex cursor-pointer items-center gap-2 text-sm outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50', className)}>
      <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] border-2 border-hl-high bg-base text-on-accent transition-colors duration-(--dur-1) group-data-[selected]:border-accent group-data-[selected]:bg-accent group-data-[indeterminate]:border-accent group-data-[indeterminate]:bg-accent group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-accent/40 group-data-[pressed]:scale-90">
        {isIndeterminate
          ? <span className="h-0.5 w-2 animate-check rounded bg-current" />
          : <IconCheck size={12} strokeWidth={3} className="hidden group-data-[selected]:block group-data-[selected]:animate-check" />}
      </span>
      {children}
    </RCheckbox>
  )
}

/** Multi-select as a wrapping list of checkboxes. */
export function CheckList<T extends string | number>({ label, options, value, onChange, empty }: {
  label: string; options: { id: T; label: ReactNode; hint?: ReactNode }[]; value: T[]; onChange: (v: T[]) => void; empty?: ReactNode
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-1.5 text-[13px] font-medium text-subtle">{label}</legend>
      {options.length === 0 ? <div className="text-[13px] text-muted">{empty ?? '暂无选项'}</div> : (
        <div className="flex flex-col gap-2 rounded-[10px] border bg-base p-3">
          {options.map((o) => (
            <Checkbox key={String(o.id)} isSelected={value.includes(o.id)}
              onChange={(v) => onChange(v ? [...value, o.id] : value.filter((x) => x !== o.id))}>
              <span>{o.label}{o.hint && <span className="ml-2 text-xs text-muted">{o.hint}</span>}</span>
            </Checkbox>
          ))}
        </div>
      )}
    </fieldset>
  )
}

export function Tabs<T extends string>({ value, onChange, tabs, label }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: ReactNode; count?: number }[]; label?: string }) {
  const [ref, ind] = useIndicator<HTMLDivElement>('[aria-selected=true]', value)
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const i = tabs.findIndex((t) => t.id === value)
    const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    onChange(n.id)
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[aria-selected=true]')?.focus())
  }
  return (
    <div ref={ref} role="tablist" aria-label={label} onKeyDown={onKey} className="no-scrollbar relative mb-4 flex gap-1 overflow-x-auto shadow-[inset_0_-1px_0_color-mix(in_srgb,var(--hl-med)_70%,transparent)]">
      {tabs.map((t) => (
        <button key={t.id} role="tab" type="button" aria-selected={t.id === value} tabIndex={t.id === value ? 0 : -1} onClick={() => onChange(t.id)}
          className={cx('flex h-9 shrink-0 cursor-pointer items-center gap-1.5 px-3 text-sm whitespace-nowrap outline-none transition-colors duration-(--dur-1) focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
            t.id === value ? 'font-medium text-text' : 'text-subtle hover:text-text')}>
          {t.label}
          {t.count !== undefined && <span className="rounded-full bg-overlay px-1.5 text-[11px] text-subtle tabular">{t.count}</span>}
        </button>
      ))}
      {ind && <span aria-hidden className={cx('absolute bottom-0 left-0 h-0.5 rounded-full bg-accent', ind.ready && 'rp-slide')}
        style={{ transform: `translateX(${ind.x}px)`, width: ind.w }} />}
    </div>
  )
}

export function Callout({ tone = 'neutral', children }: { tone?: 'neutral' | 'warn' | 'bad' | 'good'; children: ReactNode }) {
  const c = { neutral: 'bg-overlay text-subtle', warn: 'bg-warn/10 text-warn', bad: 'bg-bad/10 text-bad', good: 'bg-good/10 text-good' }[tone]
  return <div className={cx('animate-content-in rounded-[10px] px-3 py-2 text-[13px] leading-5', c)}>{children}</div>
}

/** Filter chip with a count (aria-pressed toggle). */
export function Chip({ active, onPress, children, count, tone }: { active: boolean; onPress: () => void; children: ReactNode; count?: number; tone?: 'warn' | 'bad' }) {
  return (
    <button type="button" aria-pressed={active} onClick={onPress}
      className={cx('inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[13px] whitespace-nowrap outline-none transition-[background-color,color,border-color,transform] duration-(--dur-1) active:scale-[.97] focus-visible:ring-2 focus-visible:ring-accent',
        active ? 'border-accent bg-accent text-on-accent' : 'border-transparent bg-overlay text-subtle hover:text-text')}>
      {children}
      {count !== undefined && <span className={cx('rounded-full px-1.5 text-[11px] tabular', active ? 'bg-on-accent/20' : tone === 'bad' && count > 0 ? 'bg-bad/15 text-bad' : tone === 'warn' && count > 0 ? 'bg-warn/15 text-warn' : 'bg-surface')}>{count}</span>}
    </button>
  )
}
