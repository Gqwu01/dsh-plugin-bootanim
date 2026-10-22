// dsh-plugin-bootanim 的本地冒烟测试（不进包，仅开发用）。
// 用法：node test/smoke.mjs   或   npm test
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = fileURLToPath(new URL('../entry.js', import.meta.url))

let failures = 0
function check(name, condition, detail) {
  if (condition) { console.log('  PASS  ' + name) }
  else { failures += 1; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')) }
}

const profile = await mkdtemp(join(tmpdir(), 'dbv-profile-'))
const mod = await import(pathToFileURL(PLUGIN).href)

// ---- 伪造 cordis 上下文 ----
const routes = []
const listeners = []
const ctx = {
  webServer: { register(route) { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } },
  effect(fn) { return fn() },
  on(event, cb) { if (event === 'webserver/index-inject') listeners.push(cb) },
  inject(deps, cb) { cb({ get: () => ({ dir: profile }) }) },
  logger: { error() {}, warn() {} },
}

const config = {
  enabled: { get: () => true },
  clip: { get: () => 'custom/' + 'a'.repeat(8) + '-0000-0000-0000-000000000000_x.mp4' },
  fadeMs: { get: () => 800 },
  clickToEnter: { get: () => false },
  playOnce: { get: () => true },
}

mod.apply(ctx, config)

console.log('\n[1] 路由注册')
check('注册了 4 条路由', routes.length === 4, String(routes.length))
check('清单路由是 exact', routes.some(r => r.kind === 'exact' && r.path.endsWith('/clips.json')))
check('素材路由是 prefix', routes.some(r => r.kind === 'prefix' && r.path.endsWith('/clip')))
check('上传路由是 prefix', routes.some(r => r.kind === 'prefix' && r.path.endsWith('/upload')))
check('诊断路由是 exact', routes.some(r => r.kind === 'exact' && r.path.endsWith('/diag')))

console.log('\n[2] index 注入')
const table = []
for (const listener of listeners) listener(table)
check('注入两条 script', table.length === 2, String(table.length))
check('第一条是配置全局变量', table[0]?.text.includes('__DBV_CFG__'))
check('配置里带 src', table[0]?.text.includes('/clip/custom%2F'))
check('第二条是开机屏脚本', table[1]?.text.includes('clientReady'))
check('脚本可内联执行', table[1]?.text.includes('__DBV__') && table[1]?.text.includes('function'))

console.log('\n[3] HTTP 行为')
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const exact = routes.find(r => r.kind === 'exact' && r.path === path)
  if (exact) return exact.handler(req, res)
  const prefix = routes.filter(r => r.kind === 'prefix' && (path === r.path || path.startsWith(r.path + '/')))
    .sort((a, b) => b.path.length - a.path.length)[0]
  if (prefix) return prefix.handler(req, res)
  res.writeHead(404); res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port

const clips0 = await (await fetch(base + '/plugins/dsh-plugin-bootanim/clips.json')).json()
check('初始清单为空', Array.isArray(clips0.clips) && clips0.clips.length === 0)

// 上传一个 8 字节的假 mp4
const upload = await fetch(base + '/plugins/dsh-plugin-bootanim/upload?name=test.mp4', {
  method: 'POST', body: Buffer.from('01234567'),
})
const uploaded = await upload.json()
check('上传成功', upload.status === 200 && uploaded.ok === true, JSON.stringify(uploaded))
check('返回 custom/ id', typeof uploaded.clip === 'string' && uploaded.clip.startsWith('custom/'), uploaded.clip)

const clips1 = await (await fetch(base + '/plugins/dsh-plugin-bootanim/clips.json')).json()
check('清单出现 1 条', clips1.clips.length === 1, JSON.stringify(clips1.clips.map(c => c.id)))
check('id 带 custom/ 前缀', clips1.clips[0]?.id === uploaded.clip)

const full = await fetch(base + '/plugins/dsh-plugin-bootanim/clip/' + encodeURIComponent(uploaded.clip))
check('整段读取 200', full.status === 200)
check('content-length 正确', full.headers.get('content-length') === '8', full.headers.get('content-length'))
check('返回字节正确', (await full.text()) === '01234567')

const part = await fetch(base + '/plugins/dsh-plugin-bootanim/clip/' + encodeURIComponent(uploaded.clip), {
  headers: { range: 'bytes=2-5' },
})
const partBody = await part.text()
check('Range 返回 206', part.status === 206, String(part.status))
check('Range content-range 正确',
  part.headers.get('content-range') === 'bytes 2-5/8', part.headers.get('content-range'))
check('Range 内容正确', partBody === '2345', JSON.stringify(partBody))

const bad = await fetch(base + '/plugins/dsh-plugin-bootanim/clip/' + encodeURIComponent(uploaded.clip), {
  headers: { range: 'bytes=99-120' },
})
check('越界 Range 返回 416', bad.status === 416, String(bad.status))

const etag = full.headers.get('etag')
const cached = await fetch(base + '/plugins/dsh-plugin-bootanim/clip/' + encodeURIComponent(uploaded.clip), {
  headers: { 'if-none-match': etag },
})
check('ETag 命中返回 304', cached.status === 304, String(cached.status))

console.log('\n[4] 拒绝路径')
for (const evil of ['../package.json', 'custom/../entry.js', 'builtin/../../x.mp4', 'custom/x.exe']) {
  const response = await fetch(base + '/plugins/dsh-plugin-bootanim/clip/' + encodeURIComponent(evil))
  check('拒绝 ' + evil, response.status === 404, String(response.status))
}
const wrongMethod = await fetch(base + '/plugins/dsh-plugin-bootanim/upload?name=a.mp4')
check('上传拒绝 GET', wrongMethod.status === 405, String(wrongMethod.status))
const badName = await fetch(base + '/plugins/dsh-plugin-bootanim/upload?name=' + encodeURIComponent('..\\x.mp4'), {
  method: 'POST', body: Buffer.from('x'),
})
check('上传拒绝非法文件名', badName.status === 400, String(badName.status))

console.log('\n[5] 删除')
const removed = await fetch(base + '/plugins/dsh-plugin-bootanim/clip/' + encodeURIComponent(uploaded.clip), {
  method: 'DELETE',
})
check('删除成功', removed.status === 200, String(removed.status))
const clips2 = await (await fetch(base + '/plugins/dsh-plugin-bootanim/clips.json')).json()
check('删除后清单为空', clips2.clips.length === 0)

console.log('\n[5b] 诊断通道')
const diagPost = await fetch(base + '/plugins/dsh-plugin-bootanim/diag', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ stage: 'apply', detail: '{"slots":"function"}', at: 1 }),
})
check('diag 接受上报', diagPost.status === 200, String(diagPost.status))
const diagGet = await (await fetch(base + '/plugins/dsh-plugin-bootanim/diag')).json()
check('diag 能读回', Array.isArray(diagGet.entries) && diagGet.entries.length === 1, JSON.stringify(diagGet).slice(0, 120))
check('diag 内容正确', diagGet.entries[0]?.stage === 'apply')

