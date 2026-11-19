# 标准测试环境：master + agent + CubeSandbox

一套可重复的本地多机测试拓扑，用来验收 dsh-fleet 的实例发现、授权、会话、用量与助手。

```
Mac（master DSH :3080）
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
| 工具 | master 上 `node >= 22`、`ssh`、`scp` |

模板需带 Node 与 DSH 安装能力；本仓库的 `sandbox-up.py` 会在每个 MicroVM 内装 Node 24 + DSH 0.2.2-rc.1。

## 用法

```bash
cp test-env/config.example.json test-env/config.json
# 填 sandboxHost / templateId / masterUrl / publicHost 等

node test-env/up.mjs        # 建 N 个 sandbox + 装 DSH + 起反代 + 注册并授权
node test-env/smoke.mjs     # 验收：status / sessions / usage / assistant
node test-env/down.mjs      # 注销实例 + 销毁 sandbox + 停反代
```

成功时 `up.mjs` 会写 `test-env/.manifest.json`（已 gitignore），`smoke.mjs` 输出逐项 ✓。

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
- 沙箱默认 TTL 2 小时（`sandboxTtlSeconds` 可调）；到期 DSH 随 VM 消失，需重跑 `up.mjs`。
- 反代是宿主机上的临时 Node 进程（PID 写入 `/tmp/dsh-fleet-testenv-proxy.pid`），`down.mjs` 会清理。
- 模板可写层若只有 1G，DSH 全局安装（~919M）会 ENOSPC；必须用 20G 模板。
- 沙箱内 DSH 必须绑内网 IP（不能 `0.0.0.0`），并加 `--trusted-host 3080-<id>.cube.app`，否则 CubeProxy 访问会 403。

## 首次烘焙模板（推荐，避免每次冷启动装 Node/DSH）

CubeEgress 到 nodejs.org 很慢，冷启动装 DSH 可能 10 分钟以上；推荐把装好 DSH 的 sandbox 一次性 commit 成模板，之后 `up.mjs` 只创建 VM 和启动 DSH（秒级）。

1. 用 `config.json` 的 `templateId` 起一个 sandbox，并按 `sandbox-up.py` 的安装命令装好 Node 24 + DSH；
2. 提交为模板：
   ```bash
   cubemastercli template commit --sandbox-id <sandbox-id> --json
   ```
   拿到新 `template_id` 后写回 `config.json` 的 `templateId`；
3. 再跑 `node test-env/up.mjs`。`sandbox-up.py` 检测到 `/opt/node-v24.16.0-linux-x64/bin/dsh` 已存在时会跳过安装，只启动 DSH 和反代。
