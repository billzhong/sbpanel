import { createElement as h, Fragment, type ReactNode } from 'react'
import { dict } from '.'

const frag = (...c: ReactNode[]) => h(Fragment, null, ...c)
const code = (s: string, cls = 'font-mono text-text') => h('span', { className: cls }, s)

/** Settings → API docs viewer (pages/settings/ApiDocs.tsx). The spec text itself comes from the server. */
export const AD = dict({
  title: 'API docs', count: (title: string, n: number) => `${title} · OpenAPI 3.1 · ${n} endpoint${n === 1 ? '' : 's'}`,
  backToSettings: '← Back to settings', dlJson: 'Download JSON', loadFailed: 'Failed to load: ',
  authScopes: 'Authentication & scopes',
  authIntro: () => frag('Create a key in Settings → API & agents and send ', code('Authorization: Bearer sbp_…'),
    ' with each request. A key can only call the endpoints its scopes allow; requests over its rate limit get 429 with ', code('Retry-After', 'font-mono'), '.'),
  searchLabel: 'Search endpoints', searchPh: 'Search paths, summaries or scopes, e.g. users, traffic, users:write',
  all: 'All', noMatch: 'No matching endpoints',
  s_public: 'Public', s_any: 'Any key', s_session: 'Session only', s_key: 'Key only',
  params: 'Parameters', body: 'Request body', resp: 'Response 200', errors: 'Errors',
  e400: 'Bad request', e401: 'Unauthenticated', e403: 'Forbidden', e429: 'Rate limited',
  returns: 'Returns ',
  needScope: (s: string, label: string) => frag('Requires ', code(s, 'font-mono'), ` (${label}) or admin; signed-in sessions are not restricted.`),
  unixSec: 'unix seconds', bytes: 'bytes',
}, {
  title: 'API 文档', count: (title, n) => `${title} · OpenAPI 3.1 · ${n} 个接口`,
  backToSettings: '← 返回设置', dlJson: '下载 JSON', loadFailed: '加载失败：',
  authScopes: '认证与权限',
  authIntro: () => frag('在 设置 → API 与智能体 创建密钥，请求时带上 ', code('Authorization: Bearer sbp_…'),
    '。密钥按权限限制可用接口，超出速率限制返回 429 并带 ', code('Retry-After', 'font-mono'), '。'),
  searchLabel: '搜索接口', searchPh: '搜索路径、说明或权限，例如 users、traffic、users:write',
  all: '全部', noMatch: '没有匹配的接口',
  s_public: '公开', s_any: '任意密钥', s_session: '仅登录会话', s_key: '仅密钥',
  params: '参数', body: '请求体', resp: '响应 200', errors: '错误',
  e400: '参数错误', e401: '未认证', e403: '无权限', e429: '限流',
  returns: '返回 ',
  needScope: (s, label) => frag('所需权限：', code(s, 'font-mono'), `（${label}）或 admin；登录会话不受限。`),
  unixSec: 'unix 秒', bytes: '字节',
})
