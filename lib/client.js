window.__ModuleLoader__.load({ id: "dsh-plugin-bootanim", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
// dsh-plugin-bootanim — 浏览器半区。
//
// 两个职责，顺序不能换：
//   1. 告诉开机屏「内核已就绪」（clientReady）。这是放行条件的一半，
//      必须无条件、最先执行，且不能被下面任何逻辑阻塞。
//   2. 往「插件」页里贡献一张配置卡：开关、选片、上传、删除。
//
// 卡片挂在 `plugins.bundle.config`，键是**包名**（该 slot 用 options.key 作键）。
// 不要挂到 `plugins.item`：那个 slot 是给「官方插件」用的，会被只读清单按 id 过滤，
// 第三方 bundle 挂进去不会报错，但也永远不显示 —— 这是最容易踩的坑。

const NAMESPACE = 'bootanim'          // 必须等于 cordis.patch.yml 里的行 id
const PACKAGE = 'dsh-plugin-bootanim' // 必须等于 package.json 的 name
const ROUTE = '/plugins/dsh-plugin-bootanim'
const SLOT = 'plugins.bundle.config'

// React 必须是模块级常量：组件在 render 阶段要拿到它，而 apply 里的局部变量
// 对组件不可见（踩过：Entry 里用 apply 的局部 React -> ReferenceError -> 空白）。
const ReactRuntime = (function () {
  try {
    return require('react')
  } catch (error) {
    return null
  }
})()

const CSS = `
.dbv-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0}
.dbv-label{font-size:13px;color:var(--dsw-alias-label-primary,inherit)}
.dbv-dim{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.dbv-note{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);margin:2px 0 8px}
.dbv-error{font-size:12px;color:#d9534f;margin-top:8px;word-break:break-all}
.dbv-ok{font-size:12px;color:#2f9e44;margin-top:8px}
.dbv-select{min-width:220px;max-width:100%;font:inherit;font-size:12px;padding:4px 6px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:inherit}
.dbv-btn{font:inherit;font-size:12px;padding:5px 10px;border-radius:6px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:inherit}
.dbv-btn:disabled{opacity:.5;cursor:default}
.dbv-btn-danger{color:#d9534f}
`

/** 样式表只注入一次；用自定义属性做标记，避免和别人的 id 撞车。 */
function injectStyles() {
  if (typeof document === 'undefined' || document.head === null) return
  if (document.head.querySelector('style[data-dsh-plugin-bootanim]') !== null) return
  const sheet = document.createElement('style')
  sheet.setAttribute('data-dsh-plugin-bootanim', '')
  sheet.textContent = CSS
  document.head.append(sheet)
}

/**
 * 找出「能读」和「能写」的两个面。
 *
 * 卡片拿到的 props 里 `form` 是设置页自己接的通道，`scope` 是 configForms
 * 注入的命名空间。前者可观察性最好，所以优先；两者都可能缺，缺了就让卡片只读。
 */
function bindForm(props) {
  const candidates = [props.form, props.scope].filter(item => item !== null && item !== undefined)
  const observable = candidates.find(item =>
    typeof item.subscribe === 'function' && typeof item.getSnapshot === 'function')
  const writable = candidates.find(item => typeof item.mutate === 'function')

  let fallback = { status: 'unavailable', value: {}, writable: false }
  if (props.form?.state !== undefined) fallback = props.form.state
  else if (typeof props.scope?.getSnapshot === 'function') fallback = props.scope.getSnapshot()

  return {
    source: observable ?? null,
    fallback,
    mutate: writable === undefined ? null : (ops, revision) => writable.mutate(ops, revision),
  }
}

/**
 * 把可观察的 form/scope 变成 React 用的快照。
 *
 * 这里刻意不用 useSyncExternalStore：它要求 getSnapshot() 返回稳定引用，
 * 而宿主表单的快照对象不保证每次调用同一个引用 —— 那样会触发
 * "The result of getSnapshot should be cached" 并无限重渲染。
 * 用 useState + subscribe 是稳妥写法。
 */
function useFormState(React, form) {
  const read = () => (form.source === null ? form.fallback : form.source.getSnapshot())
  const [state, setState] = React.useState(read)

  React.useEffect(() => {
    if (form.source === null || typeof form.source.subscribe !== 'function') return undefined
    const sync = () => { setState(read()) }
    sync()
    const off = form.source.subscribe(sync)
    return typeof off === 'function' ? off : undefined
  }, [form.source, form.fallback])

  return state
}

/** 自定义素材的真实文件名前面有 36 位 UUID + 下划线，显示时去掉。 */
function displayName(clip) {
  if (clip.scope !== 'custom') return clip.name
  const index = clip.name.indexOf('_')
  return index === 37 ? clip.name.slice(38) : clip.name
}

function bytes(size) {
  if (typeof size !== 'number' || size <= 0) return ''
  if (size >= 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB'
  return Math.round(size / 1024) + ' KB'
}

function Summary(props) {
  const React = props.runtime === undefined || props.runtime === null ? ReactRuntime : props.runtime
  const stored = props.form?.state?.value ?? {}
  const enabled = stored.enabled !== false
  const clip = typeof stored.clip === 'string' ? stored.clip : ''
  const short = clip === '' ? '未选择' : clip.split('/').pop().replace(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}_/i, '')
  return React.createElement(
    'div',
    { className: 'dbv-row' },
    React.createElement('span', { className: 'dbv-label' }, '开机动画'),
    React.createElement('span', { className: 'dbv-dim' }, enabled ? short : '已关闭'),
  )
}

function Card(props) {
  const React = props.runtime === undefined || props.runtime === null ? ReactRuntime : props.runtime
  // 进到这里才说明卡片真的开始渲染了；上面 Entry 的 try 只能覆盖元素创建。
  if (!reported.has('card')) {
    reported.add('card')
    report('card-enter', JSON.stringify({
      runtime: typeof props.runtime,
      scope: typeof props.scope,
      hasForm: props.form !== undefined && props.form !== null,
    }))
  }
  const form = bindForm(props)
  const snapshot = useFormState(React, form)
  const stored = snapshot?.value ?? {}
  const writable = form.mutate !== null && snapshot?.writable !== false && snapshot?.status !== 'unavailable'

  const [clips, setClips] = React.useState(null)
  const [failure, setFailure] = React.useState(null)
  const [notice, setNotice] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const fileInput = React.useRef(null)

  const enabled = stored.enabled !== false
  const selected = typeof stored.clip === 'string' ? stored.clip : ''
  const playOnce = stored.playOnce !== false
  const clickToEnter = stored.clickToEnter === true

  const refresh = React.useCallback(async () => {
    try {
      const response = await fetch(ROUTE + '/clips.json', { cache: 'no-store', credentials: 'same-origin' })
      const payload = await response.json()
      if (!Array.isArray(payload.clips)) throw new Error('清单格式无效')
      setClips(payload.clips)
      setFailure(null)
    } catch (error) {
      setFailure('读取素材失败：' + String(error))
    }
  }, [])

  React.useEffect(() => { void refresh() }, [refresh])

  const write = React.useCallback(async (field, value) => {
    if (!writable) { setFailure('这一页没有连上设置文档，改动不会保存。'); return false }
    setBusy(true)
    setFailure(null)
    setNotice(null)
    try {
      const accepted = await form.mutate([{ op: 'set', path: [field], value }], snapshot?.revision)
      if (accepted === false) throw new Error('写入被拒绝（可能是版本冲突，重开这一页再试）')
      return true
    } catch (error) {
      setFailure('保存失败：' + String(error))
      return false
    } finally {
      setBusy(false)
    }
  }, [writable, form, snapshot])

  const onPick = async (event) => {
    const file = event.target.files && event.target.files[0]
    event.target.value = ''
    if (!file) return
    setBusy(true)
    setFailure(null)
    setNotice(null)
    try {
      const response = await fetch(ROUTE + '/upload?name=' + encodeURIComponent(file.name), {
        method: 'POST', body: file, credentials: 'same-origin',
      })
      const payload = await response.json()
      if (!response.ok || payload.ok !== true) throw new Error(payload.error || ('HTTP ' + response.status))
      await refresh()
      await write('clip', payload.clip)
      setNotice('已导入：' + file.name)
    } catch (error) {
      setFailure('导入失败：' + String(error))
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async () => {
    if (selected === '' || !selected.startsWith('custom/')) return
    setBusy(true)
    setFailure(null)
    setNotice(null)
    try {
      const response = await fetch(ROUTE + '/clip/' + encodeURIComponent(selected), {
        method: 'DELETE', credentials: 'same-origin',
      })
      const payload = await response.json()
      if (!response.ok || payload.ok !== true) throw new Error(payload.error || ('HTTP ' + response.status))
      await write('clip', '')
      await refresh()
      setNotice('已删除')
    } catch (error) {
      setFailure('删除失败：' + String(error))
    } finally {
      setBusy(false)
    }
  }

  const options = [{ id: '', label: '自动（最近的一条素材）' }].concat(
    (clips || []).map((clip) => ({
      id: clip.id,
      label: displayName(clip) + (clip.bytes ? '  ' + bytes(clip.bytes) : '') + (clip.scope === 'custom' ? '（自定义）' : ''),
    })),
  )

  return React.createElement(
    'div',
    null,
    React.createElement('div', { className: 'dbv-note' },
      '打开 DSH 时播放选定的动画。上传的视频存在 profile 的数据目录里，升级插件不会丢。'),

    React.createElement('div', { className: 'dbv-row' },
      React.createElement('span', { className: 'dbv-label' }, '启用开机动画'),
      React.createElement('input', {
        type: 'checkbox', checked: enabled, disabled: busy || !writable,
        onChange: (event) => { void write('enabled', event.target.checked) },
      }),
    ),

    React.createElement('div', { className: 'dbv-row' },
      React.createElement('span', { className: 'dbv-label' }, '播放的视频'),
      React.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
        React.createElement('select', {
          className: 'dbv-select', value: selected, disabled: busy || !writable || clips === null,
          onChange: (event) => { void write('clip', event.target.value) },
        }, options.map((option) => React.createElement('option', { key: option.id, value: option.id }, option.label))),
        React.createElement('button', {
          className: 'dbv-btn', disabled: busy || !writable,
          onClick: () => { if (fileInput.current) fileInput.current.click() },
        }, '上传…'),
        React.createElement('input', {
          ref: fileInput, type: 'file', accept: 'video/mp4,video/webm,video/quicktime,.mp4,.webm,.m4v,.mov',
          style: { display: 'none' }, onChange: (event) => { void onPick(event) },
        }),
        selected.startsWith('custom/')
          ? React.createElement('button', {
              className: 'dbv-btn dbv-btn-danger', disabled: busy || !writable, onClick: () => { void onDelete() },
            }, '删除')
          : null,
      ),
    ),

    React.createElement('div', { className: 'dbv-row' },
      React.createElement('span', { className: 'dbv-label' }, '同一个标签页只播一次（刷新不重播）'),
      React.createElement('input', {
        type: 'checkbox', checked: playOnce, disabled: busy || !writable,
        onChange: (event) => { void write('playOnce', event.target.checked) },
      }),
    ),

    React.createElement('div', { className: 'dbv-row' },
      React.createElement('span', { className: 'dbv-label' }, '必须点击才进入（不自动放行）'),
      React.createElement('input', {
        type: 'checkbox', checked: clickToEnter, disabled: busy || !writable,
        onChange: (event) => { void write('clickToEnter', event.target.checked) },
      }),
    ),

    failure === null ? null : React.createElement('div', { className: 'dbv-error' }, failure),
    notice === null ? null : React.createElement('div', { className: 'dbv-ok' }, notice),
    !writable ? React.createElement('div', { className: 'dbv-note' }, '当前部署没有可写的设置文档，卡片只读。') : null,
  )
}

/** 防诊断刷屏：每种视图只上报一次。 */
const reported = new Set()

function Entry(props) {
  const React = props.runtime === undefined || props.runtime === null ? ReactRuntime : props.runtime
  if (React === null || typeof React.createElement !== 'function') {
    report('render-bail', 'no react')
    return null
  }
  try {
    const view = props.view === 'summary' ? 'summary' : 'page'
    const node = view === 'summary' ? Summary(props) : React.createElement(Card, props)
    if (!reported.has(view)) {
      reported.add(view)
      report('rendered', view)
    }
    return node
  } catch (error) {
    report('render-failed', (error && error.message) || String(error))
    console.warn('dsh-plugin-bootanim: 卡片渲染失败', error)
    return null
  }
}

/** 诊断上报：把执行到哪一步、拿到什么服务、报了什么错回传给宿主，外部可直接查。 */
function report(stage, detail) {
  try {
    void fetch(ROUTE + '/diag', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage, detail: detail === undefined ? null : String(detail), at: Date.now() }),
      keepalive: true,
    }).catch(function () {})
  } catch (error) {
    /* 诊断通道失败不能影响主流程 */
  }
}

