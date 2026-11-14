import { useState } from 'react'
import { Form } from 'react-aria-components'
import { api, ApiError } from '../lib/api'
import { Button, Field } from '../ui/kit'

export function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [needCode, setNeedCode] = useState(false)
  const [code, setCode] = useState('')
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      await api('/auth/login', { method: 'POST', body: { username, password, code } })
      onDone()
    } catch (e) {
      if (e instanceof ApiError && e.data?.need_totp) {
        if (needCode) setErr((e as Error).message)
        setNeedCode(true)
      } else setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid min-h-full place-items-center p-4">
      <Form onSubmit={submit} className="w-full max-w-[380px] rounded-[20px] border bg-surface p-8 animate-pop">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-[12px] bg-accent text-on-accent">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M5 16c3-9 11-9 14 0" /><circle cx="12" cy="17" r="1.6" fill="currentColor" /></svg>
          </span>
          <div>
            <div className="text-lg font-semibold">sbpanel</div>
            <div className="text-[13px] text-subtle">sing-box 代理管理面板</div>
          </div>
        </div>
        <div className="flex flex-col gap-4">
          <Field label="用户名" value={username} onChange={setUsername} autoComplete="username" isRequired />
          <Field label="密码" type="password" value={password} onChange={setPassword} autoComplete="current-password" autoFocus isRequired />
          {needCode && <Field label="两步验证码" value={code} onChange={setCode} autoComplete="one-time-code" autoFocus description="验证器 App 中的 6 位数字" />}
          {err && <div className="rounded-[10px] bg-bad/10 px-3 py-2 text-[13px] text-bad">{err}</div>}
          <Button type="submit" variant="primary" isPending={busy} className="mt-1 h-10">{busy ? '登录中…' : '登录'}</Button>
        </div>
      </Form>
    </div>
  )
}
