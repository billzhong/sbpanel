import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import {
  Button as RButton, type ButtonProps, Dialog, Heading, Modal, ModalOverlay, TextField, Label, Input, TextArea,
  Switch as RSwitch, ToggleButton, ToggleButtonGroup, type Key, Select as RSelect, SelectValue, Popover, ListBox,
  ListBoxItem, FieldError, Text,
} from 'react-aria-components'
import { IconX, IconCheck, IconAlert, IconCopy } from './icons'

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ')
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
const variants: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent hover:brightness-110 data-[pressed]:brightness-95',
  secondary: 'bg-overlay text-text hover:bg-hl-med/70',
  ghost: 'bg-transparent text-subtle hover:bg-overlay hover:text-text',
  danger: 'bg-love/10 text-love hover:bg-love/20',
}

export function Button({ variant = 'secondary', size = 'md', className, ...p }: ButtonProps & { variant?: Variant; size?: 'sm' | 'md' }) {
  return (
    <RButton
      {...p}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-full font-medium whitespace-nowrap transition-[filter,background-color,color] duration-150 outline-none',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base',
        'disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer',
        size === 'sm' ? 'h-7 px-3 text-[13px]' : 'h-8 px-4 text-sm',
        variants[variant], className as string,
      )}
    />
  )
}

export function IconButton({ label, className, ...p }: ButtonProps & { label: string }) {
  return (
    <RButton
      aria-label={label}
      {...p}
      className={cx('inline-flex h-8 w-8 items-center justify-center rounded-full text-subtle outline-none transition-colors cursor-pointer',
        'hover:bg-overlay hover:text-text focus-visible:ring-2 focus-visible:ring-accent', className as string)}
    />
  )
}

