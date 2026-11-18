**中文** | [English](README.en.md)

# dsh-fleet — 多机 DSH 管理面板

在一个「多机」页面里管理多台机器上的 **DeepSeek Harness（DSH）** 实例：
看每台的会话、状态、`:40005` 看板，跨设备汇总所有会话，还能选设备/文件夹/模型直接启动新会话。

## 兼容性

| 项目 | 要求 |
|---|---|
| DSH | **0.2.2-rc.1**（已在 Linux 与 macOS 多台机器上实测）。使用 `dsh.bundle.patch` + `dsh.client.platform: web` 这套插件机制，0.2.x 系列应可用；**更早的 0.1.x 未测试** |
| Node | ≥ 22（与 DSH 自带 Node 一致即可） |
| 插件位置 | DSH web profile：`~/.dsh/profiles/web/` |
| 浏览器 | 推荐 **Chrome / Edge**。内嵌看板与远端 DSH 走 `http://localhost:<port>` 做跨站进程隔离，重页面不会卡主界面；Safari / Firefox 没有同样的跨站进程隔离，内嵌重看板可能仍然卡（可改用「打开看板」新标签） |
| 上游协议 | 仅 **http**（https 上游暂不支持） |
| 依赖插件 | 「用量」视图需要各机安装 `dsh-context`（上下文洞察）才能显示费用 / 缓存命中 / 上下文窗口；未安装时自动降级为仅 tokens |
| 系统 | Linux / macOS 均可（主机与从机都不限） |

依赖的 DSH 能力（均已在 0.2.2-rc.1 实测）：`ctx.settings`、`ctx.credentials`、`ctx.webServer.register`、`ctx.connection.requestRejection`、插槽 `sidebar.panellist` / `main` / `settings.section`、`uiWorkspace.openSession`、`layout.toggleSidebar`、`session/list`、`session/create`、`session/selectModel`、`session/modelCatalog`。

## 架构

```
浏览器 ── 多机面板（master 的 DSH 页面）
            │  /fleet/* 本地路由
            ├─ loopback 代理（每实例一个 127.0.0.1:<dshPort>）──→ 远端 DSH web :3080
            ├─ loopback 代理（每实例一个 127.0.0.1:<panelPort>）─→ 远端 :40005 看板
            └─ /fleet-agent/*（带 X-Fleet-Key）──────────────→ 各从机 DSH 里的 agent 角色
```

- **master**：跑面板、代理、聚合。浏览器只和 master 的本机端口打交道。
- **agent**：装在每台被管理机器的 DSH 里，暴露 `ping / info / sessions / panel/status` 四个只读接口，用共享 `agentKey` 鉴权。
- 远端 DSH 的 launch token 只在从机日志里轮换；cookie 由 master 存在 `ctx.credentials`（`dsh-fleet/<instanceId>`），**不下发给浏览器**。配了 SSH 时 master 会自动从从机日志刷新 token。

## 安装

### 1. master（你日常用的那台）

```bash
# 方式 A：plugin_manager 安装本目录
plugin_manager → install_bundle  → 选择本目录

# 方式 B：手动放进 profile
cp -R dsh-fleet ~/.dsh/profiles/web/plugins/dsh-fleet
```

在 `~/.dsh/profiles/web/cordis.patch.yml` 里插入（或点插件管理器自动写入）：

```yaml
- insert:
    - id: dsh-fleet
      name: ./plugins/dsh-fleet/index.js
      config:
        role: master
        roles: [master]
        instances: []
```

重启该 DSH web（本机是源码 checkout 时需重建 + 重启），页面出现「多机」入口。

### 2. agent（每台被管理机器）

```bash
# 1) 拷贝插件目录
scp -r dsh-fleet <host>:~/.dsh/profiles/web/plugins/
# 2) npm 安装的 DSH 需要把内置 schema 库软链进 profile
ssh <host> 'mkdir -p ~/.dsh/profiles/web/node_modules/@deepseek-ai && \
  ln -sfn $(dirname $(readlink -f $(command -v dsh)))/node_modules/@deepseek-ai/schemastery \
         ~/.dsh/profiles/web/node_modules/@deepseek-ai/schemastery'
# 3) profile patch 末尾追加（0600 权限）
ssh <host> 'cat >> ~/.dsh/profiles/web/cordis.patch.yml <<PATCH

- insert:
    - id: dsh-fleet
      name: ./plugins/dsh-fleet/index.js
      config:
        role: agent
        roles: [agent]
        agentKey: "<与 master 相同的共享密钥>"
        panelLocalUrl: http://127.0.0.1:40005
PATCH'
# 4) 重启该从机的 DSH web
```

agent 只读取会话摘要与看板状态，不代理、不开额外端口。

## 配置

所有配置都在 `dsh-fleet` 这个 profile 条目里，也可以直接打开 **Settings → Fleet** 编辑。