console.log('\n[6] 关闭开关后不注入')
const listeners2 = []
const ctx2 = {
  webServer: { register: () => () => {} },
  effect(fn) { return fn() },
  on(event, cb) { if (event === 'webserver/index-inject') listeners2.push(cb) },
  inject(deps, cb) { cb({ get: () => ({ dir: profile }) }) },
  logger: { error() {}, warn() {} },
}
mod.apply(ctx2, { ...config, enabled: { get: () => false } })
const table2 = []
for (const listener of listeners2) listener(table2)
check('enabled=false 时零注入', table2.length === 0, String(table2.length))

console.log('\n[7] 无素材且 clip 为空时不注入')
const listeners3 = []
const ctx3 = { ...ctx2, on(event, cb) { if (event === 'webserver/index-inject') listeners3.push(cb) } }
mod.apply(ctx3, { ...config, clip: { get: () => '' } })
const table3 = []
for (const listener of listeners3) listener(table3)
check('无素材时零注入', table3.length === 0, String(table3.length))

console.log('\n[8] clip 为空但有素材时自动选一条')
const again = await fetch(base + '/plugins/dsh-plugin-bootanim/upload?name=auto.mp4', {
  method: 'POST', body: Buffer.from('abcdefgh'),
})
const autoClip = (await again.json()).clip
const listeners4 = []
const ctx4 = { ...ctx2, on(event, cb) { if (event === 'webserver/index-inject') listeners4.push(cb) } }
mod.apply(ctx4, { ...config, clip: { get: () => '' } })
const table4 = []
for (const listener of listeners4) listener(table4)
check('自动模式注入了 script', table4.length === 2, String(table4.length))
check('自动模式选中刚上传的素材',
  table4[0]?.text.includes(encodeURIComponent(autoClip)), table4[0]?.text.slice(0, 160))

await new Promise(resolve => server.close(resolve))
await rm(profile, { recursive: true, force: true })

console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
process.exitCode = failures === 0 ? 0 : 1
