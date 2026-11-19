# 标准测试环境记录

> 2026-11-19 · 在 dsh-fleet v0.5.x 上落地并验证
> 文中地址均为占位符；真实主机信息不进入公开仓库。

## 目标

把「master + agent + CubeSandbox」固定为 dsh-fleet 的标准测试拓扑：

- 一台 master DSH（面板 + fleet API）
- 至少一台真实 agent 主机（覆盖真实主机路径）
- N 台 CubeSandbox MicroVM，每台内跑一个 DSH，覆盖「短生命周期、隔离实例」路径

## 落地步骤

1. **准备模板**：CubeSandbox 已有 20G 可写层模板（默认 1G 装不下 DSH，全局安装约 919MB）。
2. **烘焙模板**：
   - 从基础模板起一个 sandbox；
   - 通过 E2B `files.write` 上传 Node 24 的 `.tar.xz`（CubeEgress 下载大文件很慢）；
   - `python3 -c "import tarfile; ..."` 解压，`npm i -g --registry https://registry.npmmirror.com @deepseek-ai/dsh@0.2.2-rc.1`；
   - `cubemastercli template commit --sandbox-id <id> --json`；
   - 等到模板 READY，把新 `template_id` 写入 `test-env/config.json`。
3. **启动实例**：`node test-env/up.mjs` 从烘焙模板克隆 N 台 sandbox；脚本检测到 DSH 已存在就只启动 DSH。
4. **注册**：`up.mjs` 自动读 master 日志里的 token，换 cookie 后 `PUT /fleet/config` 并逐台 `POST /fleet/authorize`。
5. **验收**：`node test-env/smoke.mjs`，逐项检查 status / sessions / usage / assistant。

## 已验证结果

- 3 台 CubeSandbox DSH 实例同时在线、已授权；
- `session/list` 正常，可在其中一台 launch 新会话；
- fleet 面板实例栏出现全部 Cube 沙箱，总览卡片正常；
- 冷启动（克隆模板 + 启动 DSH + 反代 + 注册）在一分钟内完成。

## 踩坑记录

1. **模板 commit 会快照运行中的 DSH 进程**：克隆出来的 VM 里已有 DSH 在跑，但 `--trusted-host` 仍是旧 sandbox id，必须按新 id 重启，否则 CubeProxy 403 / 端口占用。
2. **DSH 不能绑 `0.0.0.0`**：必须绑定 sandbox 内网 IP，并加 `--trusted-host 3080-<sandbox-id>.cube.app`。
3. **反代端口冲突**：宿主上的旧反代进程会占住 1318x，直接起新代理会 `EADDRINUSE`；启动前先清理监听。
4. **CubeEgress 截断**：Node tar.gz（57MB）会被 32MB 级截断，导致 tar 报 `Unexpected EOF`；改用 `.tar.xz`（31.4MB）并本地解压。
5. **TTL**：sandbox 是租约制，到期 DSH 随之消失；用 `node test-env/renew.mjs` 续租，或重建。


## 调试记录与产物（2026-11-19）

本轮调试的关键现场（均已脱敏，真实地址/令牌不进入仓库）：

1. 在宿主机下载 Node `.tar.xz` 后，用 E2B `files.write(..., gzip=True)` 送进 sandbox，避免 CubeEgress 的慢速与截断。
2. `npm i -g --registry https://registry.npmmirror.com @deepseek-ai/dsh@0.2.2-rc.1`，装完 `/opt/node-v24.16.0-linux-x64/bin/dsh` 可用。
3. `cubemastercli template commit --sandbox-id <id> --json` 后，新模板 READY；克隆实例里 DSH 进程被快照带出，需要按新 `sandbox-id` 重启并重取 token。
4. 宿主反代最初用手工 `node` 进程，端口被旧进程占用导致 `EADDRINUSE`；最终收敛为 systemd user unit `cube-http-proxy.service`。
5. 实例通过 `PUT /fleet/config` + `POST /fleet/authorize` 注册，`/fleet/sessions` 与 `/fleet/launch` 均成功返回。

长期产物：

- 公开：本文件 + `test-env/README.md` + `test-env/*.mjs`/`*.py` + CHANGELOG v0.5.2。
- 环境相关：`test-env/config.json`、`test-env/.manifest.json` 为本地文件，已 gitignore，不进入仓库。

## 相关文件

- `test-env/up.mjs` — 创建 + 注册 + 授权
- `test-env/smoke.mjs` — HTTP 验收
- `test-env/down.mjs` — 注销 + 销毁
- `test-env/renew.mjs` — 续租
- `test-env/sandbox-up.py` / `sandbox-down.py` — 宿主机侧 E2B 操作
