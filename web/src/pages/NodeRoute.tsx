import { useState, type ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api, type Node } from '../lib/api'
import { useAction } from '../lib/actions'
import { href } from '../lib/router'
import { Badge, Button, Callout, Card, Checkbox, Chip, Confirm, Field, IconButton, ModalDialog, Presence, Segmented, Select, Skeleton, Spinner, cx } from '../ui/kit'
import { IconChevron, IconPlus, IconTrash } from '../ui/icons'
import { tr } from '../i18n'
import { C } from '../i18n/common'
import { NR } from '../i18n/noderoute'

type Rule = Record<string, unknown>
type TagType = { tag: string; type: string }
export type RouteView = {
  template: { id: number; name: string }; outbounds: TagType[]; rule_sets: TagType[]; inbounds: string[]
  template_rules: Rule[]; template_final: string; insert_at: number
  node: { rules: Rule[]; final: string; updated_at: number }
  effective: { rules: { rule: Rule; source: 'template' | 'node' }[]; final: string; final_source: 'template' | 'node' }
  warnings: string[]
}

// ---- rule fields --------------------------------------------------------------

type Kind = 'list' | 'num' | 'bool' | 'multi'
const FIELDS: { key: string; kind: Kind }[] = [
  { key: 'domain_suffix', kind: 'list' }, { key: 'domain', kind: 'list' }, { key: 'domain_keyword', kind: 'list' }, { key: 'domain_regex', kind: 'list' },
  { key: 'ip_cidr', kind: 'list' }, { key: 'ip_is_private', kind: 'bool' }, { key: 'source_ip_cidr', kind: 'list' },
  { key: 'port', kind: 'num' }, { key: 'port_range', kind: 'list' }, { key: 'source_port', kind: 'num' },
  { key: 'network', kind: 'multi' }, { key: 'protocol', kind: 'list' }, { key: 'inbound', kind: 'multi' }, { key: 'rule_set', kind: 'multi' },
  { key: 'auth_user', kind: 'list' },
]
const kindOf = (k: string) => FIELDS.find((f) => f.key === k)?.kind
const fieldLabel = (k: string) => (tr(NR) as Record<string, unknown>)[`f_${k}`] as string | undefined ?? k
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)])

/** One-line human reading of a sing-box rule: "Domain suffix: a.com, b.com · Port: 443  → proxy". */
export function RuleSummary({ rule }: { rule: Rule }) {
  const t = tr(NR)
  const action = String(rule.action ?? 'route')
  if (action === 'sniff') return <span className="text-subtle">{t.sniff}</span>
  if (action === 'hijack-dns') return <span><Conds rule={rule} /> <span className="text-subtle">{t.hijackDns}</span></span>
  if (action === 'resolve') return <span className="text-subtle">{t.resolve}</span>
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <Conds rule={rule} />
      {action === 'reject' ? <Badge tone="bad">{t.reject}</Badge> : <span className="font-medium whitespace-nowrap text-accent">{t.routeTo(String(rule.outbound ?? '?'))}</span>}
    </span>
  )
}

function Conds({ rule }: { rule: Rule }) {
  const t = tr(NR)
  const keys = Object.keys(rule).filter((k) => !['action', 'outbound', 'invert', 'method', 'no_drop', 'type', 'sniffer', 'timeout'].includes(k))
  if (keys.length === 0) return <span className="text-subtle">{t.any}</span>
  return (
    <span className="min-w-0 break-words">
      {rule.invert === true && <b className="mr-1 text-warn">{t.not}</b>}
      {keys.map((k, i) => (
        <span key={k}>{i > 0 && <span className="text-muted"> · </span>}
          <span className="text-subtle">{fieldLabel(k)}</span>{' '}
          <span className="font-mono text-[12px]">{rule[k] === true ? '✓' : asList(rule[k]).join(', ')}</span>
        </span>
      ))}
    </span>
  )
}

// ---- view -----------------------------------------------------------------------

