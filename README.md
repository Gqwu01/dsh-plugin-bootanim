# dsh-plugin-bootanim

给 [DeepSeek Harness](https://github.com/deepseek-ai) 的 Web GUI / 桌面客户端加一段**开机动画**：

- 打开 DSH 时播放你选的那一条视频
- **刷新页面不会重播**（同一次会话只播一次）
- 在「设置 → 插件」里直接换片、上传自己的视频、删除
- 不改 DSH 源码，纯官方钩子

## 安装

要求 DSH `>= 0.2.0-rc.2`（桌面版和 Web 版的插件系统都在这个范围内）。

1. 打开侧边栏 **插件** → **添加插件**
2. 填入 Git 地址：

   ```
   git+https://github.com/Gqwu01/dsh-plugin-bootanim.git
   ```

   想固定版本就在末尾加 tag：

   ```
   git+https://github.com/Gqwu01/dsh-plugin-bootanim.git#v0.1.0
   ```

3. 安装完成后**打开开关启用**
4. **完全退出并重启**客户端（插件树是启动时读的，刷新页面不算）

依赖会一并安装好，不需要额外操作。首次安装需要能访问 GitHub，克隆整仓所以比装 npm 包略慢。

也可以从本地安装：

```sh
# tarball（npm pack 产物，推荐，依赖会正确安装）
C:\path\to\dsh-plugin-bootanim-0.1.0.tgz
# 目录（会软链进去，不安装依赖；需先在该目录跑过一次 pnpm install）
C:\path\to\dsh-plugin-bootanim
```

## 用法

重启后打开侧边栏的 **插件** 页，点进本插件，配置区就在描述下方：

| 控件 | 说明 |
|---|---|
| 启用开机动画 | 总开关。关掉则不注入任何东西，回到内核自己的启动页 |
| 播放的视频 | 下拉选择。`自动` 表示用最近改动过的一条素材 |
| 上传… | 导入本地 mp4 / webm / m4v / mov，上限 256MB |
| 删除 | 只能删你自己上传的，内置素材不可删 |
| 同一个标签页只播一次 | 默认开。关掉则每次刷新都播 |
| 必须点击才进入 | 默认关。开启后片子放完也停在最后一帧，等你点 |

播放中可以随时 **点击 / Esc / 空格 / 回车** 立即进入。

## 素材放哪

- 内置素材：本包的 `assets/videos/`
- 你上传的素材：`<DSH profile>/data/dsh-plugin-bootanim/videos/`

**升级插件不会覆盖你上传的视频**——它们在 profile 数据目录里，不在 `node_modules` 里。

## 设置项（`cordis.patch.yml` 里也可手写）

```yaml
- id: bootanim
  config:
    enabled: true
    clip: 'custom/xxxx_my-intro.mp4'
    fadeMs: 800
    playOnce: true
    clickToEnter: false
```

所有字段都是 `volatile`：改完立即生效，不需要重启。

## 它是怎么工作的

1. 宿主半区注册三条路由：素材清单、素材本体（支持 HTTP Range）、上传。
2. 每次渲染 `index.html` 时，把「选中素材的 URL + 配置」写成一段全局变量，并把
   `src/boot-screen.js` 的原文内联进 `<head>`。脚本在 React 挂载之前执行。
3. 脚本自己建一层全屏遮罩并播放视频；浏览器半区在内核就绪时调
   `globalThis.__DBV__.clientReady()`。
4. **放行条件是「片子放完」且「内核就绪」**，避免露出半成品界面；
   另有 12 秒硬兜底，任何异常都会立即放行。

## 安全边界

- 不读取会话内容、不接触模型数据
- 没有任何对外网络请求
- 上传 / 删除只接受**本机回环地址**发起
- 素材路径做单层 + 扩展名 + 目录包含三重校验

## 开发

```sh
# 直接链接进 profile 调试，不用发包
cd <你的 profile 目录>
pnpm add link:<本仓库路径>
```

- 改 `src/boot-screen.js`：刷新页面即可生效（每次 index 渲染重读）
- 改 `entry.js` / `lib/client.js`：需要重启宿主

## 许可

MIT
