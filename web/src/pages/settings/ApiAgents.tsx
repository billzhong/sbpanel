import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAction } from '../../lib/actions'
import { ago, date } from '../../lib/fmt'
import { href } from '../../lib/router'
import {
  DEFAULT_RATE, MCP_TOOLS, SCOPES, claudeMcpCommand, curlExample, mcpJsonConfig, panelOrigin, scopeLabel,
  type ApiKey, type ApiKeyCreate, type Scope,
} from '../../lib/apikeys'
import { Badge, Button, Callout, Card, Checkbox, Confirm, CopyButton, CopyText, Field, IconButton, ModalDialog, Segmented, Skeleton, cx, useSticky } from '../../ui/kit'
import { IconKey, IconPlus, IconTrash } from '../../ui/icons'

/** 设置 → API 与智能体: scoped keys, MCP connection and API docs. */
export function ApiAgents() {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <ApiKeys />
      <McpCard />
      <DocsCard />
    </div>
  )
}

function ScopeBadges({ scopes }: { scopes: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {scopes.map((s) => <Badge key={s} tone={s === 'admin' ? 'warn' : s === 'read' ? 'neutral' : 'accent'}>{scopeLabel(s)}</Badge>)}
    </span>
  )
}

function expiryText(k: ApiKey) {
  if (k.expired) return <Badge tone="bad" dot>已过期</Badge>
  if (!k.expires_at) return <span>永不过期</span>
  const days = (k.expires_at - Date.now() / 1000) / 86400
  return <span className={cx(days < 7 && 'text-warn')}>{date(k.expires_at)} 到期</span>
}

