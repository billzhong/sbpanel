import { dict } from '.'

const s = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

/** A node's own route rules (node detail → Routing). */
export const NR = dict({
  tStatus: 'Status', tRouting: 'Routing', tabs: 'Node detail sections',
  template: 'Template', toTemplate: 'Open template', ownRules: (n: number) => s(n, 'node rule'), usingTemplate: 'Same as the template',
  intro: 'Rules run top to bottom; the first match decides. This node\'s rules sit after the template\'s sniff/DNS rules and before its routing rules, and only affect this node.',
  effective: 'Effective rules', fromTemplate: 'Template', fromNode: 'This node', insertHere: 'This node\'s rules go here',
  finalLabel: 'Everything else', finalTo: (o: string) => `→ ${o}`,
  outbounds: 'Outbounds', ruleSets: 'Rule sets', none: 'none',
  edit: 'Edit node rules', reset: 'Reset to template',
  resetTitle: 'Reset routing to the template?',
  resetBody: (node: string, n: number) => `${node} drops its own rules and final outbound and uses the template's route again. ${restart(n)}`,
  warnings: 'Some node rules are skipped because the template no longer has what they reference:',
  // rule summary
  sniff: 'Sniff protocol', hijackDns: 'Hijack DNS', resolve: 'Resolve domain', any: 'any traffic',
  reject: 'Reject', routeTo: (o: string) => `→ ${o}`, not: 'NOT',
  // editor
  editTitle: (n: string) => `Routing rules · ${n}`, step1: 'Edit', step2: 'Review',
  noRules: 'No rules of its own yet: this node routes exactly like its template.', addRule: 'Add rule',
  rule: (i: number) => `Rule ${i}`, moveUp: 'Move up', moveDown: 'Move down', remove: 'Delete rule',
  when: 'When', addCond: 'Add condition', removeCond: 'Remove condition', then: 'Then', invert: 'Invert (match when the conditions do NOT hold)',
  actRoute: 'Route to', actReject: 'Reject', outbound: 'Outbound', field: 'Match on', values: 'Values',
  valuesPh: 'One per line or comma-separated', other: 'Other fields (kept as is)',
  finalSel: 'Everything else goes to', finalDefault: (o: string) => `Template default (${o})`,
  review: 'Review changes', back: 'Back', apply: 'Apply to this node', checking: 'Checking with sing-box…',
  valid: 'Valid: checked against the template and by sing-box',
  added: 'added', removed: 'removed', moved: 'moved', unchanged: 'No changes',
  restartWarn: (node: string, n: number) => `Applying rebuilds ${node}'s proxy core. ${restart(n)}`,
  saved: (n: string) => `Routing for ${n} updated`, resetDone: (n: string) => `${n} uses the template's route again`,
  emptyCond: 'Fill in or remove empty conditions', needCond: (i: number) => `Rule ${i} needs a condition`,
  needOutbound: (i: number) => `Rule ${i} needs an outbound`,
  f_domain_suffix: 'Domain suffix', f_domain: 'Domain', f_domain_keyword: 'Domain keyword', f_domain_regex: 'Domain regex',
  f_ip_cidr: 'Destination IP / CIDR', f_ip_is_private: 'Private destination IP', f_source_ip_cidr: 'Source IP / CIDR',
  f_port: 'Destination port', f_port_range: 'Port range', f_source_port: 'Source port', f_network: 'Network', f_protocol: 'Sniffed protocol',
  f_inbound: 'Inbound', f_rule_set: 'Rule set', f_auth_user: 'User',
}, {
  tStatus: '状态', tRouting: '路由', tabs: '节点详情分区',
  template: '模板', toTemplate: '打开模板', ownRules: (n) => `${n} 条节点规则`, usingTemplate: '与模板一致',
  intro: '规则自上而下匹配，命中第一条即生效。本节点规则位于模板的嗅探/DNS 规则之后、模板路由规则之前，只影响本节点。',
  effective: '生效规则', fromTemplate: '模板', fromNode: '本节点', insertHere: '本节点规则插入此处',
  finalLabel: '其余流量', finalTo: (o) => `→ ${o}`,
  outbounds: '出站', ruleSets: '规则集', none: '无',
  edit: '编辑节点规则', reset: '恢复为模板',
  resetTitle: '路由恢复为模板？',
  resetBody: (node, n) => `${node} 将删除自有规则与兜底出站，重新使用模板的路由。${restartZh(n)}`,
  warnings: '模板已不再包含部分节点规则引用的内容，这些规则暂被跳过：',
  sniff: '嗅探协议', hijackDns: '劫持 DNS', resolve: '解析域名', any: '所有流量',
  reject: '拒绝', routeTo: (o) => `→ ${o}`, not: '非',
  editTitle: (n) => `路由规则 · ${n}`, step1: '编辑', step2: '确认',
  noRules: '还没有自有规则：该节点的路由与模板完全一致。', addRule: '添加规则',
  rule: (i) => `规则 ${i}`, moveUp: '上移', moveDown: '下移', remove: '删除规则',
  when: '条件', addCond: '添加条件', removeCond: '移除条件', then: '动作', invert: '取反（条件不成立时命中）',
  actRoute: '转发到', actReject: '拒绝', outbound: '出站', field: '匹配项', values: '值',
  valuesPh: '每行一个，或用逗号分隔', other: '其他字段（原样保留）',
  finalSel: '其余流量走', finalDefault: (o) => `模板默认（${o}）`,
  review: '检查变更', back: '返回', apply: '应用到该节点', checking: '正在用 sing-box 校验…',
  valid: '校验通过：已按模板与 sing-box 检查',
  added: '新增', removed: '删除', moved: '移动', unchanged: '没有变更',
  restartWarn: (node, n) => `应用后 ${node} 的代理内核会重建。${restartZh(n)}`,
  saved: (n) => `已更新 ${n} 的路由`, resetDone: (n) => `${n} 已恢复使用模板路由`,
  emptyCond: '请填写或移除空条件', needCond: (i) => `规则 ${i} 需要至少一个条件`,
  needOutbound: (i) => `规则 ${i} 需要选择出站`,
  f_domain_suffix: '域名后缀', f_domain: '完整域名', f_domain_keyword: '域名关键字', f_domain_regex: '域名正则',
  f_ip_cidr: '目标 IP / CIDR', f_ip_is_private: '目标为内网 IP', f_source_ip_cidr: '来源 IP / CIDR',
  f_port: '目标端口', f_port_range: '端口范围', f_source_port: '来源端口', f_network: '网络', f_protocol: '嗅探协议',
  f_inbound: '入站', f_rule_set: '规则集', f_auth_user: '用户',
})

function restart(n: number) {
  return n > 0 ? `Its ${s(n, 'active connection')} will drop; clients reconnect on their own.` : 'Clients reconnect on their own.'
}
function restartZh(n: number) {
  return n > 0 ? `当前 ${n} 个连接会断开，客户端会自动重连。` : '客户端会自动重连。'
}
