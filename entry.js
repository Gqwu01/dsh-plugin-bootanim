// dsh-plugin-bootanim — 宿主半区。
//
// 职责只有两件，且都在启动路径上，所以刻意写得短：
//   1. 把素材（内置 + 用户上传）当作 HTTP 资源供出去，支持 Range。
//   2. 在 index.html 的 <head> 里注入「配置全局变量 + 开机屏脚本」。
//
// 不碰 DSH 源码，不做任何网络外发，不读取会话内容。

import z from '@deepseek-ai/schemastery'
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** loader 按裸包名解析本模块，必须与 package.json 的 name 一致。 */
export const name = 'dsh-plugin-bootanim'

/** 没有 webServer 就没有路由，也就没有开机屏。 */
export const inject = ['webServer']

const ROUTE = '/plugins/dsh-plugin-bootanim'
const SCREEN = fileURLToPath(new URL('./src/boot-screen.js', import.meta.url))
const BUILTIN_DIR = fileURLToPath(new URL('./assets/videos', import.meta.url))

const EXTENSIONS = new Set(['.mp4', '.webm', '.m4v', '.mov'])
const UPLOAD_LIMIT = 256 * 1024 * 1024
const NAME_LIMIT = 160

/** schemastery 3.18.4 起才有 .volatile()；缺了就让设置卡降级隐藏，而不是让模块求值抛错。 */
const LIVE_CAPABLE = typeof z.boolean().default(true).volatile === 'function'

/** 把一个字段标成「可在设置页编辑」。只有 volatile 字段会被设置服务投影出来。 */
function live(schema) {
  return LIVE_CAPABLE ? schema.volatile() : schema
}

/**
 * 本插件的设置。
 *
 * 每个字段都是 volatile：loader 认为「只有可变值变了」时不会重启 fiber，
 * 而是把新值提交进同一个引用并触发 loader/volatile-update —— 所以 apply
 * 不会重跑，读配置必须每次走 config.<key>.get()，不能在 apply 里快照。
 */
export const Config = z.object({
  /** 总开关。关掉则一条 script 都不注入，内核自己的启动页接管。 */
  enabled: live(z.boolean().default(true)),
  /** 要播放的素材 id：'builtin/x.mp4' 或 'custom/<uuid>_x.mp4'；空串表示自动取第一条。 */
  clip: live(z.string().default('')),
  /** 淡出时长，毫秒。 */
  fadeMs: live(z.number().min(200).max(5000).default(800)),
  /** true 时只有用户点击/按键才进入，片放完也不自动放行。 */
  clickToEnter: live(z.boolean().default(false)),
  /** true 时同一个标签页只播一次（刷新不重播）；false 则每次页面加载都播。 */
  playOnce: live(z.boolean().default(true)),
})

/** 读取一个字段的当前值（兼容 volatile 引用与普通快照两种形状）。 */
function read(config, key, fallback) {
  try {
    const value = config?.[key]
    const resolved = typeof value?.get === 'function' ? value.get() : value
    return resolved === undefined || resolved === null ? fallback : resolved
  } catch {
    return fallback
  }
}

function contentType(file) {
  switch (extname(file).toLowerCase()) {
    case '.webm': return 'video/webm'
    case '.m4v': return 'video/x-m4v'
    case '.mov': return 'video/quicktime'
    default: return 'video/mp4'
  }
}

function sendJson(res, status, value) {
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/** 上传/删除只允许本机发起，避免隧道或远程界面成为写入入口。 */
function isLoopback(req) {
  let remote = req.socket?.remoteAddress ?? ''
  if (remote.startsWith('::ffff:')) remote = remote.slice(7)
  return remote === '127.0.0.1' || remote === '::1'
}

/** 解析 Range 头；返回 null 表示整段，{ invalid: true } 表示 416。 */
function parseRange(header, size) {
  if (typeof header !== 'string') return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const rawStart = match[1]
  const rawEnd = match[2]
  if (rawStart === '' && rawEnd === '') return null
  let start
  let end
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true }
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true }
    if (end >= size) end = size - 1
  }
  if (start > end || start >= size) return { invalid: true }
  return { start, end }
}

