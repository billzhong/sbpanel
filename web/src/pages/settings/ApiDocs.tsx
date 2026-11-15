import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { href } from '../../lib/router'
import { scopeLabel } from '../../lib/apikeys'
import { Badge, Callout, Card, Chip, CopyButton, Field, PageHeader, Skeleton, cx } from '../../ui/kit'
import { tr, useT } from '../../i18n'
import { AD } from '../../i18n/apidocs'

// A small OpenAPI 3.1 renderer (no CDN bundle: the panel CSP stays tight).

type Schema = {
  $ref?: string; type?: string | string[]; description?: string; enum?: unknown[]; format?: string
  properties?: Record<string, Schema>; required?: string[]; items?: Schema; additionalProperties?: boolean | Schema
}
type Param = { name: string; in: string; description?: string; required?: boolean; schema?: Schema }
type Operation = {
  tags?: string[]; summary?: string; description?: string; operationId?: string; 'x-required-scope'?: string
  parameters?: Param[]; requestBody?: { content: Record<string, { schema: Schema }> }
  responses?: Record<string, { description?: string; $ref?: string; content?: Record<string, { schema: Schema }> }>
}
type Spec = {
  info: { title: string; version: string; description?: string }
  tags?: { name: string; description?: string }[]
  paths: Record<string, Record<string, Operation>>
  components?: { schemas?: Record<string, Schema> }
  'x-scopes'?: { id: string; label: string; description: string }[]
}
type Op = { method: string; path: string; op: Operation; key: string }

const METHOD_TONE: Record<string, string> = {
  get: 'bg-good/12 text-good', post: 'bg-accent/12 text-accent', put: 'bg-warn/15 text-warn', patch: 'bg-warn/15 text-warn', delete: 'bg-bad/12 text-bad',
}
const ORDER = ['get', 'post', 'put', 'patch', 'delete']