function ApiKeys() {
  const keys = useQuery({ queryKey: ['tokens'], queryFn: () => api<ApiKey[]>('/tokens') })
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<ApiKey | null>(null)
  const del = useAction({ fn: (id: number) => api(`/tokens/${id}`, { method: 'DELETE' }), success: '密钥已删除', invalidate: [['tokens']] })
  const delSticky = useSticky(deleting)
  return (
    <Card className="xl:col-span-2" title="API 密钥" action={<Button size="sm" variant="primary" onPress={() => setCreating(true)}><IconPlus size={15} />创建密钥</Button>}>
      <p className="mb-3 text-[13px] text-subtle">
        脚本、机器人和 AI 智能体用 <span className="font-mono">Authorization: Bearer sbp_…</span> 调用 <span className="font-mono">/api/*</span> 和 <span className="font-mono">/mcp</span>。
        每个密钥只拥有所选权限，可设置有效期、来源 IP 和速率限制；操作会以 <span className="font-mono">token:名称</span> 记入审计日志。
      </p>
      {keys.isLoading ? <Skeleton className="h-16" /> : (keys.data?.length ?? 0) === 0 ? (
        <div className="flex items-center gap-3 rounded-[12px] border border-dashed px-4 py-5 text-[13px] text-subtle">
          <IconKey size={18} className="shrink-0 text-muted" />还没有 API 密钥。创建一个只读密钥给监控用，或给智能体一个「只读 + 用户写入」密钥。
        </div>
      ) : (
        <ul className="flex flex-col divide-y rounded-[12px] border">
          {keys.data!.map((k) => (
            <li key={k.id} className={cx('flex items-start gap-3 px-4 py-3 animate-content-in', k.expired && 'opacity-70')}>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium [overflow-wrap:anywhere]">{k.name}</span>
                  <span className="font-mono text-xs text-muted">{k.prefix}…</span>
                  <ScopeBadges scopes={k.scopes} />
                </div>
                {k.description && <p className="text-[13px] text-subtle [overflow-wrap:anywhere]">{k.description}</p>}
                <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-subtle">
                  <div className="flex gap-1"><dt className="text-muted">有效期</dt><dd>{expiryText(k)}</dd></div>
                  <div className="flex gap-1"><dt className="text-muted">速率</dt><dd className="tabular">{k.rate_limit} 次/分</dd></div>
                  <div className="flex gap-1"><dt className="text-muted">来源</dt><dd className="font-mono [overflow-wrap:anywhere]">{k.allow_ips.length ? k.allow_ips.join(', ') : '不限'}</dd></div>
                  <div className="flex gap-1"><dt className="text-muted">最近使用</dt><dd>{ago(k.last_used)}{k.last_ip && <span className="ml-1 font-mono">{k.last_ip}</span>}</dd></div>
                </dl>
              </div>
              <IconButton label={`删除密钥 ${k.name}`} onPress={() => setDeleting(k)}><IconTrash size={15} /></IconButton>
            </li>
          ))}
        </ul>
      )}
      <CreateKeyDialog isOpen={creating} onOpenChange={setCreating} />
      <Confirm isOpen={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} danger title="删除密钥" confirmLabel="删除密钥"
        onConfirm={() => deleting && del.mutate(deleting.id)} body={<>使用 <b className="text-text">{delSticky?.name}</b> 的脚本和智能体会立刻失去访问权限。此操作不可撤销。</>} />
    </Card>
  )
}

const EXPIRY = [
  { id: '0', label: '永不' }, { id: '7', label: '7 天' }, { id: '30', label: '30 天' }, { id: '90', label: '90 天' }, { id: '365', label: '1 年' },
] as const
type ExpiryId = (typeof EXPIRY)[number]['id']

function CreateKeyDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [scopes, setScopes] = useState<Scope[]>(['read'])
  const [expiry, setExpiry] = useState<ExpiryId>('90')
  const [ips, setIps] = useState('')
  const [rate, setRate] = useState('')
  const [created, setCreated] = useState<{ token: string; key: ApiKey } | null>(null)
  const reset = () => { setName(''); setDesc(''); setScopes(['read']); setExpiry('90'); setIps(''); setRate(''); setCreated(null); create.reset() }
  const close = (v: boolean) => { onOpenChange(v); if (!v) setTimeout(reset, 250) }
  const rateN = rate.trim() === '' ? 0 : Number(rate)
  const rateBad = rate.trim() !== '' && (!Number.isInteger(rateN) || rateN < 1 || rateN > 100000)
  const create = useMutation({
    mutationFn: () => {
      const body: ApiKeyCreate = {
        name: name.trim(), description: desc.trim(), scopes, expires_in_days: Number(expiry) || undefined,
        allow_ips: ips.split(/[\s,;]+/).filter(Boolean), rate_limit: rateN || undefined,
      }
      return api<{ token: string; key: ApiKey }>('/tokens', { method: 'POST', body })
    },
    onSuccess: (r) => { setCreated(r); qc.invalidateQueries({ queryKey: ['tokens'] }) },
  })
  const admin = scopes.includes('admin')
  const toggle = (s: Scope, on: boolean) => setScopes((cur) => on ? [...cur, s] : cur.filter((x) => x !== s))
  const valid = name.trim() !== '' && scopes.length > 0 && !rateBad

  if (created) {
    const tok = created.token
    return (
      <ModalDialog isOpen={isOpen} onOpenChange={close} title="密钥已创建" wide footer={<Button variant="primary" onPress={() => close(false)}>完成</Button>}>
        <div className="flex flex-col gap-4 animate-content-in">
          <Callout tone="warn">这是唯一一次显示完整密钥。请现在复制并妥善保存；丢失后只能删除并重新创建。</Callout>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-subtle">{created.key.name} · <ScopeBadgesInline scopes={created.key.scopes} /></span>
            <div className="flex items-center gap-2 rounded-[10px] border bg-base px-3 py-2.5">
              <CopyText text={tok} className="min-w-0 flex-1 text-[13px] text-text" />
            </div>
          </div>
          <Snippet title="用 curl 测试" text={curlExample(tok, created.key.scopes)} />
          <Snippet title="在 Claude Code 中添加 MCP 服务器" text={claudeMcpCommand(tok)} />
          <Snippet title="其他 MCP 客户端（JSON 配置）" text={mcpJsonConfig(tok)} />
        </div>
      </ModalDialog>
    )
  }

  return (
    <ModalDialog isOpen={isOpen} onOpenChange={close} title="创建 API 密钥" wide dirty={!!name.trim() || !!desc.trim() || !!ips.trim()}
      footer={<>
        <Button onPress={() => close(false)}>取消</Button>
        <Button variant="primary" isPending={create.isPending} isDisabled={!valid} onPress={() => create.mutate()}>创建密钥</Button>
      </>}>
      <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); if (valid) create.mutate() }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="名称" value={name} onChange={setName} placeholder="例如 claude-code、grafana" autoFocus isRequired description="审计日志里显示为 token:名称" />
          <Field label="描述（可选）" value={desc} onChange={setDesc} placeholder="用途、负责人" />
        </div>
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1.5 text-[13px] font-medium text-subtle">权限</legend>
          <div className="grid gap-px overflow-hidden rounded-[12px] border bg-hl-low sm:grid-cols-2">
            {SCOPES.map((s) => {
              const implied = admin && s.id !== 'admin'
              return (
                <div key={s.id} className={cx('bg-surface px-3 py-2.5', s.id === 'admin' && 'sm:col-span-2')}>
                  <Checkbox isSelected={scopes.includes(s.id) || implied} isDisabled={implied} onChange={(v) => toggle(s.id, v)}>
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium">{s.label} <span className="font-mono text-xs font-normal text-muted">{s.id}</span></span>
                      <span className="text-xs text-subtle">{s.desc}</span>
                    </span>
                  </Checkbox>
                </div>
              )
            })}
          </div>
          {scopes.length === 0 && <span className="text-xs text-bad">至少选择一个权限</span>}
          {admin && <span className="text-xs text-warn">管理员密钥可以创建新密钥和下载备份，只给完全信任的程序。</span>}
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-subtle">有效期</span>
          <div><Segmented label="有效期" value={expiry} onChange={setExpiry} options={EXPIRY.map((e) => ({ id: e.id, label: e.label }))} /></div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="来源 IP 允许列表（可选）" multiline rows={3} mono value={ips} onChange={setIps} placeholder={'203.0.113.7\n10.0.0.0/8'}
            description="每行一个 IP 或 CIDR，留空不限。反向代理只信任来自本机的 X-Forwarded-For。" />
          <Field label="速率限制（次/分钟）" inputMode="numeric" value={rate} onChange={setRate} placeholder={String(DEFAULT_RATE)}
            isInvalid={rateBad} errorMessage="1 – 100000 的整数" description={`留空为默认 ${DEFAULT_RATE} 次/分钟，超出返回 429。`} />
        </div>
        {create.error && <Callout tone="bad">{(create.error as Error).message}</Callout>}
        <button type="submit" hidden />
      </form>
    </ModalDialog>
  )
}

function ScopeBadgesInline({ scopes }: { scopes: string[] }) {
  return <span className="font-normal">{scopes.map(scopeLabel).join('、')}</span>
}

function Snippet({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-subtle">{title}</span>
        <CopyButton text={text} />
      </div>
      <pre className="overflow-x-auto rounded-[10px] border bg-base px-3 py-2.5 font-mono text-[12px] leading-5 whitespace-pre-wrap [overflow-wrap:anywhere] text-text">{text}</pre>
    </div>
  )
}

function McpCard() {
  const url = `${panelOrigin()}/mcp`
  return (
    <Card title="MCP 智能体接入">
      <div className="flex flex-col gap-3 text-[13px]">
        <p className="text-subtle">
          面板内置 <a className="text-accent underline-offset-2 hover:underline" href="https://modelcontextprotocol.io" target="_blank" rel="noreferrer">Model Context Protocol</a> 服务器（Streamable HTTP）。
          Claude Code、Claude Desktop、Cursor 等智能体用 API 密钥连接后，可以直接查询用户、流量和节点，或在授权后开通、续期用户。
        </p>
        <div className="flex min-w-0 items-center gap-2 rounded-[10px] border bg-base px-3 py-2">
          <span className="shrink-0 text-xs text-muted">端点</span><CopyText text={url} className="min-w-0 text-text" />
        </div>
        <Snippet title="Claude Code" text={claudeMcpCommand('sbp_…')} />
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-subtle">工具</span>
          <div className="flex flex-wrap gap-1.5">
            {MCP_TOOLS.map((t) => (
              <span key={t.name} title={t.desc} className={cx('inline-flex h-[22px] items-center rounded-full px-2 font-mono text-[11.5px]', t.write ? 'bg-accent/12 text-accent' : 'bg-overlay text-subtle')}>{t.name}</span>
            ))}
          </div>
          <p className="text-xs text-muted">灰色为只读工具（需要 read）；蓝色为写入工具（需要 users:write），调用记入审计日志 mcp:名称。</p>
        </div>
      </div>
    </Card>
  )
}

function DocsCard() {
  return (
    <Card title="API 文档">
      <div className="flex flex-col gap-3 text-[13px] text-subtle">
        <p>完整的 OpenAPI 3.1 描述覆盖认证、用户（含批量）、节点、入站、分组、Host、模板、分流方案、流量、事件与审计、设置，每个接口标注所需权限。</p>
        <ul className="flex flex-col gap-1.5">
          <li className="flex gap-2"><span className="w-20 shrink-0 text-muted">认证</span><span className="font-mono text-text">Authorization: Bearer sbp_…</span></li>
          <li className="flex gap-2"><span className="w-20 shrink-0 text-muted">规范</span><span className="font-mono text-text">GET /api/openapi.json</span></li>
          <li className="flex gap-2"><span className="w-20 shrink-0 text-muted">超限</span><span>HTTP 429，<span className="font-mono">Retry-After</span> 给出等待秒数</span></li>
        </ul>
        <div className="flex flex-wrap gap-2">
          <a href={href('settings', { view: 'api-docs' })} className="inline-flex h-8 items-center rounded-full bg-accent px-4 text-sm font-medium text-on-accent outline-none transition-[filter] duration-(--dur-1) hover:brightness-110 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base">打开 API 文档</a>
          <a href="/api/openapi.json" download="sbpanel-openapi.json" className="inline-flex h-8 items-center rounded-full bg-overlay px-4 text-sm font-medium text-text outline-none transition-colors duration-(--dur-1) hover:bg-hl-med/70 focus-visible:ring-2 focus-visible:ring-accent">下载 openapi.json</a>
        </div>
      </div>
    </Card>
  )
}