/**
 * 以 HTTP Range 语义发送一个文件。
 *
 * 大文件必须走 Range：否则浏览器要把整段素材下完才出第一帧，
 * 而开机屏最不能接受的就是「黑屏等 53MB」。
 */
async function serveFile(file, req, res) {
  let info
  try {
    info = await stat(file)
  } catch {
    sendJson(res, 404, { ok: false, error: 'not found' })
    return
  }
  const size = info.size
  const etag = `"${Math.round(info.mtimeMs).toString(16)}-${size.toString(16)}"`

  res.setHeader('content-type', contentType(file))
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('etag', etag)
  res.setHeader('cache-control', 'no-cache')

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304)
    res.end()
    return
  }

  const range = parseRange(req.headers.range, size)
  if (range !== null && range.invalid === true) {
    res.writeHead(416, { 'content-range': `bytes */${size}` })
    res.end()
    return
  }

  if (range !== null) {
    res.writeHead(206, {
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
      'content-length': String(range.end - range.start + 1),
    })
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(file, { start: range.start, end: range.end }).pipe(res)
    return
  }

  res.writeHead(200, { 'content-length': String(size) })
  if (req.method === 'HEAD') { res.end(); return }
  createReadStream(file).pipe(res)
}

/** 列出某个目录下的可用素材。目录不存在就是空列表，不算错误。 */
async function listDir(dir, scope) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const clips = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
    if (entry.name.startsWith('.')) continue
    const file = join(dir, entry.name)
    let info
    try {
      info = await stat(file)
    } catch {
      continue
    }
    const id = `${scope}/${entry.name}`
    clips.push({
      id,
      name: entry.name,
      scope,
      bytes: info.size,
      mtime: Math.round(info.mtimeMs),
      // revision 同时承担缓存失效与 ETag：文件一变 URL 就变，旧缓存自然失效。
      src: `${ROUTE}/clip/${encodeURIComponent(id)}?v=${Math.round(info.mtimeMs)}-${info.size}`,
    })
  }
  clips.sort((left, right) => right.mtime - left.mtime)
  return clips
}

/**
 * 把「已解码」的 id 解析成绝对路径。
 *
 * id 只有两种合法形状：`builtin/<文件名>` 与 `custom/<文件名>`。
 * 只接受单层路径 + 合法扩展名，并再校验一次目录包含关系，
 * 这样即使请求里夹了编码过的分隔符也逃不出素材目录。
 */
function resolveClip(decoded, customDir) {
  const parts = decoded.split('/')
  if (parts.length !== 2) return null
  const [scope, name] = parts
  if (name === '' || name !== basename(name)) return null
  if (!EXTENSIONS.has(extname(name).toLowerCase())) return null
  let dir
  if (scope === 'builtin') dir = BUILTIN_DIR
  else if (scope === 'custom') dir = customDir
  else return null
  if (dir === null) return null
  const base = resolve(dir)
  const file = resolve(base, name)
  if (file !== join(base, name) || !file.startsWith(base + sep)) return null
  return file
}

/**
 * 「自动」时要播哪一条：取最近改动过的一条素材（内置优先，其次自定义）。
 *
 * 注入发生在 index 渲染里，必须是同步的，所以这里用同步扫目录：
 * 两个目录、几个文件，代价可以忽略。目录不存在/为空就返回空串，
 * 调用方据此决定不注入。
 */
function pickDefault(customDir) {
  const candidates = []
  for (const [dir, scope] of [[BUILTIN_DIR, 'builtin'], [customDir, 'custom']]) {
    if (dir === null || dir === undefined) continue
    let names
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (name.startsWith('.') || !EXTENSIONS.has(extname(name).toLowerCase())) continue
      try {
        const info = statSync(join(dir, name))
        if (!info.isFile()) continue
        candidates.push({ id: `${scope}/${name}`, mtime: info.mtimeMs })
      } catch {
        continue
      }
    }
  }
  if (candidates.length === 0) return ''
  candidates.sort((left, right) => right.mtime - left.mtime)
  return candidates[0].id
}

