# Changelog

## v0.1.4 — 2026-11-18

- 文档：README 拆成中英文两份，以中文为主（`README.md`），英文版 `README.en.md`。

## v0.1.2 — 2026-11-18

- **子 agent 会话默认隐藏**：`/fleet/sessions`、`/fleet/aggregate` 新增 `children=1`，客户端新增「含子会话」开关（localStorage 持久化）。子会话行带 `子` 徽标并显示 subagent 任务名，不再出现重复标题。

## v0.1.1 — 2026-11-18

- **修掉「点看板卡住」**：内嵌看板与远端 DSH 查看器改用 `http://localhost:<port>`（与主页面不同 site ⇒ Chrome 独立进程隔离），代理 key cookie 在该源上改为 `SameSite=None; Secure`；看板 iframe 增加加载遮罩。
- 实测（Chrome）：看板打开 10 秒内主页面长任务从 16~24 个（阻塞 4~6 秒）降到 0。

## v0.1.0 — 2026-11-18

- 首个公开版本：多实例实例栏、每实例 loopback 代理（DSH + :40005 看板）、总览卡片、跨设备「全部会话」、启动会话（设备/文件夹/模型）、后台预热与 SWR、主从角色（`/fleet-agent/*`）。
