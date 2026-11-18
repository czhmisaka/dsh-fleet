**English** | [中文](README.md)

# dsh-fleet — multi-host DSH panel

Manage DeepSeek Harness (DSH) instances on several machines from a single **Fleet**
page: sessions, live status and `:40005` dashboards per host, one cross-device
session list, and a launch dialog that picks device / folder / model.

## Compatibility

| Item | Requirement |
|---|---|
| DSH | **0.2.2-rc.1** — tested on several Linux and macOS hosts. Built on the `dsh.bundle.patch` + `dsh.client.platform: web` plugin mechanism, so the 0.2.x line should work; **0.1.x is untested** |
| Node | ≥ 22 (match the Node bundled with DSH) |
| Plugin location | DSH web profile: `~/.dsh/profiles/web/` |
| Browser | **Chrome / Edge** recommended. Embedded dashboards and remote DSH viewers load through `http://localhost:<port>` so the browser gives them a separate site/process and heavy pages cannot freeze the panel; Safari / Firefox lack that isolation — use “Open dashboard” in a new tab there |
| Upstream protocol | **http only** (https upstreams are not supported yet) |
| Optional plugin | The Usage view needs `dsh-context` (Context Insights) on each host for cost / cache-hit / context-window data; without it the view degrades to tokens only |
| OS | Linux / macOS (no restriction on master or agent hosts) |

DSH capabilities used (all verified on 0.2.2-rc.1): `ctx.settings`, `ctx.credentials`,
`ctx.webServer.register`, `ctx.connection.requestRejection`, slots
`sidebar.panellist` / `main` / `settings.section`, `uiWorkspace.openSession`,
`layout.toggleSidebar`, `session/list`, `session/create`, `session/selectModel`,
`session/modelCatalog`.

## Architecture

```
browser ── Fleet panel (on the master's DSH page)
            │  /fleet/* local routes
            ├─ loopback proxy per instance (127.0.0.1:<dshPort>) ──→ remote DSH web :3080
            ├─ loopback proxy per instance (127.0.0.1:<panelPort>) → remote :40005 dashboard
            └─ /fleet-agent/* (X-Fleet-Key) ───────────────────────→ agent role on each slave
```

- **master** runs the panel, proxies and aggregation. The browser only ever talks to loopback ports on the master.
- **agent** is installed in each managed DSH and exposes four read-only endpoints (`ping / info / sessions / panel/status`) guarded by a shared `agentKey`.
- Remote launch tokens rotate on every slave restart; the master stores the exchanged cookie in `ctx.credentials` (`dsh-fleet/<instanceId>`) and never hands it to the browser. With `ssh` configured it refreshes the token from the slave log automatically.

## Install

### 1. master (the machine whose browser you use)

```bash
# Option A: install this directory through plugin_manager
plugin_manager → install_bundle → pick this directory

# Option B: copy into the profile manually
cp -R dsh-fleet ~/.dsh/profiles/web/plugins/dsh-fleet
```

Insert the profile row (or let the plugin manager write it):

```yaml
- insert:
    - id: dsh-fleet
      name: ./plugins/dsh-fleet/index.js
      config:
        role: master
        roles: [master]
        instances: []
```

Restart that DSH web process (a source checkout must be rebuilt first). A **Fleet** entry appears in the sidebar.

### 2. agent (every managed machine)

```bash
# 1) copy the plugin
scp -r dsh-fleet <host>:~/.dsh/profiles/web/plugins/
# 2) npm-installed DSH needs the vendored schema library linked into the profile
ssh <host> 'mkdir -p ~/.dsh/profiles/web/node_modules/@deepseek-ai && \
  ln -sfn $(dirname $(readlink -f $(command -v dsh)))/node_modules/@deepseek-ai/schemastery \
         ~/.dsh/profiles/web/node_modules/@deepseek-ai/schemastery'
# 3) append to the profile patch (mode 0600)
ssh <host> 'cat >> ~/.dsh/profiles/web/cordis.patch.yml <<PATCH

- insert:
    - id: dsh-fleet
      name: ./plugins/dsh-fleet/index.js
      config:
        role: agent
        roles: [agent]
        agentKey: "<same shared key as the master>"
        panelLocalUrl: http://127.0.0.1:40005
PATCH'
# 4) restart that DSH web process
```

The agent only reads session summaries and dashboard state; it opens no proxy ports.

## Configuration

Everything lives on the `dsh-fleet` profile entry and can be edited in **Settings → Fleet**.

