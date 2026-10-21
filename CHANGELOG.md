# Changelog

## 2.0.0

- 新增「点击通知跳回对应会话」：Toast 通过 `dshfocus://` 协议启动 `launcher.ps1`，Host 记录待跳转请求，Client 半边轮询后调用 `uiWorkspace.openSession()`。
- 新增 Client 半边（`client.js`，`dsh.client` 双面插件）。
- 新增失败可见性：`toast.ps1` 只在 `Show()` 成功后输出 `toast shown`；失败写日志并告警。
- 新增诊断：`%TEMP%\dsh-windows-notify\notify.log` / `launcher.log`、启动通道自检、`/health` 路由。
- 子代理过滤改用 `origin`/`delegationDepth`（fork 出来的顶层会话仍会通知）。
- 包名调整为 `@yschdxm/dsh-windows-notify`。