| 字段 | 说明 |
|---|---|
| `roles` | `[master]` / `[agent]` / 两者都要就 `[master, agent]`（本机自己也算一台实例时需要） |
| `role` | 兼容旧字段；只写 `agent` 时表示纯从机 |
| `agentKey` | 主机与从机之间的共享密钥（建议 32 位随机串，两边一致） |
| `instances[]` | 实例列表：`id`、`name`、`dshUrl`、`panelUrl`、`ssh`、`tokenLogPath`、`dshPort`、`panelPort`、`agentUrl`、`enabled` |
| `portBase` | 代理端口起点（默认 37801；每实例占两个：DSH 与看板） |
| `pollMs` | 健康轮询间隔（默认 5000，面板关闭时自动静默） |
| `panelLocalUrl` | 从机上 :40005 的本地地址（agent 读看板用） |

实例字段说明：

- `dshUrl`：远端 DSH web 地址（如 `http://192.0.2.10:3080`）
- `panelUrl`：远端 `:40005` 看板地址（可为空 = 该机没有看板）
- `ssh`：`user@host`，配了才能自动从日志抓 token / 续期 cookie（可选，也可在界面里手动「重新授权」粘贴 token）
- `tokenLogPath`：从机 DSH 启动日志路径（token 从里面最后一条 `?token=` 提取；默认 `~/.dsh/dsh-web.log`）
- `dshPort` / `panelPort`：master 本机代理端口，留空自动从 `portBase` 分配
- `enabled`：临时停用该实例

## 使用

1. **打开面板**：左侧栏「多机」。
2. **实例栏**：顶部「全部会话」伪实例 + 每台设备一行（在线状态、会话数、运行中、延迟、看板状态；`无看板` 表示没配 `panelUrl`）。
3. **右侧三个视图**：
   - **总览**：每台机器的 CPU / 内存 / 负载 / 磁盘 / GPU 卡片（来自 `:40005`），点「打开 DSH」新标签进入该机真实界面。
   - **看板**：当前实例的 `:40005` 页面内嵌显示，可全屏；右上「打开看板」直接开新标签。
   - **全部会话**（下方会话区）：跨设备所有会话，**运行中在前**，行首设备名标签；支持搜索、「只看运行中」、「含子会话」（子 agent 默认隐藏，打开后带 `子` 徽标并显示任务名）。**点任意一行**就在面板内打开该会话（切换会话不重载 iframe，秒切）。
4. **用量**：顶部「用量」页签 → 选 今日 / 7 天 / 30 天，看总 tokens、费用、缓存命中、会话数；下面是每台设备卡片（含 14 天趋势）、**上下文压力**（运行中会话的窗口占用条 + 一键新会话）、按模型分布、会话消耗 TOP 50（点行打开会话）。没装 `dsh-context` 的机器会标「仅 tokens」。
   - **预算**：设置 → 多机管理里可填全局每日预算（USD）与告警阈值；单台也可单独设预算。用量页会显示预算 pill 和超额/预警横幅。
5. **启动会话**：左栏底部「启动会话」→ 选 **设备 / 文件夹（可留空用默认，带历史目录建议）/ 模型** → 启动后会切到该设备并自动打开新会话。
6. **添加实例**：左栏底部「添加实例」→ 填名称、DSH 地址、看板地址、SSH、端口等；保存后自动建代理并尝试授权。
7. **失败处理**：实例显示「未授权」时，点右上「重新授权」粘贴该机的 DSH launch token（从 `~/.dsh/dsh-web.log` 里的 `http://host:3080/?token=...` 抄）。
8. **性能相关**：页面隐藏时轮询暂停；打开面板前已后台预热；看板/查看器隐藏 60 秒后自动销毁 iframe。

## 安全说明

- 远端 cookie 只存在 master 的 `~/.dsh/.credentials.yaml`（`dsh-fleet/<id>`），不写浏览器、不进日志。
- 每个代理带一次性 key（`?k=` → HttpOnly cookie），无 key 直接 401，且只监听 `127.0.0.1`。
- agent 接口全部要求 `X-Fleet-Key`（`ping` 除外，只回 200），只读，不支持写操作。
- SSH 仅用于 `grep` 从机日志里的 token 并重启/续期；不传输业务数据。

## 常见问题

| 现象 | 处理 |
|---|---|
| 看板空白 / 一直转圈 | 浏览器把第三方 cookie 全禁时会出现；点右上「打开看板」用新标签，或在浏览器里允许 `localhost` 站点 cookie |
| 点看板整页很卡 | 只有 Chrome/Edge 有跨站进程隔离；Safari/Firefox 请用「打开看板」新标签 |
| 实例显示未授权 | token 随从机重启轮换：配好 `ssh` 自动续期，否则手动「重新授权」粘贴新 token |
| agent 接口 401 | 两端 `agentKey` 不一致，或从机没重启加载 agent 角色 |
| 从机启动报 `@deepseek-ai/schemastery` 找不到 | 按「安装 → agent」第 2 步做软链 |
| 从机 3080 连不上 | 该机 DSH web 没起或在别的端口；`dsh web` 默认不监听 0.0.0.0，需要 `--host 0.0.0.0` |
| 会话数很大时列表慢 | 已做服务端 30s 全量缓存 + 10s 查询缓存、客户端后台预热；仍慢可调大 `pollMs` |

## 变更记录

见 [CHANGELOG.md](CHANGELOG.md)。

## License

MIT
