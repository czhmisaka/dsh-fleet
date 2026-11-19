# 标准测试环境：master + agent + CubeSandbox

一套可重复的本地多机测试拓扑，用来验收 dsh-fleet 的实例发现、授权、会话、用量与助手。

```
Mac（master DSH :36900）
  ├── 4090 宿主机（agent DSH :3080）        ← 已有的真实从机
  └── CubeSandbox × N（MicroVM 内 DSH）      ← 本目录负责创建/销毁
        └── 3080-<sandbox-id>.cube.app  → 4090 上的 HTTP 反代 → fleet 实例
```

## 前置条件

| 项 | 要求 |
|---|---|
| master | 本机 DSH Web 可访问，`~/.dsh/dsh-web.log` 能读到最新 `?token=` |
| agent | 一台已接入 fleet 的真实 DSH（如 4090），用来覆盖「真实主机」路径 |
| CubeSandbox | 4090 上已装 CubeSandbox（`cubemastercli` / `:3000`），有一个 ≥20G 可写层的模板且暴露 3080 |
| 网络 | master 能 SSH 到 CubeSandbox 宿主机，并能访问其反代端口 |
| 工具 | master 上 `node >= 22`、`ssh`、`scp`、`tar` |

模板需带 Node 与 DSH 安装能力；本仓库的 `sandbox-up.py` 会在每个 MicroVM 内装 Node 24 + DSH 0.2.2-rc.1
（npm 走 `registry.npmmirror.com`，CubeEgress 到 nodejs.org 极慢）。

## 用法

```bash
cp test-env/config.example.json test-env/config.json
# 填 sandboxHost / templateId / masterUrl / publicHost 等

node test-env/up.mjs          # 建/复用 N 个 sandbox + 装 DSH + 装 dsh-fleet 插件 + 起反代 + 注册并授权
node test-env/up-selftest.mjs # 只跑 fleet-config 合并逻辑的自测（不碰 master）
node test-env/renew.mjs       # 只续租（不重建沙箱、不重装 Node/DSH、不动 master 配置）
node test-env/smoke.mjs       # 验收：status / sessions / usage / assistant
node test-env/down.mjs        # 注销实例 + 销毁 sandbox + 停反代
```

成功时 `up.mjs` 会写 `test-env/.manifest.json`（已 gitignore），`smoke.mjs` 输出逐项 ✓。

## 沙箱里的 dsh-fleet 插件（必须，否则面板永远显示「远端实例启动中…」）

沙箱内 DSH 必须以 **agent** 角色跑，master 才能通过 `/fleet-agent/*` 读到它。
`sandbox-up.py` 在 `dsh web` 启动**之前**做这些事：

| 位置 | 内容 |
|---|---|
| `~/.dsh/profiles/web/plugins/dsh-fleet/` | 插件源码（master 上 `~/.dsh/profiles/web/plugins/dsh-fleet` 打包 scp 过来） |
| `~/.dsh/profiles/web/plugins/dsh-fleet/cordis.patch.yml` | **改写成 agent 角色**（插件自带的是 `role: master`）：`- insert: [- id: dsh-fleet / config: {role: agent, roles: [agent], agentKey}]` |
| `~/.dsh/profiles/web/cordis.patch.yml` | loader 条目 `- id: dsh-fleet / name: dsh-fleet / config: {role: agent, roles: [agent], agentKey}` |
| `~/.dsh/profiles/web/package.json` | `dsh.profile.bundles` 追加 `dsh-fleet`；**`dsh.profile.patchReload: "live"`（关键！）**；`dependencies["dsh-fleet"] = "link:./plugins/dsh-fleet"` |
| `~/.dsh/profiles/web/node_modules/dsh-fleet` | → `../plugins/dsh-fleet` 的软链（Loader 靠它解析 bundle） |

### 三个实测踩过的坑（都会让 `/fleet-agent/*` 变成 404）

