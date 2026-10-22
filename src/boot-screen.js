// dsh-plugin-bootanim — 开机屏脚本。
//
// 这段代码被宿主以「文本」形式内联进 index.html 的 <head>，在 React 挂载之前执行。
// 因此它必须：
//   · 不 import 任何东西（没有模块系统可用）
//   · 不依赖任何 DOM 已经存在（自己建）
//   · 任何异常都不能把屏幕永久盖住（所有分支都要能走到 reveal）
//
// 它通过 globalThis.__DBV__ 向外暴露一个 clientReady()，由浏览器半区在
// 内核就绪时调用 —— 这是「片放完」之外的第二个放行条件。

;(function () {
  'use strict'

  var cfg = globalThis.__DBV_CFG__
  if (!cfg || typeof cfg.src !== 'string' || cfg.src === '') return
  if (globalThis.__DBV__) return

  var FADE = typeof cfg.fadeMs === 'number' ? cfg.fadeMs : 800
  var HOLD = typeof cfg.holdMs === 'number' ? cfg.holdMs : 12000
  var CLICK_TO_ENTER = cfg.clickToEnter === true
  var STORE_KEY = 'dsh-plugin-bootanim:played'

  // 只播一次：sessionStorage 在同一标签页内跨刷新存活，
  // 所以 F5 不重播，而关掉客户端重开（新会话）= 重新播放。
  if (cfg.playOnce === true) {
    try {
      if (window.sessionStorage.getItem(STORE_KEY) === '1') return
    } catch (error) {
      /* 隐私模式下 sessionStorage 可能抛错，那就当作没播过 */
    }
  }

  // 尊重系统级的「减少动态效果」：不放片子，直接回到正常启动。
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  } catch (error) {
    /* matchMedia 不可用就按正常路径走 */
  }

  var done = false
  var clipDone = false
  var ready = false
  var root = null
  var video = null

  function markPlayed() {
    try {
      window.sessionStorage.setItem(STORE_KEY, '1')
    } catch (error) {
      /* 存不住就退化成每次播放，不影响进入 */
    }
  }

  /** 唯一的出口。幂等；任何调用方都不该让它抛错。 */
  function reveal() {
    if (done) return
    done = true
    markPlayed()
    try {
      if (root === null) return
      root.style.setProperty('opacity', '0')
      var fading = root
      root = null
      window.setTimeout(function () {
        if (fading.parentNode) fading.parentNode.removeChild(fading)
      }, FADE + 60)
    } catch (error) {
      /* 移除失败也不该阻塞页面 */
    }
  }

  /** 两个条件都满足才进入；click 模式下片放完也不放行。 */
  function maybeReveal() {
    if (done) return
    if (CLICK_TO_ENTER) return
    if (!clipDone) return
    if (!ready) {
      setHint('正在加载…')
      return
    }
    reveal()
  }

  var hint = null
  function setHint(text) {
    if (hint !== null && hint.textContent !== text) hint.textContent = text
  }

  function build() {
    root = document.createElement('div')
    root.setAttribute('data-dbv-root', '')
    root.setAttribute('aria-label', 'DSH 开机动画')
    root.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483000',
      'display:flex', 'align-items:center', 'justify-content:center',
      'background:#0f1013', 'opacity:1',
      'transition:opacity ' + String(FADE) + 'ms cubic-bezier(0.4,0,0.2,1)',
      'overflow:hidden',
    ].join(';')

    video = document.createElement('video')
    video.src = cfg.src
    video.muted = true          // 静音是自动播放唯一可靠的前提
    video.autoplay = true
    video.playsInline = true
    video.preload = 'auto'
    video.setAttribute('aria-hidden', 'true')
    video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#0f1013'
    root.appendChild(video)

    hint = document.createElement('div')
    hint.textContent = CLICK_TO_ENTER ? '点击进入' : '正在启动…'
    hint.style.cssText = [
      'position:absolute', 'bottom:28px', 'left:0', 'right:0',
      'text-align:center', 'font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif',
      'color:rgba(255,255,255,0.55)', 'letter-spacing:0.04em', 'pointer-events:none',
    ].join(';')
    root.appendChild(hint)

    document.body.appendChild(root)

    video.addEventListener('ended', function () {
      clipDone = true
      maybeReveal()
    }, { once: true })

    // 素材不可播（编码不支持、文件被删、路径 404）—— 立刻放行，绝不盖住屏幕。
    video.addEventListener('error', function () { reveal() }, { once: true })
    // 走了网络但迟迟没有画面，也不能无限等。
    video.addEventListener('stalled', function () { window.setTimeout(reveal, 2000) }, { once: true })

    var played = video.play()
    if (played && typeof played.catch === 'function') {
      played.catch(function () {
        // 极少数策略下连静音自动播放都被拒：退化成静态首帧，不再等 ended。
        clipDone = true
        maybeReveal()
      })
    }
  }

  // 交互放行：点击 / Esc / 空格 / 回车。click 模式下这是唯一的出口。
  function press() {
    if (CLICK_TO_ENTER || document.hasFocus()) reveal()
  }
  window.addEventListener('pointerdown', press, true)
  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' || event.key === ' ' || event.key === 'Enter') press()
  }, true)

  // 硬兜底：无论片子和内核发生什么，HOLD 之后一定进入。
  window.setTimeout(reveal, HOLD)

  globalThis.__DBV__ = {
    clientReady: function () {
      ready = true
      maybeReveal()
    },
  }

  try {
    if (document.body) build()
    else document.addEventListener('DOMContentLoaded', build, { once: true })
  } catch (error) {
    // 建房失败也必须放行，否则就是一个盖死页面的空壳。
    reveal()
  }
})()