// 声明式依赖：apply 会在这些服务就绪后才执行，且它们是 ctx 上的普通属性。
// 不要改成 ctx.inject(...) 动态等待 —— 在浏览器侧那样写回调不会触发，
// 症状是「代码没错但卡片永远不出现」，且不报任何错。
const inject = ['slots', 'configForms']

exports.inject = inject

exports.apply = function apply(ctx) {
  // 1. 放行握手 —— 必须最先、无条件。
  try {
    const overlay = globalThis.__DBV__
    if (overlay !== undefined && overlay !== null && typeof overlay.clientReady === 'function') {
      overlay.clientReady()
    }
  } catch (error) {
    console.warn('dsh-plugin-bootanim: clientReady 失败', error)
  }

  const slots = ctx === null || ctx === undefined ? undefined : ctx.slots
  const forms = ctx === null || ctx === undefined ? undefined : ctx.configForms
  report('apply', JSON.stringify({
    slots: slots === null || slots === undefined ? typeof slots : typeof slots.inject,
    forms: forms === null || forms === undefined ? typeof forms : typeof forms.whileServed,
  }))

  if (typeof slots?.inject !== 'function') { report('bail', 'no slots'); return }
  if (typeof forms?.get !== 'function') { report('bail', 'no forms.get'); return }
  if (typeof forms?.whileServed !== 'function') { report('bail', 'no whileServed'); return }

  const React = ReactRuntime
  if (React === null || typeof React.createElement !== 'function') { report('bail', 'no react'); return }

  injectStyles()

  /** 已挂载的注销函数；null 表示当前没有挂载。 */
  let live = null

  const mount = () => {
    if (live !== null) return
    try {
      live = slots.inject(SLOT, () => slots.register({
        name: SLOT,
        key: PACKAGE,
        inject: () => ({ runtime: React, scope: forms.get(NAMESPACE) }),
      }, Entry))
      report('registered', SLOT + ' key=' + PACKAGE)
    } catch (error) {
      // 同一键重复注册会在账本通知里抛出，并连带毒死已挂载卡片的更新。
      // 自己接住这次失败，让在位的那张继续工作。
      live = null
      report('register-failed', error && error.message)
      console.warn('dsh-plugin-bootanim: 设置卡注册失败', error)
    }
  }

  const unmount = () => {
    const dispose = live
    live = null
    if (typeof dispose !== 'function') return
    try {
      dispose()
    } catch (error) {
      console.warn('dsh-plugin-bootanim: 设置卡注销失败', error)
    }
  }

  try {
    ctx.effect(
      () => forms.whileServed([NAMESPACE], () => {
        report('served', NAMESPACE)
        mount()
        return unmount
      }),
      'dsh-plugin-bootanim: 设置卡',
    )
  } catch (error) {
    report('effect-failed', error && error.message)
    console.warn('dsh-plugin-bootanim: 设置卡接线失败', error)
  }
}

return module.exports; } });
