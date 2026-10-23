<div align="center">

# dsh-windows-notify

[![npm version](https://img.shields.io/npm/v/@yschdxm/dsh-windows-notify.svg?style=flat-square)](https://www.npmjs.com/package/@yschdxm/dsh-windows-notify)
[![npm downloads](https://img.shields.io/npm/dm/@yschdxm/dsh-windows-notify.svg?style=flat-square)](https://www.npmjs.com/package/@yschdxm/dsh-windows-notify)
[![爱发电](https://img.shields.io/badge/%E7%88%B1%E5%8F%91%E7%94%B5-%E8%AF%B7%E6%88%91%E5%96%9D%E6%9D%AF%E5%A5%B6%E8%8C%B6-7e5fd9?logo=afdian&logoColor=white)](https://ifdian.net/a/yschdxm)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-4f8cff?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

<a href="https://whale-star.whale-star.workers.dev/">
  <img src="https://whale-star.whale-star.workers.dev/?repo=yschdxm/dsh-windows-notify" alt="给个 Star 吧～" width="720">
</a>

> 🐳 顶部应援图来自 **[whale-star](https://github.com/yschdxm/whale-star)**——
> 按 GitHub Star 数自动升档的大肥鱼 README 应援图服务。

</div>

**Windows 原生通知插件 + 点击跳回对应会话。** 会话任务结束、需要你确认/回答、需要重新登录、会话出错时发一条 Windows Toast；**点击通知会聚焦 DeepSeek Harness（桌面版或浏览器标签页）并直接跳到那条会话**。

## 为什么点击能定位会话

市面上不少通知插件点击后只能打开应用，或者只能把浏览器指到一个不生效的 URL。桌面版 DSH 的 `dsh://` 深链只负责聚焦窗口，本身不接受会话参数；本插件因此自己做了一条“点击 → 跳转”的闭环：

```text
Toast 点击
  └─ Windows 协议 dshfocus://focus?u=<focus-url>
       ├─ launcher.ps1  GET  <-  host /plugins/dsh-windows-notify/focus?session=<id>&t=<token>
       │                       （记录待跳转请求，5 分钟内有效）
       └─ Start-Process 'dsh://open'  → 聚焦/唤起桌面 App
                                              │
  client.js（页面内）轮询 /pending ◄──────────┘
       └─ ctx.get('uiWorkspace').openSession(sessionId)   ← 真正切到那条会话
```

- 桌面 App 已打开：点击 → 聚焦窗口 + 切换会话。
- App 最小化/隐藏在托盘：`dsh://open` 会恢复并聚焦窗口，随后切换会话。
- App 未运行：点击会启动 App；待跳转请求保留 5 分钟，页面加载后自动跳转。
- 纯浏览器打开 Web GUI 时同样生效（client half 走相对路径 `/plugins/...`）。

## 功能

- **Windows 原生 Toast**：Windows PowerShell 5.1 + WinRT，无 npm 依赖、无第三方二进制。
- **覆盖这些事件**：会话任务完成 / 出错 / 输出上限 / 你主动停止 / 被打断 / 被阻断；审批等待；结构化提问（含计划确认）；账号需要登录、登录过期；会话级错误。
- **通知身份**：借真实应用 AUMID（`com.deepseek.dsh`）显示“DeepSeek Harness”和应用图标；AUMID 不可用时自动回退到 PowerShell 的 AUMID。
- **目标续跑静默**：goal 自动续跑期间不打扰，只在目标完成/受阻时提醒。
- **子代理静音**：按 `origin === 'subagent'` / `delegationDepth > 0` 过滤；fork 出来的顶层会话照常通知。
- **去重**：同会话同原因 2 秒内只弹一次。
- **失败可见**：Toast 进程只有真正 `Show()` 成功才输出 `toast shown`；失败写 `%TEMP%\dsh-windows-notify\notify.log` 并在控制台告警。启动时自检通道（toast.ps1 / launcher.ps1 / powershell.exe），可用 `/health` 查看状态。
- 可选静音、可选关闭点击跳转、可调正文长度。

## 安装

插件是标准的 DSH bundle（`dsh.bundle.patch`），包内同时有 Host 半边和 Client 半边（`dsh.client`）。

```powershell
# 方式零（推荐）：从 npm 官方源安装
dsh plugin --profile <profile> add @yschdxm/dsh-windows-notify

# 方式一：Plugin Manager（GUI）→ 安装 bundle → 选择仓库目录
# 方式二：命令行从 GitHub 安装
dsh plugin --profile <profile> add github:yschdxm/dsh-windows-notify

# 本地开发（link 安装）
git clone https://github.com/yschdxm/dsh-windows-notify.git
dsh plugin --profile <profile> add link:F:/dev/dsh-windows-notify
```

安装后建议重启一次 Harness（桌面版：`重启应用与 Host`，或退出后重新打开），Client 半边会在页面下次加载时生效。

## 配置

在 profile 的 `cordis.patch.yml`（或任意后置补丁层）里按 row id 覆盖；不写就用默认值：

```yaml
- id: dsh-windows-notify
  config:
    appId: com.deepseek.dsh   # Toast 归属的 AppUserModelID
    silent: false             # true = 静音
    notifyTurnEnd: true
    notifySubagentTurns: false
    notifyErrors: true
    notifyApproval: true
    notifyQuestions: true
    notifySignIn: true
    openOnClick: true         # false = 关闭点击跳转（只弹普通通知）
    protocol: dshfocus        # 点击使用的自定义协议
    maxBodyChars: 260
    log: true                 # 写 %TEMP%\dsh-windows-notify\notify.log
    debug: false              # 记录每条会话事件与通知成功日志
```

## 诊断与排障

| 文件/入口 | 用途 |
|---|---|
| `%TEMP%\dsh-windows-notify\notify.log` | 启动自检、通道状态、通知失败、focus 请求/消费记录（JSON 行） |
| `%TEMP%\dsh-windows-notify\launcher.log` | 点击后的协议解析、host 请求、聚焦方式（`app`/`browser`） |
| `GET http://127.0.0.1:<port>/plugins/dsh-windows-notify/health` | 通道状态、端口、待跳转数量（仅 loopback） |

常见问题：

1. **没有弹窗**：Windows 设置 → 系统 → 通知，确认 “DeepSeek Harness” 允许通知且未开专注助手；再看 `notify.log` 里的 `toast-failed`。
2. **点击没反应**：检查 `HKCU\Software\Classes\dshfocus` 是否指向本插件的 `launcher.ps1`；看 `launcher.log`。
3. **点击只聚焦窗口、没切会话**：确认 Client 半边已加载（重启一次 Harness），并检查 `notify.log` 是否有 `focus-consumed`。
4. **通知显示成 Windows PowerShell**：说明回退分支被触发，检查 `com.deepseek.dsh` 的应用快捷方式是否存在。

## 卸载

1. `plugin_manager` 里移除本 bundle。
2. 清理插件自动写入的通知归属与协议注册（HKCU，无需管理员）：

```powershell
Remove-Item 'HKCU:\Software\Classes\dshfocus' -Recurse -Force
```

## 兼容性

- 测试环境：DeepSeek Harness Desktop `0.2.1-rc.2`，Windows 11 26100，Node 24。
- 依赖：Windows 10/11 自带的 Windows PowerShell 5.1；Node >= 20。
- 不使用 `detached` 子进程：`DETACHED_PROCESS` 会让 PowerShell 5.1 的 WinRT `Show()` 变成静默空操作（实测）。

## 开发

```powershell
node --check index.js
node --check format.js
node --check client.js
node test/smoke.mjs     # 假 ctx + 假 webServer，打 3 条真实 Toast，验证路由/监听器/文案
```

## 💝 支持开发

本插件完全免费、开源。如果它帮你省下了守任务的时间，欢迎通过下面任意一种方式请作者喝杯咖啡——你的每一份支持都会化作后续的功能更新与问题修复：

<div align="center">

<a href="https://ifdian.net/a/yschdxm"><img width="200" src="https://pic1.afdiancdn.com/static/img/welcome/button-sponsorme.png" alt="在爱发电支持我"></a>

| 支付宝 | 微信支付 |
|:---:|:---:|
| <img src="https://raw.githubusercontent.com/yschdxm/dsh-windows-notify/main/.github/assets/alipay.png" alt="支付宝收款码" height="340"> | <img src="https://raw.githubusercontent.com/yschdxm/dsh-windows-notify/main/.github/assets/wechat-pay.png" alt="微信支付收款码" height="340"> |

*不方便扫码？也欢迎在 [爱发电](https://ifdian.net/a/yschdxm) 上支持，那里可以留下你想看的功能需求。*

</div>

## 图标许可

`icon.svg` 中的铃铛图形来自 [Material Icons](https://github.com/google/material-design-icons) 的 `notifications` 图标，Apache License 2.0。

## License

[MIT](./LICENSE)