export function Card({ className, children, title, action, pad = true }: { className?: string; children: ReactNode; title?: ReactNode; action?: ReactNode; pad?: boolean }) {
  return (
    <section className={cx('rounded-[16px] border bg-surface', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-1">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <div className="flex items-center gap-2">{action}</div>
        </header>
      )}
      <div className={pad ? 'p-5 pt-3' : ''}>{children}</div>
    </section>
  )
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
    <span className={cx('inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap', tones[tone])}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

export function Field({ label, description, multiline, mono, className, ...p }: {
  label: string; description?: string; multiline?: boolean; mono?: boolean; className?: string
  value?: string; onChange?: (v: string) => void; placeholder?: string; type?: string; isRequired?: boolean
  autoFocus?: boolean; isInvalid?: boolean; errorMessage?: string; rows?: number; name?: string; autoComplete?: string
}) {
  const inputCls = cx('w-full rounded-[10px] border bg-base px-3 text-sm outline-none transition-colors',
    'placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/25 invalid:border-bad', mono && 'font-mono text-[13px]')
  return (
    <TextField {...p} className={cx('flex flex-col gap-1.5', className)}>
      <Label className="text-[13px] font-medium text-subtle">{label}</Label>
      {multiline ? <TextArea rows={p.rows ?? 6} className={cx(inputCls, 'py-2 leading-5')} /> : <Input className={cx(inputCls, 'h-9')} />}
      {description && <Text slot="description" className="text-xs text-muted">{description}</Text>}
      <FieldError className="text-xs text-bad">{p.errorMessage}</FieldError>
    </TextField>
  )
}

export function Switch({ isSelected, onChange, children }: { isSelected: boolean; onChange: (v: boolean) => void; children?: ReactNode }) {
  return (
    <RSwitch isSelected={isSelected} onChange={onChange} className="group inline-flex items-center gap-2 text-sm cursor-pointer outline-none">
      <span className="flex h-5 w-9 items-center rounded-full bg-hl-high p-0.5 transition-colors group-data-[selected]:bg-accent group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-accent/40">
        <span className="h-4 w-4 rounded-full bg-surface shadow transition-transform duration-150 group-data-[selected]:translate-x-4" />
      </span>
      {children}
    </RSwitch>
  )
}

export function Segmented<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; options: { id: T; label: ReactNode }[]; label: string
}) {
  return (
    <ToggleButtonGroup
      aria-label={label}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={new Set<Key>([value])}
      onSelectionChange={(k) => { const v = [...k][0]; if (v !== undefined) onChange(v as T) }}
      className="inline-flex rounded-full bg-overlay p-0.5"
    >
      {options.map((o) => (
        <ToggleButton key={o.id} id={o.id}
          className="h-7 rounded-full px-3 text-[13px] font-medium text-subtle outline-none transition-colors cursor-pointer hover:text-text data-[selected]:bg-surface data-[selected]:text-text data-[selected]:shadow-sm focus-visible:ring-2 focus-visible:ring-accent">
          {o.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  )
}

export function Select<T extends string>({ label, value, onChange, options, className }: {
  label: string; value: T; onChange: (v: T) => void; options: { id: T; label: string }[]; className?: string
}) {
  return (
    <RSelect selectedKey={value} onSelectionChange={(k) => k !== null && onChange(k as T)} className={cx('flex flex-col gap-1.5', className)}>
      <Label className="text-[13px] font-medium text-subtle">{label}</Label>
      <RButton className="flex h-9 items-center justify-between gap-2 rounded-[10px] border bg-base px-3 text-left text-sm outline-none cursor-pointer focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25">
        <SelectValue className="truncate" />
        <span aria-hidden className="text-muted">▾</span>
      </RButton>
      <Popover className="min-w-(--trigger-width) rounded-[12px] border bg-surface p-1 shadow-[0_8px_24px_rgb(0_0_0/0.12)] animate-pop">
        <ListBox className="max-h-72 overflow-auto outline-none">
          {options.map((o) => (
            <ListBoxItem key={o.id} id={o.id} textValue={o.label}
              className="flex cursor-pointer items-center justify-between rounded-[8px] px-3 py-1.5 text-sm outline-none focus:bg-overlay data-[selected]:text-accent">
              {({ isSelected }) => <>{o.label}{isSelected && <IconCheck size={14} />}</>}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </RSelect>
  )
}

export function ModalDialog({ isOpen, onOpenChange, title, children, footer, wide }: {
  isOpen: boolean; onOpenChange: (v: boolean) => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean
}) {
  return (
    <ModalOverlay isOpen={isOpen} onOpenChange={onOpenChange} isDismissable
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 pt-[8vh] backdrop-blur-[2px] data-[entering]:animate-fade">
      <Modal className={cx('w-full rounded-[16px] border bg-surface shadow-[0_8px_24px_rgb(0_0_0/0.18)] outline-none data-[entering]:animate-pop', wide ? 'max-w-[860px]' : 'max-w-[560px]')}>
        <Dialog className="outline-none">
          {({ close }) => (
            <>
              <div className="flex items-center justify-between px-6 pt-5 pb-2">
                <Heading slot="title" className="text-lg font-semibold">{title}</Heading>
                <IconButton label="关闭" onPress={close}><IconX /></IconButton>
              </div>
              <div className="px-6 py-3">{children}</div>
              {footer && <div className="flex justify-end gap-2 border-t px-6 py-4">{footer}</div>}
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}

export function Drawer({ isOpen, onOpenChange, title, children }: { isOpen: boolean; onOpenChange: (v: boolean) => void; title: ReactNode; children: ReactNode }) {
  return (
    <ModalOverlay isOpen={isOpen} onOpenChange={onOpenChange} isDismissable className="fixed inset-0 z-50 bg-black/20 data-[entering]:animate-fade">
      <Modal className="fixed inset-y-0 right-0 w-full max-w-[640px] overflow-y-auto border-l bg-surface shadow-[0_8px_24px_rgb(0_0_0/0.18)] outline-none">
        <Dialog className="outline-none" aria-label={typeof title === 'string' ? title : 'details'}>
          {({ close }) => (
            <>
              <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-surface/95 px-6 py-4 backdrop-blur">
                <div className="text-lg font-semibold">{title}</div>
                <IconButton label="关闭" onPress={close}><IconX /></IconButton>
              </div>
              <div className="p-6">{children}</div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}

export function Progress({ value, tone }: { value: number; tone?: 'auto' | 'accent' }) {
  const v = Math.max(0, Math.min(100, value))
  const color = tone === 'accent' ? 'bg-accent' : v >= 95 ? 'bg-bad' : v >= 80 ? 'bg-warn' : 'bg-accent'
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-overlay" role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx('h-full rounded-full transition-[width] duration-300', color)} style={{ width: `${v}%` }} />
    </div>
  )
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="text-[15px] font-medium">{title}</div>
      {hint && <div className="max-w-sm text-[13px] text-subtle">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} />
}

export function Stat({ label, value, sub, icon }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="rounded-[16px] border bg-surface p-5">
      <div className="flex items-center gap-2 text-[13px] text-subtle">{icon}{label}</div>
      <div className="mt-2 text-[24px] leading-8 font-semibold tabular">{value}</div>
      {sub && <div className="mt-1 text-xs text-subtle tabular">{sub}</div>}
    </div>
  )
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[22px] leading-7 font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 text-[13px] text-subtle">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

// ---- toasts ----
type ToastT = { id: number; tone: 'good' | 'bad'; text: string }
const ToastCtx = createContext<(tone: ToastT['tone'], text: string) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastT[]>([])
  const push = useCallback((tone: ToastT['tone'], text: string) => {
    const id = Date.now() + Math.random()
    setItems((x) => [...x, { id, tone, text }])
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === 'bad' ? 6000 : 3000)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="pointer-events-auto flex items-center gap-2 rounded-full border bg-surface px-4 py-2 text-sm shadow-[0_8px_24px_rgb(0_0_0/0.14)] animate-pop">
            {t.tone === 'good' ? <IconCheck size={16} className="text-good" /> : <IconAlert size={16} className="text-bad" />}
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export function CopyText({ text, display, className }: { text: string; display?: string; className?: string }) {
  const toast = useToast()
  return (
    <RButton
      onPress={() => { navigator.clipboard?.writeText(text).then(() => toast('good', '已复制'), () => toast('bad', '复制失败')) }}
      className={cx('group inline-flex max-w-full items-center gap-1.5 rounded-[8px] font-mono text-[12px] text-subtle outline-none cursor-pointer hover:text-text focus-visible:ring-2 focus-visible:ring-accent', className)}
    >
      <span className="truncate">{display ?? text}</span>
      <IconCopy size={14} className="shrink-0 opacity-60 group-hover:opacity-100" />
    </RButton>
  )
}

export function Confirm({ isOpen, onOpenChange, title, body, confirmLabel = '确认', onConfirm, danger }: {
  isOpen: boolean; onOpenChange: (v: boolean) => void; title: string; body: ReactNode; confirmLabel?: string; onConfirm: () => void; danger?: boolean
}) {
  return (
    <ModalDialog isOpen={isOpen} onOpenChange={onOpenChange} title={title}
      footer={<>
        <Button onPress={() => onOpenChange(false)}>取消</Button>
        <Button variant={danger ? 'danger' : 'primary'} onPress={() => { onConfirm(); onOpenChange(false) }}>{confirmLabel}</Button>
      </>}>
      <div className="text-sm text-subtle">{body}</div>
    </ModalDialog>
  )
}
