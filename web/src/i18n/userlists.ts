import { dict } from '.'

/** Filter and sort labels for the user list (lib/users.ts). */
export const D = dict({
  online: 'Online', expiring: 'Expiring (≤ 7 days)', quota80: 'Quota ≥ 80%', limited: 'Over quota', expired: 'Expired',
  disabled: 'Disabled', unused: 'Never used',
  sCreated: 'Created', sName: 'Username', sUsage: 'Usage', sExpire: 'Expiry', sSeen: 'Last seen',
}, {
  online: '在线', expiring: '即将到期（≤7 天）', quota80: '额度 ≥80%', limited: '超额', expired: '已过期',
  disabled: '已禁用', unused: '从未使用',
  sCreated: '创建时间', sName: '用户名', sUsage: '用量', sExpire: '到期时间', sSeen: '最近在线',
})
