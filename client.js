/* dsh-fleet — browser half.
 * Hand-written classic-script bundle (no bundler): it self-registers through
 * the page's __ModuleLoader__ and only requires "react" from the platform
 * module table. Host routes are same-origin: the panel never sees remote
 * cookies, only loopback proxy URLs behind a per-process access key.
 */
window.__ModuleLoader__.load({
  id: 'dsh-fleet',
  factory(require) {
    window.__dshFleetFactory = 'v1'
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement
    const NS = 'dsh-fleet'

    const DICT = {
      zh: {
        panel: '多机',
        settings: '多机管理',
        title: '多机 DSH',
        subtitle: '一个界面管理多台设备上的 DSH',
        overview: '总览',
        dshView: 'DSH 界面',
        panelView: '看板',
        refresh: '刷新',
        openTab: '在新标签打开',
        openDsh: '打开 DSH',
        openPanel: '打开看板',
        newSession: '新会话',
        remoteSidebar: '远端侧栏',
        sessionsTitle: '会话',
        openSessionHint: '在面板内查看该会话',
        searchSessions: '搜索会话…',
        collapseRail: '收起实例栏',
        launchSession: '启动会话',
        launchDevice: '设备',
        launchFolder: '文件夹（绝对路径，留空用默认）',
        launchFolderPlaceholder: '/home/user/project',
        launchModel: '模型',
        launchConfirm: '启动',
        launchBusy: '启动中…',
        launchFailed: '启动失败：',
        launchNoModel: '该实例没有可用模型列表',
        expandRail: '展开实例栏',
        onlyRunning: '只看运行中',
        includeChildren: '含子会话',
        childTag: '子',
        noSessionMatch: '没有匹配的会话',
        expandSessions: '展开会话列表',
        collapseSessions: '收起会话列表',
        closeViewer: '关闭',
        loading: '远端实例启动中… 首次打开会慢一点，之后切会话不再重载',
        openFailed: '打开远端会话失败：',
        fullscreen: '全屏',
        reauth: '重新授权',
        add: '＋ 添加实例',
        empty: '还没有实例。去 设置 → 多机管理 添加，或在下面添加一个。',
        offline: '离线',
        needAuth: '需授权',
        online: '在线',
        noProxy: '代理未就绪',
        agent: 'agent',
        noAgent: '直连',
        sessions: '会话',
        running: '运行中',
        idle: '空闲',
        runningView: '运行中',
        allEntry: '全部会话',
        noRunning: '当前没有运行中的会话（跨所有设备）',
        latency: '延迟',
        panelOk: '看板在线',
        panelMissing: '看板离线',
        noPanel: '无看板',
        panelSwitchHint: '这台没看板，点击会切到有看板的实例',
        cpu: 'CPU',
        mem: '内存',
        load: '负载',
        gpus: 'GPU',
        disk: '磁盘',
        temp: '温度',
        power: '功耗',
        noPanelData: '暂无看板数据',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        saveFailed: '保存失败',
        idLabel: 'ID（唯一，用作 cookie/端口名）',
        name: '显示名',
        dshUrl: 'DSH 地址',
        panelUrl: '看板地址',
        ssh: 'SSH 目标（自动取 token）',
        tokenLogPath: '远端日志路径',
        dshPort: 'DSH 代理端口',
        panelPort: '看板代理端口',
        agentUrl: 'agent 地址',
        enabled: '启用',
        remove: '删除',
        addInstance: '新增实例',
        agentKey: 'agent 共享密钥',
        pollMs: '健康轮询间隔（毫秒，≥2000）',
        portBase: '代理端口起点',
        panelLocalUrl: '从机看板本地地址',
        roles: '角色',
        authTitle: '重新授权',
        authHint: '粘贴远端启动 URL（含 ?token=）或 token 本身；也可留空走 SSH 自动获取。',
        authPlaceholder: 'http://192.0.2.10:3080/?token=…',
        authSubmit: '授权',
        authCancel: '取消',
        authWorking: '授权中…',
        authFailed: '授权失败',
        settingsHint: '实例配置保存在本机 profile 的 dsh-fleet 条目里（由 dsh 配置编辑器写入 cordis.patch.yml），代理端口只监听 127.0.0.1。',
        pausing: '仅当前视图挂载 iframe，切走即卸载，避免多份 DSH 同时跑。',
      },
      en: {
        panel: 'Fleet',
        settings: 'Fleet instances',
        title: 'Multi-host DSH',
        subtitle: 'Manage DSH instances across devices from one page',
        overview: 'Overview',
        dshView: 'DSH UI',
        panelView: 'Dashboard',
        refresh: 'Refresh',
        openTab: 'Open in tab',
        openDsh: 'Open DSH',
        openPanel: 'Open dashboard',
        newSession: 'New session',
        remoteSidebar: 'Remote sidebar',
        sessionsTitle: 'Sessions',
        openSessionHint: 'View this session in the panel',
        searchSessions: 'Search sessions…',
        collapseRail: 'Collapse instance rail',
        launchSession: 'New session',
        launchDevice: 'Device',
        launchFolder: 'Folder (absolute path, empty = default)',
        launchFolderPlaceholder: '/home/user/project',
        launchModel: 'Model',
        launchConfirm: 'Start',
        launchBusy: 'Starting…',
        launchFailed: 'Launch failed: ',
        launchNoModel: 'No model catalog for this instance',
        expandRail: 'Expand instance rail',
        onlyRunning: 'Running only',
        includeChildren: 'With subagents',
        childTag: 'sub',
        noSessionMatch: 'No matching session',
        expandSessions: 'Expand session list',
        collapseSessions: 'Collapse session list',
        closeViewer: 'Close',
        loading: 'Starting the remote instance… first open is slower; session switches reuse it.',
        openFailed: 'Cannot open remote session: ',
        fullscreen: 'Fullscreen',
        reauth: 'Re-authorize',
        add: '+ Add instance',
        empty: 'No instances yet. Add one below or under Settings → Fleet instances.',
        offline: 'Offline',
        needAuth: 'Needs auth',
        online: 'Online',
        noProxy: 'Proxy not ready',
        agent: 'agent',
        noAgent: 'direct',
        sessions: 'sessions',
        running: 'running',
        idle: 'idle',
        runningView: 'Running',
        allEntry: 'All sessions',
        noRunning: 'No session is running on any managed device.',
        latency: 'latency',
        panelOk: 'dashboard online',
        panelMissing: 'dashboard down',
        noPanel: 'no dashboard',
        panelSwitchHint: 'This instance has no dashboard; click to switch to one that does.',
        cpu: 'CPU',
        mem: 'Memory',
        load: 'Load',
        gpus: 'GPU',
        disk: 'Disk',
        temp: 'Temp',
        power: 'Power',
        noPanelData: 'No dashboard data yet',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        saveFailed: 'Save failed',
        idLabel: 'ID (unique key)',
        name: 'Display name',
        dshUrl: 'DSH URL',
        panelUrl: 'Dashboard URL',
        ssh: 'SSH target (token refresh)',
        tokenLogPath: 'Remote log path',
        dshPort: 'DSH proxy port',
        panelPort: 'Dashboard proxy port',
        agentUrl: 'Agent URL',
        enabled: 'Enabled',
        remove: 'Remove',
        addInstance: 'Add instance',
        agentKey: 'Agent shared key',
        pollMs: 'Health poll interval (ms, ≥2000)',
        portBase: 'Proxy port base',
        panelLocalUrl: 'Agent-local dashboard URL',
        roles: 'Roles',
        authTitle: 'Re-authorize',
        authHint: 'Paste the remote launch URL (with ?token=) or the token itself; leave empty to refresh over SSH.',
        authPlaceholder: 'http://192.0.2.10:3080/?token=…',
        authSubmit: 'Authorize',
        authCancel: 'Cancel',
        authWorking: 'Authorizing…',
        authFailed: 'Authorization failed',
        settingsHint: 'Instance config lives in this profile\'s dsh-fleet entry (written to cordis.patch.yml by the dsh config editor); proxy ports bind 127.0.0.1 only.',
        pausing: 'Only the active view keeps its iframe mounted, so multiple DSH apps never run at once.',
      },
    }

    const CSS = `
.dsf-root{display:flex;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit}
.dsf-aside.collapsed{display:none}
.dsf-aside{width:252px;flex:none;min-height:0;border-right:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:2px;padding:12px 8px;background:var(--dsw-specific-sidebar-fill)}
.dsf-head{font-weight:600;font-size:13px;padding:2px 8px 4px}
.dsf-sub{color:var(--dsw-alias-label-secondary);font-size:11px;padding:0 8px 10px;line-height:1.4}
.dsf-item{display:flex;gap:9px;align-items:flex-start;padding:8px 8px;border-radius:8px;cursor:pointer;border:1px solid transparent;background:none;color:inherit;text-align:left;font:inherit;width:100%}
.dsf-item:hover{background:var(--dsw-specific-sidebar-nav-item-hover)}
.dsf-item.on{background:var(--dsw-specific-sidebar-nav-item-active);border-color:var(--dsw-alias-border-l1)}
.dsf-dot{width:7px;height:7px;border-radius:50%;margin-top:5px;flex:none;background:var(--dsw-alias-state-idle-primary)}
.dsf-dot.ok{background:var(--dsw-alias-state-success-primary)}
.dsf-dot.auth{background:var(--dsw-alias-state-warn-primary)}
.dsf-dot.err{background:var(--dsw-alias-state-error-primary)}
.dsf-item-main{min-width:0;flex:1}
.dsf-item-name{font-size:12.5px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsf-item-meta{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.dsf-spacer{flex:1}
.dsf-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}
.dsf-bar{height:44px;flex:none;display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dsf-tab{padding:5px 10px;border-radius:7px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:none;font:inherit}
.dsf-tab.on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsf-btn{background:var(--dsw-alias-bg-layer-1);color:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:5px 10px;font-size:12px;cursor:pointer;font:inherit;white-space:nowrap}
.dsf-btn:hover{border-color:var(--dsw-alias-border-l2)}
.dsf-btn.primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsf-btn.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.dsf-btn:disabled{opacity:.5;cursor:default}
.dsf-body{flex:1;min-height:0;position:relative;background:var(--dsw-alias-bg-base)}
.dsf-panelwrap{position:absolute;inset:0}
.dsf-frame{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff}
.dsf-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}
.dsf-run-head{font-size:12.5px;font-weight:550;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsf-running{position:absolute;inset:0;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:2px}
.dsf-run-row{display:flex;align-items:center;gap:10px;width:100%;background:none;border:none;border-bottom:1px solid var(--dsw-alias-border-l1);color:inherit;font:inherit;text-align:left;padding:9px 6px;cursor:pointer}
.dsf-run-row:hover{background:var(--dsw-specific-sidebar-nav-item-hover)}
.dsf-run-instance{flex:none;max-width:78px;font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsf-sessions .dsf-run-instance{margin-right:2px}
.dsf-run-title{flex:1;min-width:0;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.dsf-pill{flex:none;font-size:9.5px;line-height:15px;padding:0 6px;border-radius:999px;font-weight:600;white-space:nowrap}
.dsf-pill.ok{color:#34d399;background:rgba(52,211,153,.14)}
.dsf-pill.warn{color:#fbbf24;background:rgba(251,191,36,.16)}
.dsf-pill.err{color:#f87171;background:rgba(248,113,113,.16)}
.dsf-pill.live{color:#34d399;background:rgba(52,211,153,.14);font-variant-numeric:tabular-nums}
.dsf-badge{flex:none;font-size:9px;line-height:14px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsf-badge.quiet{opacity:.75}
.dsf-item.offline{opacity:.72}
.dsf-item-name{display:flex;align-items:center;gap:5px;min-width:0}
.dsf-item-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dsf-item-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsf-meta-dim{opacity:.72}
.dsf-lat{font-variant-numeric:tabular-nums}
.dsf-lat.fast{color:#34d399}.dsf-lat.ok{color:#fbbf24}.dsf-lat.slow{color:#f87171}
.dsf-statrow{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 8px}
.dsf-stat{font-size:11px;padding:2px 7px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dsf-stat b{color:var(--dsw-alias-label-primary);font-weight:650}
.dsf-stat.live{background:rgba(52,211,153,.14);color:#34d399}
.dsf-stat.live b{color:#34d399}
.dsf-metric{display:flex;align-items:center;gap:8px;margin:5px 0}
.dsf-metric-label{flex:none;width:46px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsf-metric-val{flex:none;min-width:96px;text-align:right;font-size:11px;font-variant-numeric:tabular-nums}
.dsf-bar{position:relative;flex:1;height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;min-width:36px}
.dsf-bar>i{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:currentColor}
.dsf-bar>u{position:absolute;left:0;bottom:0;height:2px;border-radius:999px;background:currentColor;opacity:.45}
.dsf-bar.cool{color:#34d399}.dsf-bar.warm{color:#fbbf24}.dsf-bar.hot{color:#f87171}
.dsf-gpu-row{align-items:center}
.dsf-gpu-name{flex:none;max-width:42%;overflow:hidden;text-overflow:ellipsis;font-size:11px}
.dsf-gpu-val{flex:none;display:flex;align-items:center;gap:8px;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.dsf-gpu-val .hot{color:#f87171}
.dsf-gpu-val b{font-variant-numeric:tabular-nums}
.dsf-state{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:9.5px;line-height:15px;padding:0 5px;border-radius:999px;white-space:nowrap}
.dsf-state.running{color:#34d399;background:rgba(52,211,153,.14);font-weight:600}
.dsf-state.idle{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.dsf-pulse{width:5px;height:5px;border-radius:999px;background:currentColor;animation:dsf-pulse 1.6s ease-in-out infinite}
@keyframes dsf-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@media (prefers-reduced-motion: reduce){.dsf-pulse{animation:none}}
.dsf-cards{position:absolute;inset:0;overflow:auto;padding:16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:12px;align-content:start}
.dsf-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;min-width:0}
.dsf-card-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.dsf-card-name{font-weight:600;font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsf-kv{display:flex;justify-content:space-between;gap:10px;font-size:12px;line-height:1.9;color:var(--dsw-alias-label-secondary)}
.dsf-kv b{color:var(--dsw-alias-label-primary);font-weight:550}
.dsf-gpu{margin-top:8px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsf-gpu-row{display:flex;gap:8px;justify-content:space-between;padding:1px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsf-tag{font-size:10px;padding:1px 6px;border-radius:99px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.dsf-modal{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);display:flex;align-items:center;justify-content:center;padding:20px;z-index:10}
.dsf-dialog{width:100%;max-width:520px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px 18px;box-shadow:0 12px 40px rgba(0,0,0,.35)}
.dsf-dialog h3{margin:0 0 6px;font-size:14px}
.dsf-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;margin:0 0 10px}
.dsf-input{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);color:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:7px 9px;font:inherit;font-size:12px}
.dsf-row{display:flex;gap:8px;align-items:center;margin-top:8px}
.dsf-row .dsf-btn{margin-left:auto}
.dsf-settings{position:absolute;inset:0;overflow:auto;padding:16px 18px}
.dsf-settings h2{margin:0 0 4px;font-size:16px}
.dsf-settings .dsf-hint{margin-bottom:14px}
.dsf-inst{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-1)}
.dsf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}
.dsf-field{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--dsw-alias-label-secondary);min-width:0}
.dsf-status{font-size:12px;color:var(--dsw-alias-label-secondary);margin-left:8px}
.dsf-err{font-size:11px;color:var(--dsw-alias-state-error-primary);margin-top:4px}
.dsf-sessions{margin:6px 4px 0;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:6px;flex:1 1 auto;min-height:0;overflow:auto}
.dsf-spacer.tight{flex:0 0 6px}
.dsf-launch-row{display:flex;flex-direction:column;gap:3px;margin-bottom:10px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsf-launch-row select{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);color:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:7px 9px;font:inherit;font-size:12px}
.dsf-sessions-head{display:flex;align-items:center;gap:6px;width:100%;background:none;border:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;padding:0 8px 4px;cursor:pointer;text-align:left}
.dsf-sessions-head:hover{color:var(--dsw-alias-label-primary)}
.dsf-sessions-caret{margin-left:auto}
.dsf-session-tools{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:2px 6px 6px}
.dsf-search{flex:1;min-width:0;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;color:inherit;font:inherit;font-size:11px;padding:4px 7px}
.dsf-search:focus{outline:none;border-color:var(--dsw-alias-border-l2)}
.dsf-chip{background:none;border:1px solid var(--dsw-alias-border-l1);border-radius:99px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;padding:3px 8px;cursor:pointer;white-space:nowrap}
.dsf-chip.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.dsf-session{display:flex;gap:7px;align-items:center;width:100%;background:none;border:none;color:inherit;font:inherit;text-align:left;padding:5px 8px;border-radius:7px;cursor:pointer}
.dsf-session.running{background:linear-gradient(90deg,rgba(52,211,153,.10),rgba(52,211,153,0) 72%)}
.dsf-session.running:hover{background:linear-gradient(90deg,rgba(52,211,153,.18),rgba(52,211,153,.02) 72%)}
.dsf-session:hover{background:var(--dsw-specific-sidebar-nav-item-hover)}
.dsf-session .dsf-dot{margin-top:0}
.dsf-child{flex:none;font-size:9px;line-height:14px;padding:0 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-3,#3a3a3a);color:var(--dsw-alias-label-secondary)}
.dsf-session-title{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.dsf-session-age{font-size:10px;color:var(--dsw-alias-label-secondary);flex:none}
.dsf-session{background:none;border:none;font:inherit;color:inherit;text-align:left;width:100%;cursor:pointer}
.dsf-viewer.hidden{display:none}
.dsf-viewer{position:absolute;inset:0;z-index:9;display:flex;flex-direction:column;gap:8px;padding:12px;background:var(--dsw-alias-bg-mask-1)}
.dsf-viewer-bar{display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dsf-viewer-title{flex:1;min-width:0;font-size:12.5px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsf-viewer-frame-wrap{flex:1;position:relative;min-height:0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-base)}
.dsf-viewer-frame{position:absolute;inset:0;width:100%;height:100%;border:0;background:var(--dsw-alias-bg-base);opacity:0;transition:opacity 120ms ease-out}
.dsf-viewer-frame.ready{opacity:1}
.dsf-viewer-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;background:var(--dsw-alias-bg-base);pointer-events:none}
.dsf-banner{position:absolute;left:12px;bottom:12px;background:var(--dsw-alias-state-error-primary);color:#fff;padding:6px 10px;border-radius:8px;font-size:12px;z-index:5;max-width:70%}
`

    const BASE = () => (typeof document === 'undefined' ? 'http://127.0.0.1/' : document.baseURI)

    /** Data preloaded while the panel is closed, so opening it paints instantly. */
    const warmCache = { status: null, overview: null, overviewAt: 0, sessions: new Map(), aggregate: null }

    /**
     * Embeds use `localhost` instead of `127.0.0.1`: the browser then runs the
     * iframe in a separate site, so a heavy dashboard cannot block this page.
     */
    const isolatedOrigin = (url) => (typeof url === 'string' ? url.replace('http://127.0.0.1', 'http://localhost') : url)

    /** Pseudo-instance id of the cross-device "running sessions" entry. */
    const ALL_VIEW_ID = '__all__'

    async function apiGet(path) {
      const response = await fetch(new URL(path, BASE()).href, { cache: 'no-store' })
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
      return JSON.parse(text)
    }

    async function apiPut(path, value) {
      const response = await fetch(new URL(path, BASE()).href, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
      return JSON.parse(text)
    }

    async function apiPost(path, value) {
      const response = await fetch(new URL(path, BASE()).href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
      return JSON.parse(text)
    }

    /** Poll one JSON route while `active` stays true. */
    function usePoll(path, intervalMs, active, cacheKey) {
      const [data, setData] = useState(() => (cacheKey === undefined ? null : (warmCache[cacheKey] ?? null)))
      const [error, setError] = useState(null)
      const timer = useRef(null)
      const tick = useCallback(async () => {
        try {
          const value = await apiGet(path)
          if (cacheKey !== undefined) warmCache[cacheKey] = value
          setData(value)
          setError(null)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [path, cacheKey])
      useEffect(() => {
        if (!active) return undefined
        let alive = true
        const loop = async () => {
          if (!alive) return
          // A hidden page keeps no polling loop: the first visible moment refreshes.
          if (typeof document !== 'undefined' && document.hidden) {
            timer.current = setTimeout(() => { void loop() }, Math.max(30000, intervalMs * 4))
            return
          }
          await tick()
          if (alive) timer.current = setTimeout(() => { void loop() }, intervalMs)
        }
        const onVisible = () => {
          if (typeof document === 'undefined' || document.hidden || !alive) return
          if (timer.current !== null) clearTimeout(timer.current)
          void loop()
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        void loop()
        return () => {
          alive = false
          if (timer.current !== null) clearTimeout(timer.current)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
      }, [active, intervalMs, tick])
      return { data, error, reload: tick }
    }

    function healthClass(instance) {
      if (instance.online === false) return instance.authed === false && instance.authError ? 'auth' : 'err'
      if (instance.authed === false) return 'auth'
      return 'ok'
    }

    function healthText(instance, tr) {
      if (instance.online === false) return instance.authError ? tr('needAuth') : tr('offline')
      if (instance.authed === false) return tr('needAuth')
      return tr('online')
    }

    /** Compact age label for a session's last activity. */
    function sessionAge(updatedAt) {
      if (typeof updatedAt !== 'number') return ''
      const seconds = Math.max(0, Math.round((Date.now() - updatedAt) / 1000))
      if (seconds < 60) return `${seconds}s`
      if (seconds < 3600) return `${Math.round(seconds / 60)}m`
      if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
      return `${Math.round(seconds / 86400)}d`
    }

    function formatGb(value) {
      return typeof value === 'number' ? `${value.toFixed(1)}G` : '—'
    }

    function FleetIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 20
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        'aria-hidden': true, style: { display: 'block', color: 'currentColor' },
      },
      h('rect', { x: 2.5, y: 4, width: 12, height: 8.5, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.5 }),
      h('path', { d: 'M6 16.5h5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      h('rect', { x: 15, y: 8, width: 6.5, height: 5, rx: 1.2, stroke: 'currentColor', strokeWidth: 1.5 }),
      h('rect', { x: 15, y: 15, width: 6.5, height: 5, rx: 1.2, stroke: 'currentColor', strokeWidth: 1.5 }))
    }

    function gpuRow(tr, gpu, index, total) {
      const usedGb = gpu.memUsedMb === null ? null : gpu.memUsedMb / 1024
      const totalGb = gpu.memTotalMb === null ? null : gpu.memTotalMb / 1024
      const util = typeof gpu.utilPct === 'number' ? Math.max(0, Math.min(100, gpu.utilPct)) : null
      const memPct = typeof gpu.memPct === 'number'
        ? gpu.memPct
        : (usedGb !== null && totalGb ? (usedGb / totalGb) * 100 : null)
      const level = util === null ? 'cool' : util >= 85 ? 'hot' : util >= 50 ? 'warm' : 'cool'
      return h('div', { className: 'dsf-gpu-row', key: index },
        h('span', { className: 'dsf-gpu-name', title: gpu.name }, `${tr('gpus')}${total > 1 ? index : ''} ${gpu.name}`),
        h('div', { className: `dsf-bar ${level}` },
          h('i', { style: { width: `${util === null ? 0 : util}%` } }),
          memPct === null ? null : h('u', { style: { width: `${Math.max(0, Math.min(100, memPct))}%` } })),
        h('span', { className: 'dsf-gpu-val' },
          h('b', null, util === null ? '—' : `${Math.round(util)}%`),
          h('span', null, `${formatGb(usedGb)}/${formatGb(totalGb)}`),
          gpu.tempC === null ? null : h('span', { className: gpu.tempC >= 80 ? 'hot' : undefined }, `${gpu.tempC}°C`),
          gpu.powerW === null ? null : h('span', null, `${Math.round(gpu.powerW)}W`)))
    }

    /** One labelled usage bar; colour reflects how hot the value is. */
    function metricRow(tr, label, text, pct) {
      const value = typeof pct === 'number' ? Math.max(0, Math.min(100, pct)) : null
      const level = value === null ? 'cool' : value >= 85 ? 'hot' : value >= 60 ? 'warm' : 'cool'
      return h('div', { className: 'dsf-metric' },
        h('span', { className: 'dsf-metric-label' }, label),
        h('div', { className: `dsf-bar ${level}` }, h('i', { style: { width: `${value === null ? 0 : value}%` } })),
        h('span', { className: 'dsf-metric-val' }, text))
    }

    function statePill(tr, machine) {
      if (machine.online === false) return { cls: 'err', text: tr('offline') }
      if (machine.authed === false) return { cls: 'warn', text: tr('needAuth') }
      return { cls: 'ok', text: tr('online') }
    }

    function OverviewCard({ machine, tr, onOpen }) {
      const panel = machine.panelOk === false ? null : machine
      const gpus = Array.isArray(panel?.gpus) ? panel.gpus : []
      const state = statePill(tr, machine)
      const sessions = machine.sessions
      const running = sessions?.running ?? 0
      const load = Array.isArray(panel?.load) ? panel.load.map((v) => (typeof v === 'number' ? v.toFixed(2) : '—')).join(' / ') : '—'
      const disk = Array.isArray(panel?.disks) && panel.disks.length > 0 ? panel.disks[0] : null
      return h('div', { className: `dsf-card${machine.online ? '' : ' offline'}` },
        h('div', { className: 'dsf-card-head' },
          h('i', { className: `dsf-dot ${state.cls === 'ok' ? 'ok' : state.cls === 'warn' ? 'auth' : 'err'}` }),
          h('div', { className: 'dsf-card-name' }, machine.name || machine.id),
          h('span', { className: `dsf-pill ${state.cls}` }, state.text),
          machine.source === 'agent' ? h('span', { className: 'dsf-badge' }, tr('agent')) : null,
          machine.dshVersion ? h('span', { className: 'dsf-badge quiet' }, `DSH ${machine.dshVersion}`) : null,
          h('button', { className: 'dsf-btn', onClick: () => onOpen?.(machine.id) }, tr('openDsh'))),
        h('div', { className: 'dsf-statrow' },
          h('span', { className: 'dsf-stat' }, `${tr('sessions')} `, h('b', null, String(sessions?.count ?? '—'))),
          h('span', { className: `dsf-stat${running > 0 ? ' live' : ''}` }, `${tr('running')} `, h('b', null, String(running))),
          h('span', { className: 'dsf-stat' }, `${tr('latency')} `, h('b', null, machine.latencyMs === null || machine.latencyMs === undefined ? '—' : `${machine.latencyMs}ms`)),
          h('span', { className: 'dsf-stat' }, machine.hasDashboard === false ? tr('noPanel') : (panel === null ? tr('panelMissing') : tr('panelOk')))),
        panel === null
          ? h('div', { className: 'dsf-hint' }, machine.error || tr('noPanelData'))
          : h(React.Fragment, null,
            metricRow(tr, tr('cpu'), `${Math.round(panel.cpuPct ?? 0)}%`, panel.cpuPct),
            metricRow(tr, tr('mem'), `${Math.round(panel.memPct ?? 0)}% · ${formatGb(panel.memUsedGb)} / ${formatGb(panel.memTotalGb)}`, panel.memPct),
            disk === null ? null : metricRow(tr, `${tr('disk')}`, `${Math.round(disk.pct ?? 0)}% · ${formatGb(disk.usedGb)} / ${formatGb(disk.totalGb)}`, disk.pct),
            h('div', { className: 'dsf-kv' }, h('span', null, tr('load')), h('b', null, load)),
            gpus.length > 0
              ? h('div', { className: 'dsf-gpu' }, gpus.map((gpu, index) => gpuRow(tr, gpu, index, gpus.length)))
              : h('div', { className: 'dsf-gpu' }, tr('noPanelData'))))
    }

    function Panel() {
      const tr = useTr()
      const status = usePoll('fleet/status', 5000, true, 'status')
      const [selectedId, setSelectedId] = useState(null)
      const [view, setView] = useState('overview')
      const [reloadKey, setReloadKey] = useState(0)
      const [authOpen, setAuthOpen] = useState(false)
      const [authText, setAuthText] = useState('')
      const [authBusy, setAuthBusy] = useState(false)
      const [authError, setAuthError] = useState(null)
      const [addOpen, setAddOpen] = useState(false)
      const [launchOpen, setLaunchOpen] = useState(false)
      const [panelReady, setPanelReady] = useState(false)
      const [showChildren, setShowChildren] = useState(() => {
        try { return localStorage.getItem('dsh-fleet.showChildren') === '1' } catch { return false }
      })
      useEffect(() => {
        try { localStorage.setItem('dsh-fleet.showChildren', showChildren ? '1' : '0') } catch { /* private mode */ }
      }, [showChildren])
      const frameWrap = useRef(null)
      const instances = useMemo(() => Array.isArray(status.data?.instances) ? status.data.instances : [], [status.data])
      const selected = instances.find((item) => item.id === selectedId) ?? null

      useEffect(() => {
        if (instances.length === 0) return
        if (selectedId !== null && (selectedId === ALL_VIEW_ID || instances.some((item) => item.id === selectedId))) return
        let remembered = null
        try { remembered = localStorage.getItem('dsh-fleet.selectedId') } catch { remembered = null }
        const rememberedInstance = instances.find((item) => item.id === remembered)
        const withPanel = instances.find((item) => typeof item.panelUrl === 'string' && item.panelUrl !== '' && item.panelProxyUrl !== null)
        setSelectedId((rememberedInstance ?? withPanel ?? instances[0]).id)
      }, [instances, selectedId])

      useEffect(() => {
        if (selectedId === null) return
        try { localStorage.setItem('dsh-fleet.selectedId', selectedId) } catch { /* private mode */ }
      }, [selectedId])

      const panelCapable = instances.filter((item) => typeof item.panelUrl === 'string' && item.panelUrl !== '' && item.panelProxyUrl !== null)
      const overview = usePoll('fleet/overview', 10000, view === 'overview' && instances.length > 0, 'overview')
      const allSelected = selectedId === ALL_VIEW_ID
      const [aggQuery, setAggQuery] = useState('')
      const [aggOnlyRunning, setAggOnlyRunning] = useState(false)
      const [agg, setAgg] = useState(() => warmCache.aggregate ?? null)
      const [aggRefresh, setAggRefresh] = useState(0)
      useEffect(() => {
        if (!allSelected) return undefined
        let cancelled = false
        const load = async () => {
          if (typeof document !== 'undefined' && document.hidden) return
          try {
            const params = new URLSearchParams()
            if (aggQuery.trim() !== '') params.set('q', aggQuery.trim())
            if (aggOnlyRunning) params.set('running', '1')
            if (showChildren) params.set('children', '1')
            params.set('titled', '1')
            const value = await apiGet(`fleet/aggregate?${params.toString()}`)
            if (!cancelled && value.ok) { setAgg(value); warmCache.aggregate = value }
          } catch {
            // Aggregate view is best-effort; keep the last data on failures.
          }
        }
        const onVisible = () => { if (typeof document !== 'undefined' && !document.hidden) void load() }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        const debounce = setTimeout(() => { void load() }, aggQuery.trim() === '' ? 0 : 300)
        const timer = setInterval(load, 10000)
        return () => {
          cancelled = true
          clearTimeout(debounce)
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
      }, [allSelected, aggQuery, aggOnlyRunning, aggRefresh, showChildren])

      const aggSessions = Array.isArray(agg?.sessions) ? agg.sessions : []
      const aggDevices = new Set(aggSessions.map((entry) => entry.instanceId)).size
      const aggTotal = typeof agg?.total === 'number' ? agg.total : aggSessions.length
      const panelUrl = selected?.panelProxyUrl ?? null

      // The dashboard iframe reloads whenever its instance changes; show a veil
      // until its load event so switching does not look like a freeze.
      useEffect(() => {
        setPanelReady(false)
      }, [selected?.id, panelUrl, reloadKey])
      const [sessionList, setSessionList] = useState(null)
      const [railCollapsed, setRailCollapsed] = useState(() => {
        try { return localStorage.getItem('dsh-fleet.railCollapsed') === '1' } catch { return false }
      })
      const [sessionQuery, setSessionQuery] = useState('')
      const [sessionCollapsed, setSessionCollapsed] = useState(false)
      const [onlyRunning, setOnlyRunning] = useState(false)
      const [viewer, setViewer] = useState(null)
      const [viewerOpen, setViewerOpen] = useState(false)
      const [viewerSrc, setViewerSrc] = useState('')
      const [viewerReload, setViewerReload] = useState(0)
      const [viewerReadyState, setViewerReadyState] = useState(false)
      const viewerFrame = useRef(null)
      const viewerReady = useRef(false)
      const viewerPending = useRef(null)
      const [sessionError, setSessionError] = useState(null)
      const selectedAuthed = selected?.authed === true
      useEffect(() => {
        setSessionError(null)
        if (selected === null || !selectedAuthed) { setSessionList(null); return undefined }
        const useCache = sessionQuery.trim() === '' && !onlyRunning && !showChildren
        if (useCache && warmCache.sessions.has(selected.id)) setSessionList(warmCache.sessions.get(selected.id))
        let cancelled = false
        const load = async () => {
          if (typeof document !== 'undefined' && document.hidden) return
          try {
            const params = new URLSearchParams({ instanceId: selected.id })
            if (sessionQuery.trim() !== '') params.set('q', sessionQuery.trim())
            if (onlyRunning) params.set('running', '1')
            if (showChildren) params.set('children', '1')
            params.set('titled', '1')
            const value = await apiGet(`fleet/sessions?${params.toString()}`)
            if (!cancelled && value.ok) {
              setSessionList(value.sessions)
              setSessionError(null)
              if (sessionQuery.trim() === '' && !onlyRunning && !showChildren) warmCache.sessions.set(selected.id, value.sessions)
            }
          } catch (failure) {
            if (!cancelled) setSessionError(failure instanceof Error ? failure.message : String(failure))
          }
        }
        const onVisible = () => { if (typeof document !== 'undefined' && !document.hidden) void load() }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        const debounce = setTimeout(() => { void load() }, sessionQuery === '' ? 0 : 300)
        const timer = setInterval(load, 15000)
        return () => {
          cancelled = true
          clearTimeout(debounce)
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
      }, [selected?.id, selectedAuthed, sessionQuery, onlyRunning, showChildren])
      const sessions = Array.isArray(sessionList?.items) ? sessionList.items : (Array.isArray(selected?.sessions?.items) ? selected.sessions.items : [])
      const sessionCount = sessionList?.count ?? selected?.sessions?.count ?? sessions.length
      const visibleSessions = sessions.filter((session) => {
        if (!showChildren && session.origin === 'subagent') return false
        if (String(session.title ?? '').trim() === '' && String(session.label ?? '').trim() === '') return false
        if (onlyRunning && session.running !== true) return false
        if (sessionQuery.trim() === '') return true
        const needle = sessionQuery.trim().toLowerCase()
        const title = String(session.title ?? '').toLowerCase()
        return title.includes(needle) || String(session.sessionId).toLowerCase().includes(needle)
      })

      const openExternal = (url) => {
        if (typeof url === 'string' && url !== '') window.open(url, '_blank', 'noopener')
      }

      useEffect(() => {
        try { localStorage.setItem('dsh-fleet.railCollapsed', railCollapsed ? '1' : '0') } catch { /* private mode */ }
      }, [railCollapsed])

      // One booted remote app per viewer session: later picks navigate inside it.
      useEffect(() => {
        const onMessage = (event) => {
          const win = viewerFrame.current?.contentWindow
          if (win === null || win === undefined || event.source !== win) return
          const data = event.data
          if (data === null || typeof data !== 'object') return
          if (data.type !== 'dshf:ready') return
          viewerReady.current = true
          setViewerReadyState(true)
          const pending = viewerPending.current
          viewerPending.current = null
          if (pending !== null) win.postMessage({ type: 'dshf:open-session', sessionId: pending }, '*')
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [])

      const openSessionFor = (instance, session) => {
        const proxyUrl = instance?.dshProxyUrl
        if (typeof proxyUrl !== 'string' || proxyUrl === '') return
        const title = session.title || String(session.sessionId).slice(-10)
        const sameInstance = viewer !== null && viewer.instanceId === instance?.id && viewerFrame.current !== null
        if (sameInstance && viewerReady.current) {
          viewerFrame.current?.contentWindow?.postMessage({ type: 'dshf:open-session', sessionId: session.sessionId }, '*')
          setViewer({ ...viewer, sessionId: session.sessionId, title })
          setViewerOpen(true)
          return
        }
        viewerReady.current = false
        setViewerReadyState(false)
        viewerPending.current = session.sessionId
        setViewerSrc(isolatedOrigin(`${proxyUrl}&dshfSession=${encodeURIComponent(session.sessionId)}&dshfCollapse=1`))
        setViewerReload((value) => value + 1)
        setViewer({ instanceId: instance.id, proxyUrl, sessionId: session.sessionId, title })
        setViewerOpen(true)
      }
      const openSessionViewer = (session) => openSessionFor(selected, session)

      useEffect(() => {
        if (viewer === null) return undefined
        const onKey = (event) => { if (event.key === 'Escape') setViewerOpen(false) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [viewer])

      // A hidden viewer keeps a whole remote DSH app running (streams, pet/fish
      // animations). Keep it for quick reopens, then drop it to stop that load.
      useEffect(() => {
        if (viewer === null || viewerOpen) return undefined
        const timer = setTimeout(() => {
          setViewer(null)
          viewerReady.current = false
          setViewerReadyState(false)
          setViewerSrc('')
        }, 60000)
        return () => clearTimeout(timer)
      }, [viewer, viewerOpen])

      const submitAuth = async () => {
        if (selected === null) return
        setAuthBusy(true)
        setAuthError(null)
        try {
          await apiPost('fleet/authorize', { instanceId: selected.id, token: authText })
          setAuthOpen(false)
          setAuthText('')
          await status.reload()
        } catch (failure) {
          setAuthError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setAuthBusy(false)
        }
      }

      const openFullscreen = () => {
        const element = frameWrap.current
        if (element !== null && typeof element.requestFullscreen === 'function') void element.requestFullscreen()
      }

      return h('div', { className: 'dsf-root' },
        h('aside', { className: `dsf-aside${railCollapsed ? ' collapsed' : ''}` },
          h('div', { className: 'dsf-head' }, tr('title')),
          h('div', { className: 'dsf-sub' }, tr('subtitle')),
          h('button', {
            key: ALL_VIEW_ID,
            className: `dsf-item${allSelected ? ' on' : ''}`,
            onClick: () => { setSelectedId(ALL_VIEW_ID); setView('overview') },
          },
          h('i', { className: `dsf-dot${(agg?.running ?? 0) > 0 ? ' ok' : ''}` }),
          h('div', { className: 'dsf-item-main' },
            h('div', { className: 'dsf-item-name' }, tr('allEntry')),
            h('div', { className: 'dsf-item-meta' },
              `${aggTotal} ${tr('sessions')}${aggDevices > 0 ? ` · ${aggDevices} 台设备` : ''}`))),
          instances.map((instance) => h('button', {
            key: instance.id,
            className: `dsf-item${instance.id === selected?.id ? ' on' : ''}${instance.online === false ? ' offline' : ''}`,
            onClick: () => setSelectedId(instance.id),
          },
          h('i', { className: `dsf-dot ${healthClass(instance)}` }),
          h('div', { className: 'dsf-item-main' },
            h('div', { className: 'dsf-item-name' },
              h('span', { className: 'dsf-item-title' }, instance.name || instance.id),
              h('span', { className: `dsf-pill ${instance.online === false ? 'err' : instance.authed === false ? 'warn' : 'ok'}` }, healthText(instance, tr)),
              instance.agent?.ok ? h('span', { className: 'dsf-badge' }, tr('agent')) : null),
            h('div', { className: 'dsf-item-meta' },
              instance.sessions && instance.sessions.running > 0
                ? h('span', { className: 'dsf-pill live' }, `▶ ${instance.sessions.running} ${tr('running')}`)
                : null,
              instance.sessions ? h('span', null, `${instance.sessions.count} ${tr('sessions')}`) : null,
              instance.latencyMs !== null && instance.latencyMs !== undefined
                ? h('span', { className: `dsf-lat${instance.latencyMs > 300 ? ' slow' : instance.latencyMs > 120 ? ' ok' : ' fast'}` }, `${instance.latencyMs}ms`)
                : null,
              h('span', { className: 'dsf-meta-dim' }, instance.panelUrl ? (instance.panel?.ok ? tr('panelOk') : tr('panelMissing')) : tr('noPanel')))))),
          allSelected
            ? h('div', { className: 'dsf-sessions' },
              h('div', { className: 'dsf-sessions-head' }, (() => {
                const shown = typeof agg?.matched === 'number' ? agg.matched : aggSessions.length
                // Untitled sessions are filtered out by default, so the header
                // always reports the real (matched) count alongside the raw total.
                const filtering = true
                const cap = shown > aggSessions.length ? `（前 ${aggSessions.length}）` : ''
                return `${tr('allEntry')} · ${filtering ? shown : aggTotal}${filtering ? ` / ${aggTotal}` : ''}${cap}`
              })()),
              h('div', { className: 'dsf-session-tools' },
                h('input', {
                  className: 'dsf-search',
                  value: aggQuery,
                  placeholder: tr('searchSessions'),
                  onChange: (event) => setAggQuery(event.target.value),
                }),
                h('button', {
                  className: `dsf-chip${aggOnlyRunning ? ' on' : ''}`,
                  onClick: () => setAggOnlyRunning((value) => !value),
                }, tr('onlyRunning')),
                h('button', {
                  className: `dsf-chip${showChildren ? ' on' : ''}`,
                  onClick: () => setShowChildren((value) => !value),
                }, tr('includeChildren'))),
              aggSessions.length === 0
                ? h('div', { className: 'dsf-sub', style: { padding: '6px 8px' } }, tr('noSessionMatch'))
                : aggSessions.map((entry) => h('button', {
                  key: `${entry.instanceId}:${entry.sessionId}`,
                  className: `dsf-session${entry.running ? ' running' : ''}`,
                  title: `${entry.instanceName || entry.instanceId}\n${entry.sessionId}\n${tr('openSessionHint')}`,
                  onClick: () => {
                    const instance = instances.find((item) => item.id === entry.instanceId)
                    if (instance !== undefined) openSessionFor(instance, entry)
                  },
                },
                entry.running
                  ? h('span', { className: 'dsf-state running' }, h('i', { className: 'dsf-pulse' }), tr('running'))
                  : h('span', { className: 'dsf-state idle' }, tr('idle')),
                h('span', { className: 'dsf-run-instance' }, entry.instanceName || entry.instanceId),
                entry.origin === 'subagent' ? h('span', { className: 'dsf-child' }, tr('childTag')) : null,
                h('span', { className: 'dsf-session-title' }, entry.label || entry.title || String(entry.sessionId).slice(-10)),
                h('span', { className: 'dsf-session-age' }, sessionAge(entry.updatedAt)))))
            : selected !== null && sessions.length > 0
            ? h('div', { className: 'dsf-sessions' },
              h('button', {
                className: 'dsf-sessions-head',
                onClick: () => setSessionCollapsed((value) => !value),
                title: sessionCollapsed ? tr('expandSessions') : tr('collapseSessions'),
              },
              h('span', null, `${tr('sessionsTitle')} · ${sessionCount}${sessionList?.total !== undefined && sessionCount !== sessionList.total ? ` / ${sessionList.total}` : ''}${sessionList?.running > 0 ? ` · ${sessionList.running} ${tr('running')}` : ''}${sessionError ? ' ⚠' : ''}`),
              h('span', { className: 'dsf-sessions-caret' }, sessionCollapsed ? '▸' : '▾')),
              sessionCollapsed
                ? null
                : h(React.Fragment, null,
                  h('div', { className: 'dsf-session-tools' },
                    h('input', {
                      className: 'dsf-search',
                      value: sessionQuery,
                      placeholder: tr('searchSessions'),
                      onChange: (event) => setSessionQuery(event.target.value),
                    }),
                    h('button', {
                      className: `dsf-chip${onlyRunning ? ' on' : ''}`,
                      onClick: () => setOnlyRunning((value) => !value),
                    }, tr('onlyRunning')),
                    h('button', {
                      className: `dsf-chip${showChildren ? ' on' : ''}`,
                      onClick: () => setShowChildren((value) => !value),
                    }, tr('includeChildren'))),
                  visibleSessions.length === 0
                    ? h('div', { className: 'dsf-sub', style: { padding: '6px 8px' } }, tr('noSessionMatch'))
                    : visibleSessions.map((session) => h('button', {
                      key: session.sessionId,
                      className: `dsf-session${session.running ? ' running' : ''}`,
                      title: `${session.sessionId}\n${tr('openSessionHint')}`,
                      onClick: () => openSessionViewer(session),
                    },
                    session.running
                      ? h('span', { className: 'dsf-state running' }, h('i', { className: 'dsf-pulse' }), tr('running'))
                      : h('span', { className: 'dsf-state idle' }, tr('idle')),
                    session.origin === 'subagent' ? h('span', { className: 'dsf-child' }, tr('childTag')) : null,
                    h('span', { className: 'dsf-session-title' }, session.label || session.title || String(session.sessionId).slice(-10)),
                    h('span', { className: 'dsf-session-age' }, sessionAge(session.updatedAt))))))
            : null,
          instances.length === 0 ? h('div', { className: 'dsf-sub' }, tr('empty')) : null,
          h('div', { className: `dsf-spacer${allSelected || (selected !== null && sessions.length > 0) ? ' tight' : ''}` }),
          h('button', { className: 'dsf-btn', style: { margin: '8px 4px 0' }, onClick: () => setLaunchOpen(true) }, tr('launchSession')),
          h('button', { className: 'dsf-btn', style: { margin: '8px 4px 0' }, onClick: () => setAddOpen(true) }, tr('add'))),
        h('main', { className: 'dsf-main' },
          h('div', { className: 'dsf-bar' },
            h('button', {
              className: 'dsf-btn',
              title: railCollapsed ? tr('expandRail') : tr('collapseRail'),
              onClick: () => setRailCollapsed((value) => !value),
            }, railCollapsed ? '☰' : '⇤'),
            h(React.Fragment, null,
                h('button', { className: `dsf-tab${view === 'overview' ? ' on' : ''}`, onClick: () => setView('overview') }, tr('overview')),
            h('button', {
              className: `dsf-tab${view === 'panel' ? ' on' : ''}`,
              onClick: () => {
                if (panelUrl !== null) { setView('panel'); return }
                const fallback = panelCapable[0]
                if (fallback !== undefined) { setSelectedId(fallback.id); setView('panel') }
              },
              disabled: panelCapable.length === 0,
              title: panelUrl === null && panelCapable.length > 0 ? tr('panelSwitchHint') : undefined,
            }, tr('panelView'))),
            h('div', { className: 'dsf-spacer' }),
            status.error ? h('span', { className: 'dsf-err' }, status.error) : null,
            h('button', {
              className: 'dsf-btn',
              onClick: () => { setReloadKey((value) => value + 1); void status.reload(); if (allSelected) setAggRefresh((value) => value + 1) },
            }, tr('refresh')),
            h(React.Fragment, null,
              h('button', {
                className: 'dsf-btn primary',
                disabled: selected === null || selected.dshProxyUrl === null,
                onClick: () => openExternal(selected?.dshProxyUrl),
              }, tr('openDsh')),
              h('button', {
                className: 'dsf-btn',
                disabled: selected === null || panelUrl === null,
                onClick: () => openExternal(panelUrl),
              }, tr('openPanel')),
              h('button', { className: 'dsf-btn', disabled: view !== 'panel' || panelUrl === null, onClick: openFullscreen }, tr('fullscreen')),
              h('button', { className: 'dsf-btn', disabled: selected === null, onClick: () => { setAuthError(null); setAuthOpen(true) } }, tr('reauth')))),
          h('div', { className: 'dsf-body', ref: frameWrap },
            view === 'overview'
              ? h('div', { className: 'dsf-cards' },
                (overview.data?.machines ?? []).map((machine) => h(OverviewCard, {
                  key: machine.id, machine, tr,
                  onOpen: (id) => { setSelectedId(id); openExternal(instances.find((item) => item.id === id)?.dshProxyUrl) },
                })),
                instances.length === 0 ? h('div', { className: 'dsf-empty' }, tr('empty')) : null,
                instances.length > 0 && (overview.data?.machines ?? []).length === 0 ? h('div', { className: 'dsf-empty' }, tr('noPanelData')) : null)
              : panelUrl === null
                ? h('div', { className: 'dsf-empty' }, selected === null ? tr('empty') : tr('noProxy'))
                : h('div', { className: 'dsf-panelwrap' },
                  panelReady ? null : h('div', { className: 'dsf-viewer-loading' }, tr('loading')),
                  h('iframe', {
                    key: `${selected.id}:${panelUrl}:${reloadKey}`,
                    className: `dsf-frame${panelReady ? ' ready' : ''}`,
                    src: isolatedOrigin(panelUrl),
                    title: `${selected.name || selected.id} ${tr('panelView')}`,
                    onLoad: () => setPanelReady(true),
                  })),
            viewer !== null && viewer.proxyUrl
              ? h('div', {
                className: `dsf-viewer${viewerOpen ? '' : ' hidden'}`,
                onClick: (event) => { if (event.target === event.currentTarget) setViewerOpen(false) },
              },
                h('div', { className: 'dsf-viewer-bar' },
                  h('span', { className: 'dsf-viewer-title' }, viewer.title),
                  h('button', {
                    className: 'dsf-btn',
                    onClick: () => openExternal(`${viewer.proxyUrl}&dshfSession=${encodeURIComponent(viewer.sessionId)}`),
                  }, tr('openTab')),
                  h('button', { className: 'dsf-btn', onClick: () => setViewerOpen(false) }, tr('closeViewer'))),
                h('div', { className: 'dsf-viewer-frame-wrap' },
                  h('iframe', {
                    key: `${viewer.instanceId}:${viewerReload}`,
                    ref: (element) => { viewerFrame.current = element },
                    className: `dsf-viewer-frame${viewerReadyState ? ' ready' : ''}`,
                    src: viewerSrc,
                    title: viewer.title,
                  }),
                  viewerOpen && !viewerReadyState ? h('div', { className: 'dsf-viewer-loading' }, tr('loading')) : null))
              : null,
            authOpen
              ? h('div', { className: 'dsf-modal' },
                h('div', { className: 'dsf-dialog' },
                  h('h3', null, tr('authTitle')),
                  h('p', { className: 'dsf-hint' }, tr('authHint')),
                  h('input', { className: 'dsf-input', value: authText, placeholder: tr('authPlaceholder'), onChange: (event) => setAuthText(event.target.value) }),
                  authError ? h('div', { className: 'dsf-err' }, authError) : null,
                  h('div', { className: 'dsf-row' },
                    h('button', { className: 'dsf-btn', onClick: () => setAuthOpen(false) }, tr('authCancel')),
                    h('button', { className: 'dsf-btn primary', disabled: authBusy, onClick: () => void submitAuth() }, authBusy ? tr('authWorking') : tr('authSubmit')))))
              : null,
            addOpen ? h(InstanceDialog, { tr, onClose: () => setAddOpen(false), onSaved: async () => { setAddOpen(false); await status.reload() } }) : null,
            launchOpen ? h(LaunchDialog, {
              tr,
              instances,
              defaultInstanceId: selected?.id ?? instances[0]?.id,
              onClose: () => setLaunchOpen(false),
              onLaunched: async (instanceId, sessionId) => {
                setLaunchOpen(false)
                setSelectedId(instanceId)
                const instance = instances.find((item) => item.id === instanceId)
                if (instance !== undefined) openSessionFor(instance, { sessionId, title: '' })
                await status.reload()
                setAggRefresh((value) => value + 1)
              },
            }) : null)))
    }

    /** Create a session on a chosen device with an optional folder and model. */
    function LaunchDialog({ tr, instances, defaultInstanceId, onClose, onLaunched }) {
      const candidates = instances.filter((instance) => instance.authed === true && instance.dshProxyUrl !== null)
      const [instanceId, setInstanceId] = useState(defaultInstanceId ?? candidates[0]?.id ?? '')
      const [folder, setFolder] = useState('')
      const [folders, setFolders] = useState([])
      const [catalog, setCatalog] = useState(null)
      const [choice, setChoice] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      useEffect(() => {
        let cancelled = false
        setFolders([])
        setCatalog(null)
        setChoice('')
        setError(null)
        if (instanceId === '') return () => { cancelled = true }
        void (async () => {
          try {
            const value = await apiGet(`fleet/folders?instanceId=${encodeURIComponent(instanceId)}`)
            if (!cancelled && value.ok) setFolders(value.folders ?? [])
          } catch { /* suggestions only */ }
          try {
            const value = await apiGet(`fleet/models?instanceId=${encodeURIComponent(instanceId)}`)
            if (cancelled) return
            if (value.ok) {
              setCatalog(value)
              const selection = value.default
              if (selection !== null && selection !== undefined) setChoice(`${selection.provider}::${selection.model}`)
            } else {
              setError(value.error ?? tr('launchNoModel'))
            }
          } catch (failure) {
            if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure))
          }
        })()
        return () => { cancelled = true }
      }, [instanceId, tr])

      const options = []
      for (const group of catalog?.groups ?? []) {
        for (const model of group.models ?? []) options.push({ value: `${group.id}::${model.id}`, label: `${group.name} · ${model.name}` })
      }

      const submit = async () => {
        setBusy(true)
        setError(null)
        try {
          const [provider, model] = choice === '' ? ['', ''] : choice.split('::')
          const result = await apiPost('fleet/launch', {
            instanceId,
            cwd: folder.trim(),
            provider,
            model,
          })
          if (!result.ok) throw new Error(result.error ?? 'launch failed')
          await onLaunched(instanceId, result.sessionId)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'dsf-modal' },
        h('div', { className: 'dsf-dialog' },
          h('h3', null, tr('launchSession')),
          h('label', { className: 'dsf-launch-row' }, tr('launchDevice'),
            h('select', { value: instanceId, onChange: (event) => setInstanceId(event.target.value) },
              candidates.map((instance) => h('option', { key: instance.id, value: instance.id }, instance.name || instance.id)))),
          h('label', { className: 'dsf-launch-row' }, tr('launchFolder'),
            h('input', {
              className: 'dsf-input',
              list: 'dsf-folder-options',
              value: folder,
              placeholder: tr('launchFolderPlaceholder'),
              onChange: (event) => setFolder(event.target.value),
            }),
            h('datalist', { id: 'dsf-folder-options' }, folders.map((item) => h('option', { key: item, value: item })))),
          h('label', { className: 'dsf-launch-row' }, tr('launchModel'),
            h('select', { value: choice, onChange: (event) => setChoice(event.target.value), disabled: options.length === 0 },
              options.length === 0 ? h('option', { value: '' }, '—') : null,
              options.map((option) => h('option', { key: option.value, value: option.value }, option.label)))),
          error !== null ? h('div', { className: 'dsf-err' }, error) : null,
          h('div', { className: 'dsf-row' },
            h('button', { className: 'dsf-btn', onClick: onClose }, tr('authCancel')),
            h('button', { className: 'dsf-btn primary', disabled: busy || instanceId === '', onClick: () => void submit() }, busy ? tr('launchBusy') : tr('launchConfirm')))))
    }

    function InstanceDialog({ tr, onClose, onSaved }) {
      const [config, setConfig] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      useEffect(() => {
        void apiGet('fleet/config').then((value) => setConfig({
          instances: Array.isArray(value.instances) ? value.instances : [],
          agentKey: value.agentKey ?? '',
          roles: value.roles ?? ['master'],
        })).catch((failure) => setError(String(failure)))
      }, [])
      const draft = config ?? { instances: [], agentKey: '', roles: ['master'] }
      const add = () => {
        setConfig({
          ...draft,
          instances: [...draft.instances, {
            id: `host${draft.instances.length + 1}`,
            name: '',
            dshUrl: '',
            panelUrl: '',
            ssh: '',
            tokenLogPath: '~/.dsh/dsh-web.log',
            dshPort: 0,
            panelPort: 0,
            agentUrl: '',
            enabled: true,
          }],
        })
      }
      const save = async () => {
        setBusy(true)
        setError(null)
        try {
          await apiPut('fleet/config', {
            instances: draft.instances,
            agentKey: draft.agentKey,
            roles: draft.roles,
            pollMs: draft.pollMs,
            portBase: draft.portBase,
            panelLocalUrl: draft.panelLocalUrl,
          })
          await onSaved()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'dsf-modal' },
        h('div', { className: 'dsf-dialog' },
          h('h3', null, tr('addInstance')),
          h('p', { className: 'dsf-hint' }, tr('settingsHint')),
          config === null ? h('div', { className: 'dsf-hint' }, '…') : h(InstancesEditor, { tr, draft, setDraft: setConfig }),
          error ? h('div', { className: 'dsf-err' }, error) : null,
          h('div', { className: 'dsf-row' },
            h('button', { className: 'dsf-btn', onClick: add }, tr('add')),
            h('button', { className: 'dsf-btn primary', style: { marginLeft: 'auto' }, disabled: busy, onClick: () => void save() }, busy ? tr('saving') : tr('save')),
            h('button', { className: 'dsf-btn', onClick: onClose }, tr('authCancel')))))
    }

    function InstancesEditor({ tr, draft, setDraft }) {
      const update = (index, field, value) => {
        const instances = draft.instances.map((instance, position) => (position === index ? { ...instance, [field]: value } : instance))
        setDraft({ ...draft, instances })
      }
      return h('div', null,
        draft.instances.map((instance, index) => h('div', { className: 'dsf-inst', key: index },
          h('div', { className: 'dsf-grid' },
            h('label', { className: 'dsf-field' }, tr('idLabel'),
              h('input', { className: 'dsf-input', value: instance.id ?? '', onChange: (event) => update(index, 'id', event.target.value) })),
            h('label', { className: 'dsf-field' }, tr('name'),
              h('input', { className: 'dsf-input', value: instance.name ?? '', onChange: (event) => update(index, 'name', event.target.value) })),
            h('label', { className: 'dsf-field' }, tr('dshUrl'),
              h('input', { className: 'dsf-input', value: instance.dshUrl ?? '', placeholder: 'http://192.0.2.10:3080', onChange: (event) => update(index, 'dshUrl', event.target.value) })),
            h('label', { className: 'dsf-field' }, tr('panelUrl'),
              h('input', { className: 'dsf-input', value: instance.panelUrl ?? '', placeholder: 'http://192.0.2.10:40005', onChange: (event) => update(index, 'panelUrl', event.target.value) })),
            h('label', { className: 'dsf-field' }, tr('ssh'),
              h('input', { className: 'dsf-input', value: instance.ssh ?? '', placeholder: 'user@192.0.2.10', onChange: (event) => update(index, 'ssh', event.target.value) })),
            h('label', { className: 'dsf-field' }, tr('tokenLogPath'),
              h('input', { className: 'dsf-input', value: instance.tokenLogPath ?? '', onChange: (event) => update(index, 'tokenLogPath', event.target.value) })),
            h('label', { className: 'dsf-field' }, tr('agentUrl'),
              h('input', { className: 'dsf-input', value: instance.agentUrl ?? '', placeholder: 'http://192.0.2.10:3080/fleet-agent', onChange: (event) => update(index, 'agentUrl', event.target.value) })),
            h('label', { className: 'dsf-field' }, tr('dshPort'),
              h('input', { className: 'dsf-input', value: String(instance.dshPort ?? 0), onChange: (event) => update(index, 'dshPort', Number(event.target.value) || 0) })),
            h('label', { className: 'dsf-field' }, tr('panelPort'),
              h('input', { className: 'dsf-input', value: String(instance.panelPort ?? 0), onChange: (event) => update(index, 'panelPort', Number(event.target.value) || 0) }))),
          h('div', { className: 'dsf-row' },
            h('label', { className: 'dsf-field', style: { flexDirection: 'row', alignItems: 'center', gap: '6px' } },
              h('input', { type: 'checkbox', checked: instance.enabled !== false, onChange: (event) => update(index, 'enabled', event.target.checked) }),
              tr('enabled')),
            h('button', {
              className: 'dsf-btn',
              onClick: () => setDraft({ ...draft, instances: draft.instances.filter((_, position) => position !== index) }),
            }, tr('remove'))))),
        h('label', { className: 'dsf-field', style: { marginTop: '10px' } }, tr('agentKey'),
          h('input', { className: 'dsf-input', value: draft.agentKey ?? '', onChange: (event) => setDraft({ ...draft, agentKey: event.target.value }) })),
        h('div', { className: 'dsf-grid', style: { marginTop: '10px' } },
          h('label', { className: 'dsf-field' }, tr('pollMs'),
            h('input', { className: 'dsf-input', value: String(draft.pollMs ?? 5000), onChange: (event) => setDraft({ ...draft, pollMs: Number(event.target.value) || 5000 }) })),
          h('label', { className: 'dsf-field' }, tr('portBase'),
            h('input', { className: 'dsf-input', value: String(draft.portBase ?? 37800), onChange: (event) => setDraft({ ...draft, portBase: Number(event.target.value) || 37800 }) })),
          h('label', { className: 'dsf-field' }, tr('panelLocalUrl'),
            h('input', { className: 'dsf-input', value: draft.panelLocalUrl ?? '', onChange: (event) => setDraft({ ...draft, panelLocalUrl: event.target.value }) }))))
    }

    function SettingsSection() {
      const tr = useTr()
      const [draft, setDraft] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [saved, setSaved] = useState(null)
      const load = useCallback(async () => {
        try {
          const value = await apiGet('fleet/config')
          setDraft({
            instances: Array.isArray(value.instances) ? value.instances : [],
            agentKey: value.agentKey ?? '',
            roles: value.roles ?? ['master'],
            pollMs: value.pollMs ?? 5000,
            portBase: value.portBase ?? 37800,
            panelLocalUrl: value.panelLocalUrl ?? 'http://127.0.0.1:40005',
          })
          setError(null)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])
      useEffect(() => { void load() }, [load])
      const save = async () => {
        if (draft === null) return
        setBusy(true)
        setSaved(null)
        try {
          await apiPut('fleet/config', {
            instances: draft.instances,
            agentKey: draft.agentKey,
            roles: draft.roles,
            pollMs: draft.pollMs,
            portBase: draft.portBase,
            panelLocalUrl: draft.panelLocalUrl,
          })
          setSaved('ok')
          await load()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setSaved('fail')
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'dsf-settings' },
        h('h2', null, tr('settings')),
        h('p', { className: 'dsf-hint' }, tr('settingsHint')),
        error ? h('div', { className: 'dsf-err' }, error) : null,
        draft === null ? h('div', { className: 'dsf-hint' }, '…') : h('div', null,
          h(InstancesEditor, { tr, draft, setDraft }),
          h('div', { className: 'dsf-row' },
            h('button', { className: 'dsf-btn', onClick: () => setDraft({ ...draft, instances: [...draft.instances, { id: `host${draft.instances.length + 1}`, name: '', dshUrl: '', panelUrl: '', ssh: '', tokenLogPath: '~/.dsh/dsh-web.log', dshPort: 0, panelPort: 0, agentUrl: '', enabled: true }] }) }, tr('add')),
            h('button', { className: 'dsf-btn primary', style: { marginLeft: 'auto' }, disabled: busy, onClick: () => void save() }, busy ? tr('saving') : tr('save')),
            saved === 'ok' ? h('span', { className: 'dsf-status' }, tr('saved')) : null,
            saved === 'fail' ? h('span', { className: 'dsf-status' }, tr('saveFailed')) : null)))
    }

    // Context handle captured by apply(); component bodies only read it.
    /**
     * Agent-side viewer bridge: inside the master's viewer iframe this accepts
     * session-navigation messages, so switching sessions reuses one booted
     * remote app instead of reloading an iframe per session.
     */
    function installViewerBridge(ctx) {
      const parentOrigin = (() => {
        try { return new URL(document.referrer).origin } catch { return null }
      })()
      const post = (message) => {
        try {
          window.parent.postMessage(message, parentOrigin === null ? '*' : parentOrigin)
        } catch {
          // Detached frame.
        }
      }
      const onMessage = (event) => {
        if (event.source !== window.parent) return
        if (parentOrigin !== null && event.origin !== parentOrigin) return
        const data = event.data
        if (data === null || typeof data !== 'object' || data.type !== 'dshf:open-session') return
        if (typeof data.sessionId !== 'string' || data.sessionId === '') return
        const workspace = ctx.get('uiWorkspace')
        if (workspace === undefined || typeof workspace.openSession !== 'function') {
          post({ type: 'dshf:error', message: 'uiWorkspace unavailable' })
          return
        }
        try {
          workspace.openSession(data.sessionId)
          post({ type: 'dshf:ack', sessionId: data.sessionId })
        } catch (error) {
          post({ type: 'dshf:error', message: error instanceof Error ? error.message : String(error) })
        }
      }
      window.addEventListener('message', onMessage)
      window.__dshFleetBridge = 'v1'
      post({ type: 'dshf:ready' })
      const timers = [
        setTimeout(() => post({ type: 'dshf:ready' }), 1200),
        setTimeout(() => post({ type: 'dshf:ready' }), 4000),
      ]
      return () => {
        for (const timer of timers) clearTimeout(timer)
        window.removeEventListener('message', onMessage)
      }
    }

    const trContext = { ctx: null }

    function useTr() {
      const ctxRef = useRef(null)
      if (ctxRef.current === null) ctxRef.current = trContext.ctx
      return useCallback((key) => {
        const ctx = trContext.ctx
        if (ctx === null) return key
        try {
          return ctx.locale.bind(NS)(key)
        } catch {
          return key
        }
      }, [])
    }

    /**
     * Background preload: while the page is visible the master keeps the panel's
     * data warm (status every 25s, overview per minute, last selected instance's
     * session list once), so opening the panel never starts from a blank state.
     */
    function startWarmLoop() {
      let stopped = false
      let timer = null
      const tick = async () => {
        if (stopped) return
        const hidden = typeof document !== 'undefined' && document.hidden
        if (!hidden) {
          try {
            warmCache.status = await apiGet('fleet/status')
            if (Date.now() - warmCache.overviewAt > 60000) {
              warmCache.overview = await apiGet('fleet/overview')
              warmCache.overviewAt = Date.now()
            }
            // Prefetch one instance's session list per tick until every instance
            // has a warm copy (ordered by the selected one first).
            let selectedId = null
            try { selectedId = localStorage.getItem('dsh-fleet.selectedId') } catch { selectedId = null }
            const candidates = []
            if (selectedId !== null) candidates.push(selectedId)
            const statusInstances = Array.isArray(warmCache.status?.instances) ? warmCache.status.instances : []
            for (const instance of statusInstances) if (!candidates.includes(instance.id)) candidates.push(instance.id)
            warmCache.aggregate = await apiGet('fleet/aggregate?titled=1')
            for (const id of candidates.slice(0, 6)) {
              if (warmCache.sessions.has(id)) continue
              const value = await apiGet(`fleet/sessions?instanceId=${encodeURIComponent(id)}&titled=1`)
              if (value.ok) warmCache.sessions.set(id, value.sessions)
            }
          } catch {
            // Preloading is best-effort; the panel fetches on open anyway.
          }
        }
        if (!stopped) timer = setTimeout(() => { void tick() }, 25000)
      }
      timer = setTimeout(() => { void tick() }, 1500)
      return () => {
        stopped = true
        if (timer !== null) clearTimeout(timer)
      }
    }

    /** Register the master-only panel entries; returns one combined disposer. */
    function registerFleetUi(ctx) {
      const disposers = [
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'fleet',
          order: 30,
          label: () => {
            try { return ctx.locale.bind(NS)('panel') } catch { return 'Fleet' }
          },
        }, FleetIcon)),
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'fleet',
        }, Panel)),
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'fleet',
          order: 60,
          label: () => {
            try { return ctx.locale.bind(NS)('settings') } catch { return 'Fleet instances' }
          },
        }, SettingsSection)),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    }

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply(ctx) {
        trContext.ctx = ctx
        ctx.effect(() => {
          const style = document.createElement('style')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        })
        for (const locale of ['zh', 'en']) {
          ctx.effect(() => ctx.locale.register(NS, locale, DICT[locale]))
        }
        // Inside a viewer iframe: accept session-navigation messages so the
        // remote app boots once and later picks switch sessions in place.
        if (typeof window !== 'undefined' && window.parent !== window) {
          ctx.effect(() => {
            try {
              return installViewerBridge(ctx)
            } catch (error) {
              console.error('[dsh-fleet] viewer bridge failed', error)
              return undefined
            }
          })
        }
        // `?dshfCollapse=1` collapses the remote sidebar through the app's own
        // layout action (never by injecting styles). Detection uses the control's
        // semantic aria-label, so a renamed CSS module cannot break it.
        if (typeof window !== 'undefined') {
          const collapseRequested = new URLSearchParams(location.search).get('dshfCollapse') === '1'
          if (collapseRequested) {
            ctx.effect(() => {
              let cancelled = false
              let tries = 0
              const sidebarExpanded = () => {
                const control = Array.from(document.querySelectorAll('button, [role="button"]'))
                  .find((element) => /collapse\s+sidebar|收起侧边栏/i.test(element.getAttribute('aria-label') ?? ''))
                if (control !== undefined) return true
                const column = document.querySelector('[class*="sidebarCol"]')
                return column !== null && column.getBoundingClientRect().width > 120
              }
              const stripParam = () => {
                const url = new URL(location.href)
                url.searchParams.delete('dshfCollapse')
                history.replaceState(null, '', url.pathname + url.search + url.hash)
              }
              const run = () => {
                if (cancelled) return
                const layout = ctx.get('layout')
                if (layout !== undefined && typeof layout.toggleSidebar === 'function') {
                  if (sidebarExpanded()) {
                    try { layout.toggleSidebar() } catch { if (tries < 20) { tries += 1; setTimeout(run, 400) } return }
                  }
                  stripParam()
                  return
                }
                if (tries < 20) { tries += 1; setTimeout(run, 400) }
              }
              setTimeout(run, 900)
              return () => { cancelled = true }
            })
          }
        }
        // `?dshfSession=<id>` lets a plain tab open straight at one remote
        // session: the master's session rail links here. Runs in any role.
        if (typeof window !== 'undefined') {
          ctx.effect(() => {
            let cancelled = false
            let tries = 0
            const target = new URLSearchParams(location.search).get('dshfSession')
            if (target === null || target === '') return () => { cancelled = true }
            const tryOpen = () => {
              if (cancelled) return
              const workspace = ctx.get('uiWorkspace')
              if (workspace === undefined || typeof workspace.openSession !== 'function') {
                if (tries < 40) { tries += 1; setTimeout(tryOpen, 500) }
                return
              }
              try {
                workspace.openSession(target)
                const url = new URL(location.href)
                url.searchParams.delete('dshfSession')
                history.replaceState(null, '', url.pathname + url.search + url.hash)
              } catch {
                // The remote Client lists sessions asynchronously after boot.
                if (tries < 40) { tries += 1; setTimeout(tryOpen, 500) }
              }
            }
            setTimeout(tryOpen, 800)
            return () => { cancelled = true }
          })
        }
        // Only a master renders the panel; agent hosts keep their UI untouched.
        ctx.effect(() => {
          let dispose = null
          let cancelled = false
          void (async () => {
            let isMaster = false
            try {
              const config = await apiGet('fleet/config')
              const roles = Array.isArray(config?.roles) ? config.roles : []
              isMaster = roles.includes('master') || (roles.length === 0 && (config?.role ?? 'master') === 'master')
            } catch {
              isMaster = false
            }
            if (cancelled || !isMaster) return
            ctx.effect(() => startWarmLoop())
            dispose = registerFleetUi(ctx)
          })()
          return () => {
            cancelled = true
            if (dispose !== null) dispose()
          }
        })
      },
    }
  },
})
