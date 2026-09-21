/**
 * kimi-chat 本地服务单元测试 —— 话题 CRUD / 导出 / 安全边界（不起 MiniMax 的部分）
 * 运行：node tests/service.test.mjs
 * 说明：在临时 KIMI_CODE_HOME 下启动独立服务进程，不触碰真实状态目录。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 59931
const BASE = `http://127.0.0.1:${PORT}`
const home = mkdtempSync(path.join(tmpdir(), 'kc-svc-test-'))

let pass = 0, fail = 0
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok -', name) }
  else { fail++; console.log('  FAIL -', name) }
}
const j = (r) => r.json()

const child = spawn(process.execPath, [path.join(root, 'installer/service.cjs'), String(PORT)], {
  env: { ...process.env, KIMI_CODE_HOME: home },
  stdio: 'ignore',
})
await new Promise((r) => setTimeout(r, 1200))

try {
  console.log('健康检查与配置:')
  const h = await fetch(BASE + '/api/health').then(j)
  ok('health ok', h.ok === true)
  ok('临时 HOME 无 CLI 配置时 chat=null 且有 chat_error', h.chat === null && typeof h.chat_error === 'string')
  ok('未配置 key 时 image/tts=false', h.image === false && h.tts === false)

  console.log('话题 CRUD:')
  const t = await fetch(BASE + '/api/topics', { method: 'POST', body: '{}' }).then(j)
  ok('创建话题', /^t[a-z0-9]+$/.test(t.id) && t.title === '新话题')
  await fetch(BASE + '/api/topics/' + t.id + '/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'user', content: '你好' }),
  }).then(j)
  await fetch(BASE + '/api/topics/' + t.id + '/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'assistant', content: '<think>思考中</think>正式回复' }),
  }).then(j)
  const full = await fetch(BASE + '/api/topics/' + t.id).then(j)
  ok('消息落盘（2 条）', (full.messages || []).length === 2)
  await fetch(BASE + '/api/topics/' + t.id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '测试话题', pinned: true, icon: '🧪' }),
  }).then(j)
  const list = await fetch(BASE + '/api/topics').then(j)
  ok('列表含更新后的元数据', list.items.length === 1 && list.items[0].title === '测试话题' && list.items[0].pinned === true)
  ok('列表 preview 已去 think', list.items[0].preview === '正式回复')

  console.log('导出与安全边界:')
  const md = await fetch(BASE + '/api/topics/' + t.id + '/export').then((r) => r.text())
  ok('导出 Markdown 含标题与消息', md.includes('# 测试话题') && md.includes('你好'))
  const evilId = await fetch(BASE + '/api/topics/..%2F..%2Fetc').then((r) => r.status)
  ok('路径穿越被拒绝', evilId === 404 || evilId === 400)
  const noKey = await fetch(BASE + '/api/topics/' + t.id + '/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hi' }),
  }).then(j)
  ok('无聊天后端时返回明确错误', /配置失败|chat_base_url|聊天后端/.test(noKey.error || ''))
  const noKeyImg = await fetch(BASE + '/api/image', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'x' }),
  }).then(j)
  ok('未配 key 时生图返回明确错误', /image\.api_key|生图 provider/.test(noKeyImg.error || ''))
  const noKeyTts = await fetch(BASE + '/api/tts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'x' }),
  }).then(j)
  ok('未配 key 时语音返回明确错误', /tts\.api_key|语音 provider/.test(noKeyTts.error || ''))
  const nf = await fetch(BASE + '/api/topics/t不存在').then((r) => r.status)
  ok('不存在话题 404', nf === 404)
  const badImg = await fetch(BASE + '/images/..%2Fconfig.json').then((r) => r.status)
  ok('图片路径穿越被拒绝', badImg === 403 || badImg === 404)

  console.log('清空消息:')
  await fetch(BASE + '/api/topics/' + t.id + '/messages', { method: 'DELETE' }).then(j)
  const cleared = await fetch(BASE + '/api/topics/' + t.id).then(j)
  ok('清空后消息为空', (cleared.messages || []).length === 0)

  console.log('删除:')
  await fetch(BASE + '/api/topics/' + t.id, { method: 'DELETE' }).then(j)
  const after = await fetch(BASE + '/api/topics').then(j)
  ok('删除后列表为空', after.items.length === 0)
} finally {
  child.kill('SIGTERM')
  rmSync(home, { recursive: true, force: true })
}
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
