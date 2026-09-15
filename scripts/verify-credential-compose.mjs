#!/usr/bin/env node
/**
 * 凭证注入回归自检（离线，打桩 fetch，不触网、不消耗 OneNat 5 次/分限速）
 *
 * 覆盖本次事故（"OneNat 里设了实例独立凭证，注入的却是应用默认凭证"）的四个断言：
 *   1. 映射有实例覆盖(resolved_from=mapping) → 块标注"映射实例独立凭证"，且不出现继承告警
 *   2. 映射继承应用默认(resolved_from=app / auth_override=false) → 块必须出现 ⚠️ 告警 +
 *      现取凭证的 curl + [平台接入]（旧实现会把 app 凭证当正常凭证静默写进提示词）
 *   3. 接口没回 username → 不再伪造 `root`（旧实现 `cred?.username || 'root'`）
 *   4. 凭证缓存：成功值命中缓存；invalidateCredential 后立即失效；403 负缓存不得把旧成功值
 *      当新凭证返回（防"改完凭证还在用旧密码"）
 *
 * 用法: node scripts/verify-credential-compose.mjs
 */
import { OnenatDirectory } from '../lib/onenat.js'
import { PromptComposer } from '../lib/prompt-composer.js'

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}

// ---------- 打桩 OneNat ----------
const RESOURCES = {
  tunnels: [
    {
      id: 't1',
      name: 'TestBox',
      online: true,
      mappings: [
        {
          id: 'm-override', proto: 'tcp', public_url: 'tcp://box.example.com:1111', local: '127.0.0.1:22',
          note: '', auth_override: true, auth_type: 'basic',
          app: { id: 'app-ssh', name: 'SSH Server', type: 'ssh', auth_type: 'basic', username: 'root', skills: [] },
        },
        {
          id: 'm-inherit', proto: 'tcp', public_url: 'tcp://box.example.com:2222', local: '127.0.0.1:22',
          note: '', auth_override: false, auth_type: 'basic',
          app: { id: 'app-ssh', name: 'SSH Server', type: 'ssh', auth_type: 'basic', username: 'root', skills: [] },
        },
        {
          id: 'm-nouser', proto: 'tcp', public_url: 'tcp://box.example.com:3333', local: '127.0.0.1:22',
          note: '', auth_override: true, auth_type: 'basic',
          app: { id: 'app-ssh', name: 'SSH Server', type: 'ssh', auth_type: 'basic', username: 'root', skills: [] },
        },
      ],
    },
  ],
}
const CREDS = {
  'm-override': { resolved_from: 'mapping', auth_type: 'basic', username: 'alice', password: 'pw-mapping' },
  'm-inherit': { resolved_from: 'app', auth_type: 'basic', username: 'root', password: 'pw-app' },
  'm-nouser': { resolved_from: 'mapping', auth_type: 'basic', password: 'pw-only' }, // 故意不回 username
}
let credStatus = 200
let credCalls = []
globalThis.fetch = async (url) => {
  const u = String(url)
  const ok = (data) => ({ ok: true, status: 200, json: async () => data })
  if (u.includes('/api/v1/resources')) return ok(RESOURCES)
  const m = /\/api\/v1\/mappings\/([^/]+)\/credentials/.exec(u)
  if (m) {
    credCalls.push(m[1])
    if (credStatus !== 200) return { ok: false, status: credStatus, json: async () => ({ error: `HTTP ${credStatus}` }) }
    return ok(CREDS[m[1]] ?? { error: 'not found' })
  }
  throw new Error('unexpected fetch: ' + u)
}

const dir = new OnenatDirectory('https://onenat.example.com', 'onk-test', () => {})
const composer = new PromptComposer(dir)
const compose = (mappingId, mode = 'inline') =>
  composer.compose(
    { id: 'a1', name: 'probe', resources: [] },
    {
      resolvedAt: Date.now(),
      extraResources: [
        { ref: { kind: 'mapping', mappingId }, alias: `测试资源-${mappingId}`, credentialMode: mode, skillMode: 'none', note: '自检' },
      ],
    },
  )

await dir.refresh(true)

console.log('\n[1] 映射实例独立凭证（resolved_from=mapping）')
{
  const { block, warnings } = await compose('m-override')
  check('连接行用映射凭证里的用户名', block.includes('-p 1111 alice@box.example.com'))
  check('凭证行标注"映射实例独立凭证"', block.includes('来源: 映射实例独立凭证'))
  check('带取数时刻（快照可判龄）', /取数时刻: \d{4}-\d{2}-\d{2}T/.test(block))
  check('不出现"应用级默认凭证"告警', !block.includes('应用级默认凭证'))
  check('无 warning', warnings.length === 0)
}

console.log('\n[2] 继承应用默认凭证（resolved_from=app）')
{
  const { block, warnings } = await compose('m-inherit')
  check('标注"应用级默认凭证（该映射未设实例凭证）"', block.includes('应用级默认凭证（该映射未设实例凭证）'))
  check('给出该映射的现取凭证 curl', block.includes('/api/v1/mappings/m-inherit/credentials'))
  check('带 [平台接入] 段（old 实现只在静态 self-fetch 时给）', block.includes('[平台接入] ONENAT API'))
  check('约定 6：认证失败先现取、不要反复重试旧密码', block.includes('派发时刻的快照'))
  check('产生 warning（UI 可见）', warnings.some((w) => w.includes('应用级默认凭证')))
}

console.log('\n[3] 接口未返回 username 时不伪造 root')
{
  const { block } = await compose('m-nouser')
  check('连接行占位而非 root', block.includes('-p 3333 <用户名未返回>@box.example.com') && !/3333 root@/.test(block))
}

console.log('\n[4] 凭证缓存时效与失效 / 负缓存不冒充成功值')
{
  credCalls = []
  await dir.fetchMappingCredentials('m-override', true) // force
  const before = credCalls.length
  await dir.fetchMappingCredentials('m-override')
  check('TTL 内命中缓存（不再打网络）', credCalls.length === before)
  dir.invalidateCredential('m-override')
  const after = await dir.fetchMappingCredentials('m-override')
  check('invalidateCredential 后立即重新取数', credCalls.length === before + 1)
  check('重新取到的仍是实例凭证', after.ok && after.username === 'alice' && after.resolvedFrom === 'mapping')

  // 403 负缓存：不得把缓存的旧成功值当新凭证返回
  dir.invalidateCredential('m-override')
  credStatus = 403
  const denied = await dir.fetchMappingCredentials('m-override')
  check('403 返回 ok:false（不冒充旧成功值）', denied.ok === false)
  credCalls = []
  const deniedAgain = await dir.fetchMappingCredentials('m-override')
  check('负缓存命中（15s 内不再连环触发限速）', credCalls.length === 0 && deniedAgain.ok === false)
  credStatus = 200
  dir.invalidateCredential()
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