1. **`patchReload: "live"` 不能少**。少了它，loader 组成的树里有 `role: agent`
   （`dsh --profile web --dump-config` 能看到），但**运行中的 entry 拿不到这个 config**：
   插件的 `readSettings()` 读不到值 ⇒ `agentEnabled()` 为 false ⇒ 路由不注册。
   master 的 `~/.dsh/profiles/web/package.json` 里本来就有这个键，沙箱里必须补上。
2. **profile patch 模板结尾有一行字面量 `[]`**。在它后面追加 loader 行会得到
   `YAMLException: end of the stream or a document separator is expected (5:1)` ⇒
   `dsh web` 启动即崩 ⇒ 沙箱里根本没有 DSH。生成时要**先删掉那行 `[]`**。
3. **`--trusted-host` 要带 `3080-` 前缀**：`3080-<sid>.cube.app`，不是 `<sid>.cube.app`。

> ⚠️ 沙箱 `/tmp/dsh.log` 里那行 `[dsh-fleet] start: role=undefined roles=null instances=none`
> **不代表配置没生效**——master 上同样是这行。插件启动那一刻拿到的可能还是 Config Schema，
> 配置在之后的 `configTick()` 才补上。**判据要看运行时行为**：`/fleet-agent/ping` 返回 200 才算数。

验收：沙箱自己的页面里 `__DSH_BOOT__.entries` 含 `{"id":"dsh-fleet",...}`，
且 `curl -H 'x-fleet-key: <key>' http://<publicHost>:<port>/fleet-agent/ping` 返回
`{"ok":true,"service":"dsh-fleet","role":"agent"}`。

## master 侧 fleet 条目

`up.mjs` 只改 `instancePrefix`（默认 `cube-`）开头的条目，其余实例（mac/spark2/s169/x99…）
**逐字段原样回写**，不会把 master 自己的 `ssh` / `agentUrl` / `tokenLogPath` / `dshPort` 改坏。

cube 条目固定 11 个字段：

```js
{
  id: 'cube-1',
  name: 'Cube 沙箱 1',
  dshUrl: 'http://192.0.2.10:13181',        // 宿主映射端口
  panelUrl: '',
  ssh: '',                                     // 沙箱里没有 sshd，必须空
  tokenLogPath: '<master>/.dsh/fleet-assistant/tokens/cube-1.log',
  dshPort: 37808,                              // master 侧 fleet 代理端口
  panelPort: 0,
  agentUrl: 'http://192.0.2.10:13181/fleet-agent',  // ← 用宿主映射端口，不是 3080
  enabled: true,
  budgetDailyUsd: 0,
}
```

* `agentUrl` 必须有值：插件的 `agentCall()` 拼的是 `${agentUrl}/ping`，空值就永远走不到
  沙箱侧的 `/fleet-agent/ping`，面板就一直显示「远端实例启动中…」。
* `ssh` 必须是空串：非空时插件走 `fetchTokenViaSsh()`（沙箱里没有 sshd，必然失败）。
* `tokenLogPath` 指向 **master 本机**的文件（`token=<TOKEN>` 一行，0600）：插件的
  `readLocalToken()` 从后往前找第一行含 `token=([A-Za-z0-9_-]+)` 的行。
  这样沙箱重启 / cookie 过期后插件能自己重新授权。

## 沙箱复用与 TTL

* `sandbox-up.py` 给每个沙箱打 `dsh-fleet-name` metadata；重跑时先列出**还活着的**沙箱，
  同名即复用（`Sandbox.connect(sid, timeout=ttl)` 顺便续租），不再重复建机器。
  ⇒ fleet 条目里的实例 id 不会因为重跑而和沙箱对不上。