/** Routing tab of the node drawer: the effective route, marked by source, with edit / reset. */
export function NodeRouting({ n }: { n: Node }) {
  const t = tr(NR)
  const q = useQuery({ queryKey: ['node-route', n.id], queryFn: () => api<RouteView>(`/nodes/${n.id}/route`) })
  const [editing, setEditing] = useState<RouteView | null>(null)
  const [resetting, setResetting] = useState(false)
  const reset = useAction({
    fn: () => api(`/nodes/${n.id}/route`, { method: 'DELETE' }),
    success: t.resetDone(n.name), invalidate: [['node-route', n.id], ['nodes']],
  })
  const v = q.data
  if (!v) return <div className="flex flex-col gap-3"><Skeleton className="h-16" /><Skeleton className="h-64" /></div>
  const own = v.node.rules.length + (v.node.final ? 1 : 0)
  const rows = v.effective.rules
  const firstNode = rows.findIndex((r) => r.source === 'node')
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-subtle">{t.template}</span>
        <a className="text-[13px] font-medium text-accent hover:underline" href={href('templates', { id: v.template.id })}>{v.template.name || '—'}</a>
        {own > 0 ? <Badge tone="accent">{t.ownRules(v.node.rules.length)}</Badge> : <Badge>{t.usingTemplate}</Badge>}
        <span className="flex-1" />
        {own > 0 && <Button size="sm" variant="ghost" onPress={() => setResetting(true)}>{t.reset}</Button>}
        <Button size="sm" variant="primary" onPress={() => setEditing(v)}>{t.edit}</Button>
      </div>
      <p className="text-xs text-muted">{t.intro}</p>
      {v.warnings.length > 0 && <Callout tone="warn">{t.warnings}<ul className="mt-1 list-disc pl-5">{v.warnings.map((w) => <li key={w}>{w}</li>)}</ul></Callout>}
      <Card title={t.effective} pad={false}>
        <ol className="pb-2">
          {rows.map((r, i) => (
            <li key={i}>
              {firstNode < 0 && i === v.insert_at && <InsertMark />}
              <RuleRow i={i + 1} rule={r.rule} node={r.source === 'node'} />
            </li>
          ))}
          {firstNode < 0 && v.insert_at >= rows.length && <InsertMark />}
          <li className="mx-3 mt-1 flex items-center gap-3 rounded-[10px] bg-overlay/60 px-3 py-2 text-[13px]">
            <span className="w-5 shrink-0 text-right text-xs text-muted">∗</span>
            <span className="text-subtle">{t.finalLabel}</span>
            <span className="font-medium text-accent">{t.finalTo(v.effective.final || 'direct')}</span>
            <span className="ml-auto"><SourceTag node={v.effective.final_source === 'node'} /></span>
          </li>
        </ol>
      </Card>
      <div className="grid gap-3 text-[13px] sm:grid-cols-2">
        <TagList title={t.outbounds} items={v.outbounds} />
        <TagList title={t.ruleSets} items={v.rule_sets} />
      </div>
      <Presence value={editing}>{(ev, open) => <RouteEditor isOpen={open} n={n} v={ev} onClose={() => setEditing(null)} />}</Presence>
      <Confirm isOpen={resetting} onOpenChange={setResetting} danger title={t.resetTitle} confirmLabel={t.reset}
        body={t.resetBody(n.name, n.online ? n.active_conns : 0)} onConfirm={() => reset.mutate()} />
    </div>
  )
}

function InsertMark() {
  return <div className="mx-3 my-1 flex items-center gap-2 text-[11px] text-accent"><span className="h-px flex-1 border-t border-dashed border-accent/50" />{tr(NR).insertHere}<span className="h-px flex-1 border-t border-dashed border-accent/50" /></div>
}

function SourceTag({ node }: { node: boolean }) {
  const t = tr(NR)
  return <span className={cx('rounded-full px-2 py-0.5 text-[11px] whitespace-nowrap', node ? 'bg-accent/12 font-medium text-accent' : 'bg-overlay text-muted')}>{node ? t.fromNode : t.fromTemplate}</span>
}

function RuleRow({ i, rule, node, mark }: { i: number; rule: Rule; node: boolean; mark?: ReactNode }) {
  return (
    <div className={cx('flex items-start gap-3 border-l-2 px-3 py-2 text-[13px]', node ? 'border-accent bg-accent/5' : 'border-transparent')} title={JSON.stringify(rule)}>
      <span className="w-5 shrink-0 pt-px text-right text-xs text-muted tabular">{i}</span>
      <div className="min-w-0 flex-1"><RuleSummary rule={rule} /></div>
      <span className="flex shrink-0 items-center gap-1.5">{mark}<SourceTag node={node} /></span>
    </div>
  )
}

function TagList({ title, items }: { title: string; items: TagType[] }) {
  return (
    <div className="rounded-[12px] border bg-base p-3">
      <div className="mb-1.5 text-xs text-subtle">{title}</div>
      {items.length === 0 ? <span className="text-xs text-muted">{tr(NR).none}</span> : (
        <div className="flex flex-wrap gap-1">{items.map((o) => <span key={o.tag} className="rounded-full bg-overlay px-2 py-0.5 text-xs"><span className="font-mono">{o.tag}</span> <span className="text-muted">{o.type}</span></span>)}</div>
      )}
    </div>
  )
}

