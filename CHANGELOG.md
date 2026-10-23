# Changelog

## 2.0.2

- README 新增「支持开发」：爱发电入口与支付宝/微信收款码，与 renpy-translator 保持一致。

## 2.0.1

- README 顶部接入 whale-star README 应援图服务（按 Star 数自动升档），并同步到 npm 包页面。

## 2.0.0

- 新增「点击通知跳回对应会话」：Toast 通过 `dshfocus://` 协议启动 `launcher.ps1`，Host 记录待跳转请求，Client 半边轮询后调用 `uiWorkspace.openSession()`。
- 新增 Client 半边（`client.js`，`dsh.client` 双面插件）。
- 新增失败可见性：`toast.ps1` 只在 `Show()` 成功后输出 `toast shown`；失败写日志并告警。
- 新增诊断：`%TEMP%\dsh-windows-notify\notify.log` / `launcher.log`、启动通道自检、`/health` 路由。
- 子代理过滤改用 `origin`/`delegationDepth`（fork 出来的顶层会话仍会通知）。
- 包名调整为 `@yschdxm/dsh-windows-notify`。
