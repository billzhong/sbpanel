import { useCallback, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { api, type Node, type Settings, type User } from './api'
import { href } from './router'
import { useToast, type ToastOpts } from '../ui/kit'
import { tr } from '../i18n'
import { C } from '../i18n/common'

export const errText = (e: unknown) => (e as Error)?.message || tr(C).actionFailed

/**
 * A mutation with the standard plumbing: pending state, an error toast, cache invalidation
 * and an optional success toast (or apply tracking for saves that trigger a reconcile).
 */
export function useAction<V = void, R = unknown>(opts: {
  fn: (v: V) => Promise<R>
  success?: string | ((r: R, v: V) => string | undefined)
  invalidate?: QueryKey[]
  /** Saves that change node config: show "Deploying…" and update it in place once nodes catch up. */
  apply?: boolean
  onSuccess?: (r: R, v: V) => void
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const track = useApplyTracker()
  return useMutation<R, Error, V>({
    mutationFn: opts.fn,
    onSuccess: (r, v) => {
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: k })
      const msg = typeof opts.success === 'function' ? opts.success(r, v) : opts.success
      if (opts.apply) track({ text: msg ?? tr(C).saved })
      else if (msg) toast('good', msg)
      opts.onSuccess?.(r, v)
    },
    onError: (e) => toast('bad', errText(e)),
  })
}

/**
 * Shows "<text> · Deploying to N nodes" and polls /api/nodes until every online node has applied
 * the new revision, then updates the same toast to "Live on all nodes" (or points at the failing nodes).
 */
export function useApplyTracker() {
  const toast = useToast()
  const qc = useQueryClient()
  return useCallback((o: { text: string; action?: ToastOpts['action'] }) => {
    const cached = qc.getQueryData<Node[]>(['nodes'])?.filter((n) => n.enrolled && n.online).length
    const t = tr(C)
    const id = toast.show({ tone: 'pending', text: t.pushing(o.text, cached), action: o.action })
    const t0 = Date.now()
    let first = true
    const tick = async () => {
      const ns = await api<Node[]>('/nodes').catch(() => null)
      const el = Date.now() - t0
      if (ns) {
        qc.setQueryData(['nodes'], ns)
        const on = ns.filter((n) => n.enrolled && n.online)
        const offline = ns.filter((n) => n.enrolled && !n.online).length
        if (first) {
          first = false
          if (on.length === 0) {
            toast.update(id, { tone: 'info', text: t.noOnline(o.text), link: { label: t.viewNodes, href: href('nodes') } })
            return
          }
          toast.update(id, { text: t.pushing(o.text, on.length) })
        }
        const behind = on.filter((n) => n.applied_revision < n.revision)
        const failed = behind.filter((n) => n.apply_error)
        if (behind.length === 0) {
          toast.update(id, { tone: 'good', text: offline ? t.appliedSome(o.text, on.length, offline) : t.appliedAll(o.text) })
          return
        }
        if (failed.length && el > 3000) {
          toast.update(id, { tone: 'bad', text: t.failedOn(o.text, failed.length), link: { label: t.viewNodes, href: href('nodes') } })
          return
        }
        if (el > 15000) {
          toast.update(id, { tone: 'info', text: t.pendingOn(o.text, behind.length), link: { label: t.viewNodes, href: href('nodes') } })
          return
        }
      }
      setTimeout(tick, 1000)
    }
    setTimeout(tick, 400)
    return id
  }, [toast, qc])
}

// ---- user batch -------------------------------------------------------------

export type UserSnap = { id: number; enabled: boolean; expire_at: number; traffic_limit: number; used_up: number; used_down: number }
export type BatchAction = 'enable' | 'disable' | 'extend_days' | 'add_traffic' | 'reset_usage' | 'set_groups' | 'set_limit' | 'delete' | 'restore'
type BatchResp = { affected: number; undo?: UserSnap[] }