// ---- editor ---------------------------------------------------------------------

type Cond = { key: string; text: string; picks: string[] }
type ERule = { id: number; conds: Cond[]; action: 'route' | 'reject'; outbound: string; invert: boolean; extra: Rule }
let seq = 0

function fromRule(r: Rule): ERule {
  const conds: Cond[] = []
  const extra: Rule = {}
  for (const [k, v] of Object.entries(r)) {
    if (k === 'action' || k === 'outbound' || k === 'invert') continue
    const kind = kindOf(k)
    if (!kind) { extra[k] = v; continue }
    conds.push({ key: k, text: kind === 'list' || kind === 'num' ? asList(v).join('\n') : '', picks: kind === 'multi' ? asList(v) : [] })
  }
  return { id: ++seq, conds, action: r.action === 'reject' ? 'reject' : 'route', outbound: String(r.outbound ?? ''), invert: r.invert === true, extra }
}

const split = (s: string) => s.split(/[\n,，]+/).map((x) => x.trim()).filter(Boolean)

function toRule(e: ERule): Rule {
  const r: Rule = { ...e.extra }
  for (const c of e.conds) {
    const kind = kindOf(c.key)
    if (kind === 'list') r[c.key] = split(c.text)
    else if (kind === 'num') r[c.key] = split(c.text).map(Number)
    else if (kind === 'bool') r[c.key] = true
    else r[c.key] = c.picks
  }
  if (e.invert) r.invert = true
  r.action = e.action
  if (e.action === 'route') r.outbound = e.outbound
  return r
}

function problems(rs: ERule[]): string[] {
  const t = tr(NR)
  const out: string[] = []
  rs.forEach((r, i) => {
    if (r.conds.length === 0 && Object.keys(r.extra).length === 0) out.push(t.needCond(i + 1))
    if (r.conds.some((c) => { const k = kindOf(c.key); return k === 'bool' ? false : k === 'multi' ? c.picks.length === 0 : split(c.text).length === 0 })) out.push(t.emptyCond)
    if (r.action === 'route' && !r.outbound) out.push(t.needOutbound(i + 1))
  })
  return [...new Set(out)]
}