| Field | Meaning |
|---|---|
| `roles` | `[master]`, `[agent]`, or `[master, agent]` (needed when the master itself is also managed) |
| `role` | Legacy field; `agent` alone means an agent-only slave |
| `agentKey` | Shared secret between master and agents (use a random 32-char string, identical on both sides) |
| `instances[]` | `id`, `name`, `dshUrl`, `panelUrl`, `ssh`, `tokenLogPath`, `dshPort`, `panelPort`, `agentUrl`, `enabled` |
| `portBase` | Start of the proxy port range (default 37801; each instance takes two: DSH and dashboard) |
| `pollMs` | Health poll interval (default 5000; automatically silenced while the panel is closed) |
| `panelLocalUrl` | Agent-side local address of `:40005` (used by the agent to read the dashboard) |

Instance fields:

- `dshUrl`: remote DSH web address (e.g. `http://192.0.2.10:3080`)
- `panelUrl`: remote `:40005` dashboard (empty = host has no dashboard)
- `ssh`: `user@host`; enabling it lets the master pull the token from the slave log and renew the cookie automatically (optional — you can also paste a token via **Reauthorize**)
- `tokenLogPath`: slave DSH startup log (the last `?token=` is extracted; default `~/.dsh/dsh-web.log`)
- `dshPort` / `panelPort`: loopback ports on the master; left empty they are allocated from `portBase`
- `enabled`: temporarily disable an instance

## Usage

1. **Open the panel**: sidebar → **Fleet**.
2. **Instance rail**: the pseudo-instance **All sessions** on top, then one row per host (online state, session count, running count, latency, dashboard state; `no dashboard` means `panelUrl` is not set).
3. **Three views on the right**:
   - **Overview**: CPU / memory / load / disks / GPU cards per host (from `:40005`); “Open DSH” opens that host's real UI in a new tab.
   - **Dashboard**: the current host's `:40005` page embedded (fullscreen available); “Open dashboard” opens it in a new tab.
   - **All sessions** (in the rail below): every session on every host, **running first**, with a device tag per row. Search, **Running only**, and **With subagents** (child sessions are hidden by default; when shown they carry a `sub` badge and their task label). **Click any row** to open that session inside the panel (switching sessions reuses the booted remote app, no reload).
4. **Launch a session**: rail bottom → **New session** → pick **device / folder** (empty = default, suggestions from history) **/ model** → the panel switches to that device and opens the new session.
5. **Add an instance**: rail bottom → **Add** → fill name, DSH URL, dashboard URL, SSH, ports; the proxy is created and authorization attempted on save.
6. **Authorization failures**: when an instance shows “not authorized”, click **Reauthorize** and paste that host's DSH launch token (the `http://host:3080/?token=...` line in its `~/.dsh/dsh-web.log`).
7. **Performance behaviour**: polling pauses while the page is hidden; data is prewarmed in the background before the panel opens; hidden dashboard / viewer iframes are destroyed after 60 seconds.

## Security

- Remote cookies are stored only in the master's `~/.dsh/.credentials.yaml` (`dsh-fleet/<id>`) — not in the browser, not in logs.
- Each proxy requires a one-time key (`?k=` → HttpOnly cookie); requests without it get 401, and proxies listen on `127.0.0.1` only.
- All agent endpoints except `ping` require `X-Fleet-Key`; they are read-only.
- SSH is used only to `grep` the token out of the slave log and renew cookies; no business data is transferred.

## FAQ

| Symptom | Fix |
|---|---|
| Blank dashboard / endless spinner | Usually third-party cookies are fully blocked; use **Open dashboard** in a new tab, or allow cookies for `localhost` |
| Clicking the dashboard freezes the page | Only Chrome/Edge have cross-site process isolation; on Safari/Firefox use **Open dashboard** in a new tab |
| Instance shows “not authorized” | The token rotates on slave restart: configure `ssh` for automatic renewal, or paste the new token via **Reauthorize** |
| Agent endpoints return 401 | `agentKey` differs between master and slave, or the slave has not been restarted with the agent role |
| Slave fails with `@deepseek-ai/schemastery` not found | Follow step 2 of the agent install (symlink) |
| Cannot reach the slave on 3080 | That DSH web is not running or listens elsewhere; `dsh web` does not bind `0.0.0.0` by default — pass `--host 0.0.0.0` |
| List is slow with very large session counts | Server keeps a 30 s full-list cache plus a 10 s query cache and the client prewarms; increase `pollMs` if needed |

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