export function apply(ctx, config) {
  const server = ctx.webServer

  // 用户素材放在 profile 的数据目录里，不放进 node_modules —— 这样升级插件不会覆盖它们。
  const state = { customDir: null }
  ctx.inject(['profileContext'], (scoped) => {
    try {
      const dir = scoped.get('profileContext')?.dir
      if (typeof dir === 'string' && dir !== '') state.customDir = join(dir, 'data', 'dsh-plugin-bootanim', 'videos')
    } catch {
      /* 拿不到 profile 目录时只影响「上传」，内置素材照常可用 */
    }
  })

  /**
   * 挂一条 HTTP 路由，并把它绑到本插件的 fiber 上 —— 插件卸载时会自动注销。
   * 交给 ctx.effect 而不是自己攒 dispose，是为了让「插件消失了路由还在」这种
   * 情况根本不可能发生。
   */
  const mount = (route) => ctx.effect(
    () => server.register(route),
    `dsh-plugin-bootanim: ${route.path}`,
  )

  /** 素材清单：卡片用它渲染下拉框，开机屏不需要它（src 在注入时已经算好）。 */
  mount({
    kind: 'exact',
    path: `${ROUTE}/clips.json`,
    handler: (req, res) => {
      void (async () => {
        const builtin = await listDir(BUILTIN_DIR, 'builtin')
        const custom = state.customDir === null ? [] : await listDir(state.customDir, 'custom')
        sendJson(res, 200, { ok: true, clips: [...builtin, ...custom] })
      })().catch((error) => {
        ctx.logger?.error?.('dsh-plugin-bootanim: clips.json failed', error)
        sendJson(res, 500, { ok: false, error: 'internal' })
      })
    },
  })

  /** 素材本体：GET/HEAD 走 Range，DELETE 删除自定义素材。 */
  mount({
    kind: 'prefix',
    path: `${ROUTE}/clip`,
    handler: (req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rest = url.pathname.slice(`${ROUTE}/clip/`.length)
        // id 在 URL 里是编码过的（`custom%2Fa.mp4`），所有判断都必须基于解码后的形状。
        let decoded = ''
        try {
          decoded = decodeURIComponent(rest)
        } catch {
          decoded = ''
        }
        const file = decoded === '' ? null : resolveClip(decoded, state.customDir)

        if (file === null) {
          sendJson(res, 404, { ok: false, error: 'not found' })
          return
        }

        if (req.method === 'DELETE') {
          if (!isLoopback(req)) { sendJson(res, 403, { ok: false, error: 'loopback only' }); return }
          if (!decoded.startsWith('custom/')) { sendJson(res, 400, { ok: false, error: '内置素材不能删除' }); return }
          try {
            await unlink(file)
            sendJson(res, 200, { ok: true })
          } catch {
            sendJson(res, 404, { ok: false, error: 'not found' })
          }
          return
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }

        await serveFile(file, req, res)
      })().catch((error) => {
        ctx.logger?.error?.('dsh-plugin-bootanim: clip route failed', error)
        sendJson(res, 500, { ok: false, error: 'internal' })
      })
    },
  })
  /** 上传：POST 原始字节，文件名走 query。先写临时文件再原子改名。 */
  mount({
    kind: 'prefix',
    path: `${ROUTE}/upload`,
    handler: (req, res) => {
      void (async () => {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
        if (!isLoopback(req)) { sendJson(res, 403, { ok: false, error: 'loopback only' }); return }
        if (state.customDir === null) { sendJson(res, 503, { ok: false, error: '素材目录不可用' }); return }

        const url = new URL(req.url ?? '/', 'http://localhost')
        const raw = url.searchParams.get('name') ?? ''
        const name = basename(raw)
        const valid = name !== '' && name === raw
          && EXTENSIONS.has(extname(name).toLowerCase())
          && !/[\\/:\x00-\x1f]/.test(name)
          && Buffer.byteLength(name, 'utf8') <= NAME_LIMIT
        if (!valid) { sendJson(res, 400, { ok: false, error: '文件名不合法' }); return }

        await mkdir(state.customDir, { recursive: true })
        const stored = `${randomUUID()}_${name}`
        const temp = join(state.customDir, `.upload-${randomUUID()}`)
        const handle = await open(temp, 'w')
        let bytes = 0
        try {
          for await (const chunk of req) {
            bytes += chunk.length
            if (bytes > UPLOAD_LIMIT) {
              const error = new Error('视频超过 256MB')
              error.status = 413
              throw error
            }
            await handle.write(chunk)
          }
        } catch (error) {
          await handle.close().catch(() => {})
          await unlink(temp).catch(() => {})
          sendJson(res, error.status ?? 500, { ok: false, error: String(error.message ?? error) })
          return
        }
        await handle.close()
        await rename(temp, join(state.customDir, stored))
        sendJson(res, 200, { ok: true, clip: `custom/${stored}` })
      })().catch((error) => {
        ctx.logger?.error?.('dsh-plugin-bootanim: upload failed', error)
        sendJson(res, 500, { ok: false, error: 'internal' })
      })
    },
  })

  /**
   * 诊断上报：浏览器半区把「执行到哪一步」写回来，外部直接 GET 就能读。
   * 只为排查「卡片不出现」这类静默失败，不参与任何功能。
   */
  const diag = []
  mount({
    kind: 'exact',
    path: `${ROUTE}/diag`,
    handler: (req, res) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        sendJson(res, 200, { ok: true, entries: diag })
        return
      }
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      if (!isLoopback(req)) { sendJson(res, 403, { ok: false, error: 'loopback only' }); return }
      void (async () => {
        let text = ''
        for await (const chunk of req) {
          text += chunk.toString('utf8')
          if (text.length > 8192) break
        }
        let entry
        try {
          entry = JSON.parse(text)
        } catch {
          entry = { raw: text.slice(0, 500) }
        }
        diag.push(entry)
        while (diag.length > 50) diag.shift()
        sendJson(res, 200, { ok: true })
      })().catch((error) => {
        ctx.logger?.warn?.('dsh-plugin-bootanim: diag 写入失败', error)
        try { res.writeHead(204); res.end() } catch { /* 客户端已断开 */ }
      })
    },
  })

  /**
   * 注入开机屏。
   *
   * 选中的素材在这一步就解析成一个具体 URL，所以开机屏脚本不需要再发任何请求 ——
   * 少一次往返就少一段黑屏。
   */
  ctx.on('webserver/index-inject', (table) => {
    if (read(config, 'enabled', true) !== true) return

    const configured = String(read(config, 'clip', '') ?? '')
    // 空串表示「自动」：挑一条现有素材，而不是不播。
    const clipId = configured === '' ? pickDefault(state.customDir) : configured
    const src = clipId === '' ? '' : `${ROUTE}/clip/${encodeURIComponent(clipId)}`

    // 没有可播素材时什么都不注入：内核自己的启动页比一块纯色遮罩更诚实。
    if (src === '') return

    let screen = ''
    try {
      screen = readFileSync(SCREEN, 'utf8')
    } catch (error) {
      ctx.logger?.warn?.('dsh-plugin-bootanim: 读不到开机屏脚本，退回内核启动页', error)
      return
    }

    table.push({
      kind: 'script',
      placement: 'head',
      text: `globalThis.__DBV_CFG__=${JSON.stringify({
        src,
        fadeMs: read(config, 'fadeMs', 800),
        clickToEnter: read(config, 'clickToEnter', false) === true,
        playOnce: read(config, 'playOnce', true) !== false,
        holdMs: 12000,
      })}`,
    })
    table.push({ kind: 'script', placement: 'head', text: screen })
  })
}