export function ApiDocs() {
  const t = useT(AD)
  const spec = useQuery({ queryKey: ['openapi'], queryFn: () => api<Spec>('/openapi.json'), staleTime: Infinity })
  const [q, setQ] = useState('')
  const [tag, setTag] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const ops = useMemo<Op[]>(() => {
    const out: Op[] = []
    for (const [path, m] of Object.entries(spec.data?.paths ?? {}))
      for (const [method, op] of Object.entries(m)) out.push({ method, path, op, key: method + ' ' + path })
    return out.sort((a, b) => a.path.localeCompare(b.path) || ORDER.indexOf(a.method) - ORDER.indexOf(b.method))
  }, [spec.data])
  const tags = spec.data?.tags ?? []
  const needle = q.trim().toLowerCase()
  const shown = ops.filter((o) => (!tag || o.op.tags?.includes(tag)) &&
    (!needle || `${o.method} ${o.path} ${o.op.summary} ${o.op['x-required-scope']}`.toLowerCase().includes(needle)))
  const counts = (t: string) => ops.filter((o) => o.op.tags?.includes(t)).length

  return (
    <div className="animate-page-in">
      <PageHeader title={t.title} subtitle={spec.data ? t.count(spec.data.info.title, ops.length) : 'OpenAPI 3.1'}
        actions={<>
          <a href={href('settings', { s: 'api' })} className="inline-flex h-8 items-center rounded-full bg-overlay px-4 text-sm font-medium text-text outline-none transition-colors duration-(--dur-1) hover:bg-hl-med/70 focus-visible:ring-2 focus-visible:ring-accent">{t.backToSettings}</a>
          <a href="/api/openapi.json" download="sbpanel-openapi.json" className="inline-flex h-8 items-center rounded-full bg-overlay px-4 text-sm font-medium text-text outline-none transition-colors duration-(--dur-1) hover:bg-hl-med/70 focus-visible:ring-2 focus-visible:ring-accent">{t.dlJson}</a>
        </>} />
      {spec.isLoading && <Skeleton className="h-64" />}
      {spec.error && <Callout tone="bad">{t.loadFailed}{(spec.error as Error).message}</Callout>}
      {spec.data && (
        <div className="flex flex-col gap-4">
          <Card title={t.authScopes}>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="flex min-w-0 flex-col gap-2 text-[13px] text-subtle">
                <p>{t.authIntro()}</p>
                <div className="flex min-w-0 items-center gap-2">
                  <pre className="min-w-0 flex-1 rounded-[10px] border bg-base px-3 py-2 font-mono text-[12px] whitespace-pre-wrap [overflow-wrap:anywhere] text-text">{`curl -H "Authorization: Bearer sbp_…" ${location.origin}/api/users`}</pre>
                  <CopyButton text={`curl -H "Authorization: Bearer sbp_…" ${location.origin}/api/users`} />
                </div>
              </div>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
                {(spec.data['x-scopes'] ?? []).map((s) => (
                  <div key={s.id} className="contents"><dt><Badge tone={s.id === 'admin' ? 'warn' : 'accent'}>{s.id}</Badge></dt><dd className="text-subtle">{s.description}</dd></div>
                ))}
              </dl>
            </div>
          </Card>
          <div className="flex flex-col gap-3">
            <Field label={t.searchLabel} hideLabel value={q} onChange={setQ} placeholder={t.searchPh} type="search" />
            <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
              <Chip active={!tag} onPress={() => setTag('')} count={ops.length}>{t.all}</Chip>
              {tags.map((g) => <Chip key={g.name} active={tag === g.name} onPress={() => setTag(tag === g.name ? '' : g.name)} count={counts(g.name)}>{g.name}</Chip>)}
            </div>
          </div>
          <Card pad={false}>
            {shown.length === 0 ? <p className="px-5 py-8 text-center text-[13px] text-muted">{t.noMatch}</p> : (
              <ul className="divide-y">
                {shown.map((o) => (
                  <OpRow key={o.key} o={o} spec={spec.data!} open={open === o.key} onToggle={() => setOpen(open === o.key ? null : o.key)} />
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}

function MethodBadge({ m }: { m: string }) {
  return <span className={cx('inline-flex h-[22px] w-[58px] shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-semibold uppercase', METHOD_TONE[m] ?? 'bg-overlay text-subtle')}>{m}</span>
}

function scopeTone(s?: string): 'neutral' | 'warn' | 'accent' | 'good' {
  if (s === 'admin') return 'warn'
  if (s === 'public') return 'good'
  if (!s || s === 'any' || s === 'session' || s === 'key' || s === 'read') return 'neutral'
  return 'accent'
}
const scopeText = (s?: string) => { const t = tr(AD); return ({ public: t.s_public, any: t.s_any, session: t.s_session, key: t.s_key } as Record<string, string>)[s ?? ''] ?? (s ? `${s}` : '') }

function OpRow({ o, spec, open, onToggle }: { o: Op; spec: Spec; open: boolean; onToggle: () => void }) {
  const t = useT(AD)
  const id = 'op-' + (o.op.operationId ?? o.key).replace(/[^a-z0-9_-]/gi, '_')
  const scope = o.op['x-required-scope']
  return (
    <li>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle}
        className="flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left outline-none transition-colors duration-(--dur-1) hover:bg-hl-low focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset sm:flex-nowrap sm:px-5">
        <MethodBadge m={o.method} />
        <span className="min-w-0 font-mono text-[13px] [overflow-wrap:anywhere] text-text sm:flex-[0_1_auto]">{o.path}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-subtle max-sm:basis-full max-sm:pl-[70px]">{o.op.summary}</span>
        {scope && <span className="max-sm:pl-[70px]"><Badge tone={scopeTone(scope)}>{scopeText(scope)}</Badge></span>}
      </button>
      {open && (
        <div id={id} className="animate-content-in flex flex-col gap-4 border-t bg-base/50 px-4 py-4 sm:px-5">
          {o.op.description && <p className="text-[13px] text-subtle">{renderInlineCode(o.op.description)}</p>}
          {o.op.parameters && o.op.parameters.length > 0 && (
            <Section title={t.params}>
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <tbody>
                    {o.op.parameters.map((p) => (
                      <tr key={p.in + p.name} className="border-b last:border-0 align-top">
                        <td className="py-1.5 pr-3 font-mono whitespace-nowrap text-text">{p.name}{p.required && <span className="text-bad">*</span>}</td>
                        <td className="py-1.5 pr-3 whitespace-nowrap text-xs text-muted">{p.in}</td>
                        <td className="py-1.5 pr-3 font-mono text-xs whitespace-nowrap text-accent">{typeName(p.schema, spec)}</td>
                        <td className="py-1.5 text-subtle">{p.description}{p.schema?.enum && <EnumList values={p.schema.enum} />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}
          {o.op.requestBody && Object.entries(o.op.requestBody.content).map(([ct, c]) => (
            <Section key={ct} title={<>{t.body} <span className="font-mono font-normal text-muted">{ct}</span></>}><SchemaView s={c.schema} spec={spec} /></Section>
          ))}
          {o.op.responses?.['200']?.content && Object.entries(o.op.responses['200'].content).map(([ct, c]) => (
            <Section key={ct} title={<>{t.resp} <span className="font-mono font-normal text-muted">{ct}</span></>}><SchemaView s={c.schema} spec={spec} /></Section>
          ))}
          <Section title={t.errors}>
            <div className="flex flex-wrap gap-1.5 text-xs">
              {Object.keys(o.op.responses ?? {}).filter((c) => c !== '200').map((c) => <Badge key={c} tone={c === '429' ? 'warn' : 'bad'}>{c} {({ '400': t.e400, '401': t.e401, '403': t.e403, '429': t.e429 } as Record<string, string>)[c]}</Badge>)}
              <span className="self-center text-muted">{t.returns}<span className="font-mono">{'{"error": "…"}'}</span></span>
            </div>
          </Section>
          {scope && !['public', 'any', 'session', 'key'].includes(scope) && <p className="text-xs text-muted">{t.needScope(scope, scopeLabel(scope))}</p>}
        </div>
      )}
    </li>
  )
}

function renderInlineCode(s: string): ReactNode {
  return s.split('`').map((part, i) => i % 2 ? <span key={i} className="font-mono text-text">{part}</span> : part)
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return <section className="flex min-w-0 flex-col gap-1.5"><h3 className="text-xs font-semibold tracking-wide text-subtle">{title}</h3>{children}</section>
}

function EnumList({ values }: { values: unknown[] }) {
  return <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">{values.map((v) => <span key={String(v)} className="rounded bg-overlay px-1 font-mono text-[11px] text-subtle">{String(v)}</span>)}</span>
}

function resolve(s: Schema | undefined, spec: Spec): [Schema | undefined, string | undefined] {
  if (s?.$ref) {
    const name = s.$ref.split('/').pop()!
    return [spec.components?.schemas?.[name], name]
  }
  return [s, undefined]
}

function typeName(s: Schema | undefined, spec: Spec): string {
  const [r, name] = resolve(s, spec)
  if (!r) return 'any'
  if (name && r.type === 'object') return name
  if (r.type === 'array') return `${typeName(r.items, spec)}[]`
  const t = Array.isArray(r.type) ? r.type.join(' | ') : r.type ?? (name ?? 'any')
  return r.format && r.format !== 'unix-time' && r.format !== 'bytes' ? `${t} (${r.format})` : t
}

function SchemaView({ s, spec, depth = 0 }: { s: Schema; spec: Spec; depth?: number }) {
  const [r, name] = resolve(s, spec)
  if (!r) return <span className="font-mono text-xs text-muted">any</span>
  if (r.type === 'array') {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-mono text-xs text-accent">{typeName(r, spec)}</span>
        {depth < 3 && resolve(r.items, spec)[0]?.properties && <SchemaView s={r.items!} spec={spec} depth={depth + 1} />}
      </div>
    )
  }
  if (!r.properties) {
    return <span className="text-[13px] text-subtle"><span className="font-mono text-xs text-accent">{typeName(r, spec)}</span>{r.description && <> — {r.description}</>}</span>
  }
  return (
    <div className={cx('min-w-0 rounded-[10px] border bg-surface', depth > 0 && 'mt-1')}>
      {name && depth === 0 && <div className="border-b px-3 py-1.5 font-mono text-xs text-muted">{name}</div>}
      <ul className="divide-y">
        {Object.entries(r.properties).map(([k, p]) => {
          const [pr] = resolve(p, spec)
          const nested = depth < 2 && (pr?.properties || (pr?.type === 'array' && resolve(pr.items, spec)[0]?.properties))
          return (
            <li key={k} className="flex min-w-0 flex-col gap-0.5 px-3 py-1.5 text-[13px]">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-text">{k}{r.required?.includes(k) && <span className="text-bad">*</span>}</span>
                <span className="font-mono text-xs text-accent">{typeName(p, spec)}</span>
                {pr?.format === 'unix-time' && <span className="text-xs text-muted">{tr(AD).unixSec}</span>}
                {pr?.format === 'bytes' && <span className="text-xs text-muted">{tr(AD).bytes}</span>}
                {pr?.description && <span className="min-w-0 text-xs text-subtle">{pr.description}</span>}
                {pr?.enum && <EnumList values={pr.enum} />}
              </div>
              {nested && <SchemaView s={pr!.type === 'array' ? pr!.items! : p} spec={spec} depth={depth + 1} />}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