export const snapOf = (u: User): UserSnap => ({ id: u.id, enabled: u.enabled, expire_at: u.expire_at, traffic_limit: u.traffic_limit, used_up: u.used_up, used_down: u.used_down })

export function batch(ids: number[], action: BatchAction, value?: unknown) {
  return api<BatchResp>('/users/batch', { method: 'POST', body: { ids, action, value } })
}

/** Runs a batch action with optimistic flash, an undo toast (exact restore from the snapshot) and apply tracking. */
export function useUserBatch() {
  const qc = useQueryClient()
  const toast = useToast()
  const track = useApplyTracker()
  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['users'] })
    qc.invalidateQueries({ queryKey: ['user'] })
    qc.invalidateQueries({ queryKey: ['groups'] })
  }, [qc])
  return useCallback(async (ids: number[], action: BatchAction, value: unknown, text: string, opts?: { undo?: UserSnap[] }) => {
    try {
      const r = await batch(ids, action, value)
      flashRows(ids)
      refresh()
      const snaps = opts?.undo ?? r.undo
      const undo = snaps?.length ? {
        label: tr(C).undo, onPress: () => {
          batch(snaps.map((s) => s.id), 'restore', snaps).then(() => { flashRows(ids); refresh(); toast('good', tr(C).undone) }, (e) => toast('bad', errText(e)))
        },
      } : undefined
      track({ text, action: undo })
      return r
    } catch (e) {
      toast('bad', errText(e))
      throw e
    }
  }, [refresh, toast, track])
}

// ---- subscription URL -------------------------------------------------------

export function useSubUrl() {
  const s = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/settings'), staleTime: 60000 })
  const base = (s.data?.sub_base_url || location.origin).replace(/\/+$/, '')
  return useCallback((u: Pick<User, 'sub_token'>) => `${base}/s/${u.sub_token}`, [base])
}

// ---- row highlight store ----------------------------------------------------

let ver = 0
const flashing = new Map<number, number>()
const leaving = new Set<number>()
const subs = new Set<() => void>()
const emit = () => { ver++; subs.forEach((f) => f()) }

/** Highlight rows that were just created or changed (accent 10% fading over 1.2s). */
export function flashRows(ids: number[]) {
  const until = Date.now() + 1200
  ids.forEach((i) => flashing.set(i, until))
  emit()
  setTimeout(() => { const now = Date.now(); for (const [k, t] of flashing) if (t <= now) flashing.delete(k); emit() }, 1250)
}
/** Fade rows out before they disappear from the data. */
export function leaveRows(ids: number[]) { ids.forEach((i) => leaving.add(i)); emit() }
export function settleRows(ids: number[]) { ids.forEach((i) => leaving.delete(i)); emit() }

export function useRowFx() {
  useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => ver)
  return (id: number) => (leaving.has(id) ? 'animate-row-out' : flashing.has(id) ? 'animate-flash' : '')
}

/** PATCH a single user and offer an exact undo by restoring its pre-change snapshot. */
export function useUserPatch() {
  const qc = useQueryClient()
  const toast = useToast()
  const track = useApplyTracker()
  return useCallback(async (u: User, body: Record<string, unknown>, text: string) => {
    const snap = snapOf(u)
    const refresh = () => { qc.invalidateQueries({ queryKey: ['users'] }); qc.invalidateQueries({ queryKey: ['user'] }); qc.invalidateQueries({ queryKey: ['groups'] }) }
    try {
      await api(`/users/${u.id}`, { method: 'PATCH', body })
    } catch (e) { toast('bad', errText(e)); throw e }
    flashRows([u.id])
    refresh()
    track({
      text, action: {
        label: tr(C).undo, onPress: () => batch([u.id], 'restore', [snap]).then(() => { flashRows([u.id]); refresh(); toast('good', tr(C).undone) }, (e) => toast('bad', errText(e))),
      },
    })
  }, [qc, toast, track])
}