function RouteEditor({ n, v, isOpen, onClose }: { n: Node; v: RouteView; isOpen: boolean; onClose: () => void }) {
  const t = tr(NR)
  const [rules, setRules] = useState<ERule[]>(() => v.node.rules.map(fromRule))
  const [final, setFinal] = useState(v.node.final)
  const [step, setStep] = useState<1 | 2>(1)
  const [check, setCheck] = useState<{ ok: boolean; error?: string } | null>(null)
  const body = () => ({ rules: rules.map(toRule), final })
  const dirty = JSON.stringify(body()) !== JSON.stringify({ rules: v.node.rules.map((r) => toRule(fromRule(r))), final: v.node.final })
  const issues = problems(rules)
  // validation result is shown in the review step, not as a toast
  const dry = useMutation({
    mutationFn: () => api(`/nodes/${n.id}/route`, { method: 'PUT', body: { ...body(), dry_run: true } }),
    onSuccess: () => setCheck({ ok: true }), onError: (e) => setCheck({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  })
  const save = useAction({
    fn: () => api(`/nodes/${n.id}/route`, { method: 'PUT', body: body() }),
    success: t.saved(n.name), invalidate: [['node-route', n.id], ['nodes']], onSuccess: onClose,
  })
  const review = () => { setCheck(null); setStep(2); dry.mutate() }
  const upd = (id: number, f: (r: ERule) => ERule) => setRules(rules.map((r) => (r.id === id ? f(r) : r)))
  const move = (i: number, d: number) => { const a = [...rules]; [a[i], a[i + d]] = [a[i + d], a[i]]; setRules(a) }
  const defOut = v.outbounds.find((o) => o.type === 'direct')?.tag ?? v.outbounds[0]?.tag ?? ''

  const footer = step === 1 ? <>
    <Button onPress={onClose}>{tr(C).cancel}</Button>
    <Button variant="primary" isDisabled={!dirty || issues.length > 0} onPress={review}>{t.review}</Button>
  </> : <>
    <Button variant="ghost" className="mr-auto" onPress={() => setStep(1)}>{t.back}</Button>
    <Button onPress={onClose}>{tr(C).cancel}</Button>
    <Button variant="primary" isDisabled={!check?.ok} isPending={save.isPending} onPress={() => save.mutate()}>{t.apply}</Button>
  </>

  return (
    <ModalDialog wide isOpen={isOpen} onOpenChange={(o) => !o && onClose()} title={t.editTitle(n.name)} dirty={dirty} footer={footer}>
      <div key={step} className="flex animate-content-in flex-col gap-4">
        {step === 1 ? <>
          <p className="text-xs text-muted">{t.intro}</p>
          {rules.length === 0 && <div className="rounded-[12px] border border-dashed px-4 py-6 text-center text-[13px] text-muted">{t.noRules}</div>}
          {rules.map((r, i) => (
            <RuleCard key={r.id} i={i} r={r} v={v} last={i === rules.length - 1}
              onChange={(f) => upd(r.id, f)} onMove={(d) => move(i, d)} onRemove={() => setRules(rules.filter((x) => x.id !== r.id))} />
          ))}
          <div>
            <Button size="sm" onPress={() => setRules([...rules, { id: ++seq, conds: [{ key: 'domain_suffix', text: '', picks: [] }], action: 'route', outbound: defOut, invert: false, extra: {} }])}>
              <IconPlus size={14} />{t.addRule}
            </Button>
          </div>
          <div className="border-t pt-4">
            <Select label={t.finalSel} value={final || '__tpl'} onChange={(x) => setFinal(x === '__tpl' ? '' : x)}
              options={[{ id: '__tpl', label: t.finalDefault(v.template_final || 'direct') }, ...v.outbounds.map((o) => ({ id: o.tag, label: `${o.tag} (${o.type})` }))]} />
          </div>
          {issues.length > 0 && dirty && <Callout tone="warn">{issues.join(' · ')}</Callout>}
        </> : <Review v={v} rules={rules.map(toRule)} final={final} n={n} check={check} checking={dry.isPending} />}
      </div>
    </ModalDialog>
  )
}

function RuleCard({ i, r, v, last, onChange, onMove, onRemove }: {
  i: number; r: ERule; v: RouteView; last: boolean; onChange: (f: (r: ERule) => ERule) => void; onMove: (d: number) => void; onRemove: () => void
}) {
  const t = tr(NR)
  const used = new Set(r.conds.map((c) => c.key))
  const setCond = (k: number, c: Partial<Cond>) => onChange((x) => ({ ...x, conds: x.conds.map((y, j) => (j === k ? { ...y, ...c } : y)) }))
  const options = (key: string) => key === 'network' ? ['tcp', 'udp'] : key === 'inbound' ? v.inbounds : key === 'rule_set' ? v.rule_sets.map((s) => s.tag) : []
  return (
    <section className="rounded-[12px] border bg-base p-3" aria-label={t.rule(i + 1)}>
      <div className="mb-2 flex items-center gap-1">
        <span className="text-[13px] font-semibold">{t.rule(i + 1)}</span>
        <span className="flex-1" />
        <IconButton label={t.moveUp} isDisabled={i === 0} onPress={() => onMove(-1)}><IconChevron dir="up" /></IconButton>
        <IconButton label={t.moveDown} isDisabled={last} onPress={() => onMove(1)}><IconChevron dir="down" /></IconButton>
        <IconButton label={t.remove} onPress={onRemove}><IconTrash size={15} /></IconButton>
      </div>
      <div className="mb-1 text-xs font-medium text-subtle">{t.when}</div>
      <div className="flex flex-col gap-2">
        {r.conds.map((c, k) => {
          const kind = kindOf(c.key)
          return (
            <div key={k} className="grid items-start gap-2 sm:grid-cols-[11rem_1fr_auto]">
              <Select hideLabel label={t.field} value={c.key} onChange={(key) => setCond(k, { key, text: '', picks: [] })}
                options={FIELDS.filter((f) => f.key === c.key || !used.has(f.key)).map((f) => ({ id: f.key, label: fieldLabel(f.key) }))} />
              {kind === 'bool' ? <div className="pt-2 text-xs text-muted">✓</div>
                : kind === 'multi' ? (
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {options(c.key).length === 0 ? <span className="pt-1.5 text-xs text-muted">{t.none}</span> : options(c.key).map((o) => (
                      <Chip key={o} active={c.picks.includes(o)} onPress={() => setCond(k, { picks: c.picks.includes(o) ? c.picks.filter((x) => x !== o) : [...c.picks, o] })}>{o}</Chip>
                    ))}
                  </div>
                ) : kind === 'num' ? <Field hideLabel label={t.values} mono value={c.text} onChange={(text) => setCond(k, { text })} placeholder="443, 8443" />
                : <Field hideLabel label={t.values} multiline rows={Math.min(6, Math.max(2, c.text.split('\n').length + 1))} mono value={c.text} onChange={(text) => setCond(k, { text })} placeholder={t.valuesPh} />}
              <IconButton label={t.removeCond} onPress={() => onChange((x) => ({ ...x, conds: x.conds.filter((_, j) => j !== k) }))}><IconTrash size={14} /></IconButton>
            </div>
          )
        })}
        {Object.keys(r.extra).length > 0 && <div className="rounded-[8px] bg-overlay px-2 py-1 font-mono text-[11px] break-all text-subtle" title={t.other}>{JSON.stringify(r.extra)}</div>}
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="ghost" isDisabled={used.size >= FIELDS.length}
            onPress={() => onChange((x) => ({ ...x, conds: [...x.conds, { key: FIELDS.find((f) => !used.has(f.key))!.key, text: '', picks: [] }] }))}>
            <IconPlus size={14} />{t.addCond}
          </Button>
          <Checkbox isSelected={r.invert} onChange={(invert) => onChange((x) => ({ ...x, invert }))}><span className="text-xs">{t.invert}</span></Checkbox>
        </div>
      </div>
      <div className="mt-3 mb-1 text-xs font-medium text-subtle">{t.then}</div>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label={t.then} value={r.action} onChange={(action) => onChange((x) => ({ ...x, action }))}
          options={[{ id: 'route', label: t.actRoute }, { id: 'reject', label: t.actReject }]} />
        {r.action === 'route' && (
          <div className="min-w-[12rem] flex-1">
            <Select hideLabel label={t.outbound} value={r.outbound} onChange={(outbound) => onChange((x) => ({ ...x, outbound }))}
              placeholder={t.outbound} options={v.outbounds.map((o) => ({ id: o.tag, label: `${o.tag} (${o.type})` }))} />
          </div>
        )}
      </div>
    </section>
  )
}

/** Before/after of the effective route, the sing-box check, and the restart warning. */
function Review({ v, rules, final, n, check, checking }: { v: RouteView; rules: Rule[]; final: string; n: Node; check: { ok: boolean; error?: string } | null; checking: boolean }) {
  const t = tr(NR)
  const key = (r: Rule) => JSON.stringify(r, Object.keys(r).sort())
  const oldKeys = v.node.rules.map(key)
  const newKeys = rules.map(key)
  const tpl = v.template_rules
  const removed = v.node.rules.filter((_, i) => !newKeys.includes(oldKeys[i]))
  const finalOld = v.node.final || v.template_final, finalNew = final || v.template_final
  const changed = removed.length > 0 || finalOld !== finalNew || newKeys.join() !== oldKeys.join()
  let idx = 0
  const mark = (label: string, tone: 'good' | 'bad' | 'warn') => <Badge tone={tone}>{label}</Badge>
  return (
    <div className="flex flex-col gap-3">
      {checking ? <div className="flex items-center gap-2 text-[13px] text-subtle"><Spinner />{t.checking}</div>
        : check?.ok ? <Callout tone="good">{t.valid}</Callout>
          : check?.error ? <Callout tone="bad"><span className="font-mono text-xs break-all">{check.error}</span></Callout> : null}
      {!changed && <div className="text-[13px] text-muted">{t.unchanged}</div>}
      <Card title={t.effective} pad={false}>
        <ol className="pb-2">
          {tpl.slice(0, v.insert_at).map((r, i) => <li key={`a${i}`}><RuleRow i={++idx} rule={r} node={false} /></li>)}
          {rules.map((r, i) => {
            const was = oldKeys.indexOf(newKeys[i])
            return <li key={`n${i}`}><RuleRow i={++idx} rule={r} node mark={was < 0 ? mark(t.added, 'good') : was !== i ? mark(t.moved, 'warn') : undefined} /></li>
          })}
          {removed.map((r, i) => (
            <li key={`r${i}`} className="opacity-60 line-through decoration-bad"><RuleRow i={0} rule={r} node mark={mark(t.removed, 'bad')} /></li>
          ))}
          {tpl.slice(v.insert_at).map((r, i) => <li key={`b${i}`}><RuleRow i={++idx} rule={r} node={false} /></li>)}
          <li className="mx-3 mt-1 flex flex-wrap items-center gap-2 rounded-[10px] bg-overlay/60 px-3 py-2 text-[13px]">
            <span className="text-subtle">{t.finalLabel}</span>
            {finalOld !== finalNew && <span className="text-muted line-through">{finalOld || 'direct'}</span>}
            <span className="font-medium text-accent">{t.finalTo(finalNew || 'direct')}</span>
            <span className="ml-auto"><SourceTag node={!!final} /></span>
          </li>
        </ol>
      </Card>
      <Callout tone="warn">{t.restartWarn(n.name, n.online ? n.active_conns : 0)}</Callout>
    </div>
  )
}