* TTL 上限（实测）：CubeSandbox API 的 `timeout` 字段类型是 **i32**，所以上限是
  `2147483647` 秒（≈68 年）；传 `2147483648` 直接 422
  `timeout: invalid value: integer 2147483648, expected i32`。
  平台**按请求值精确续租**，没有更低的钳制：

  | 请求 timeout | 实际 endAt |
  |---|---|
  | 604800（7 天） | +7 天 |
  | 2592000（30 天） | +30 天 |
  | 31536000（1 年） | +1 年 |
  | 2147483647 | +68 年（2094-12-07） |

  默认值取 **2592000（30 天）**：够长，隔夜/周末都不会自然消失，又不需要续期任务。
* **TTL 的语义**：它是**沙箱的租约**（lease）。到 `endAt` 时平台按 `on_timeout`（默认 `kill`）
  回收沙箱，DSH 随之消失。租约**可以随时续**（续租从"现在"起算，不是叠加），
  所以**不需要定期重跑 `up.mjs`** —— 只要在租约到期前续一次即可。
* 手动续期：`node test-env/renew.mjs`（等价于
  `POST /sandboxes/<sid>/timeout {"timeout": <秒>}`，返回 204），
  或 `Sandbox.connect(sid, timeout=<秒>)`。
  续租只动 lease，**不重建沙箱、不重装 Node/DSH、不碰 master 的 `/fleet/config`**。

## 验收清单

| 检查 | 期望 |
|---|---|
| `fleet/status` | 所有 `cube-*` 实例 online + authed |
| `fleet/sessions?instanceId=cube-1` | 200，返回数组 |
| `fleet/usage?range=today` | 200；每个实例有 tokens 或明确降级原因 |
| `fleet/assistant/session` | 返回持久会话 id |
| 面板 UI | 实例栏出现 Cube 沙箱；可拖动分栏；右侧助手可加载 |

UI 验收用真实 Chrome（`channel: 'chrome'`）打开 `http://<master>/?token=...`，不要用 Playwright 自带 Chromium。

## 已知边界

- CubeSandbox MicroVM **无 GPU、无 `dsh-context`、无 :40005 看板**：用量显示「仅 tokens」属预期。
- 沙箱默认 TTL 30 天（`sandboxTtlSeconds` 可调）；到期 DSH 随 VM 消失，需重跑 `up.mjs`。
- 宿主端口 13181/13182 由 systemd user unit `cube-http-proxy.service` 持有；
  `sandbox-up.py` 会改写它的 `targets` 映射并 `systemctl --user restart`，
  而不是另起一个抢端口的代理进程（原文件会先备份成 `cube-http-proxy.js.bak-testenv`）。
  **重启 unit 之前必须先杀掉占着端口的旧代理进程**，否则 unit 绑不上端口，
  旧映射继续服务已经死掉的沙箱 ⇒ 宿主侧 `curl http://<host>:13181/` 会返回 **404 而不是 401**。
- 模板可写层若只有 1G，DSH 全局安装（~919M）会 ENOSPC；必须用 20G 模板。
- 沙箱内 DSH 必须绑内网 IP（不能 `0.0.0.0`），并加 `--trusted-host 3080-<id>.cube.app`，否则 CubeProxy 访问会 403。

## 首次烘焙模板（推荐，避免每次冷启动装 Node/DSH）

CubeEgress 到 nodejs.org 很慢，冷启动装 DSH 可能 10 分钟以上；推荐把装好 DSH 的 sandbox 一次性 commit 成模板，之后 `up.mjs` 只创建 VM 和启动 DSH（秒级）。

1. 用 `config.json` 的 `templateId` 起一个 sandbox，并按 `sandbox-up.py` 的安装命令装好 Node 24 + DSH；
2. 提交为模板：
   ```bash
   cubemastercli template commit --sandbox-id <sandbox-id> --json
   ```
3. 拿到新 `template_id` 后写回 `config.json` 的 `templateId`；
4. 再跑 `node test-env/up.mjs`。`sandbox-up.py` 检测到 `/opt/node-v24.16.0-linux-x64/bin/dsh` 已存在时会跳过安装，只启动 DSH 和反代。
