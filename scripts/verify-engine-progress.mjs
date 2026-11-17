import assert from 'node:assert/strict'
import { JobManager } from '../lib/engine/jobs.js'

let complete
let context
const gate = new Promise(resolve => { complete = resolve })
const jobs = new JobManager()
jobs.start('install', '安装客户端', async ctx => {
  context = ctx
  ctx.phase('downloading', '正在下载', { percent: 100, bytesDone: 1024, bytesTotal: 1024 })
  await gate
  return { message: '客户端安装完成' }
})
assert.equal(jobs.current().percent, 100)
context.phase('verifying', '正在校验')
assert.equal(jobs.current().percent, null)
assert.equal(jobs.current().bytesDone, undefined)
assert.equal(jobs.current().bytesTotal, undefined)
assert.equal(jobs.current().message, '正在校验')
context.phase('extracting')
assert.equal(jobs.current().message, undefined)
complete()
await new Promise(resolve => setImmediate(resolve))
assert.equal(jobs.current().phase, 'done')
assert.equal(jobs.current().message, '客户端安装完成')
assert.equal(jobs.current().percent, 100)
assert.equal(jobs.isBusy(), false)

const failure = new JobManager()
failure.start('install', '安装失败', async () => { throw new Error('下载连接超时') })
await new Promise(resolve => setImmediate(resolve))
assert.equal(failure.current().phase, 'failed')
assert.equal(failure.current().error, '下载连接超时')
console.log('PASS: phase progress resets; completion and failure results persist')
