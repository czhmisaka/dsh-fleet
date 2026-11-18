/**
 * dsh-fleet host half.
 *
 * `role: master` owns the instance registry, remote credentials, one loopback
 * proxy per instance (DSH UI on `port`, :40005 dashboard on `port + 1`), the
 * `/fleet/*` JSON routes, and the optional SSH token refresh.
 * `role: agent` exposes `/fleet-agent/*` on its own DSH web so a master can read
 * this host's info, session summary, and local dashboard status.
 *
 * Remote cookies never leave this process: the browser only receives loopback
 * proxy URLs carrying a per-process access key.
 * @module dsh-fleet
 */

import z from '@deepseek-ai/schemastery'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { startProxy } from './host/proxy.js'
import {
  agentCall, callRemote, exchangeToken, fetchTokenViaSsh, normalizePanel, panelRaw, panelStatus,
  probeInstance, remoteSessions,
} from './host/remote.js'

export const name = 'dsh-fleet'

/** Host services used by both roles. */
export const inject = ['webServer', 'connection', 'settings', 'credentials', 'timer']

/** Whether a session carries a human title (subagent sessions may only have a label). */
function sessionHasTitle(item) {
  const title = typeof item?.projections?.values?.title === 'string' ? item.projections.values.title.trim() : ''
  if (title !== '') return true
  const label = typeof item?.projections?.values?.subagent?.label === 'string' ? item.projections.values.subagent.label.trim() : ''
  return label !== ''
}

const NS = 'dsh-fleet'
const DEFAULT_INSTANCES = []

// Inner fields stay non-volatile: only a fixed top-level path may be volatile,
// so the whole `instances` array is the live unit (one settings write replaces it).
const instanceSchema = z.object({
  id: z.string().required(),
  name: z.string().default(''),
  dshUrl: z.string().required(),
  panelUrl: z.string().default(''),
  ssh: z.string().default(''),
  tokenLogPath: z.string().default('~/.dsh/dsh-web.log'),
  dshPort: z.natural().default(0),
  panelPort: z.natural().default(0),
  agentUrl: z.string().default(''),
  enabled: z.boolean().default(true),
})

/** Durable fleet configuration; every field is live so edits need no restart. */
export const Config = z.object({
  role: z.union(['master', 'agent']).default('master').volatile(),
  roles: z.array(z.union(['master', 'agent'])).default(['master']).volatile(),
  instances: z.array(instanceSchema).default(DEFAULT_INSTANCES).volatile(),
  agentKey: z.string().default('').volatile(),
  pollMs: z.natural().default(5000).volatile(),
  portBase: z.natural().default(37800).volatile(),
  panelLocalUrl: z.string().default('http://127.0.0.1:40005').volatile(),
})

/** Bind the fleet runtime to the plugin fiber. */
export function apply(ctx, config) {
  const fleet = new Fleet(ctx, config)
  // This plugin renders its own settings page; suppress the provider's auto page.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
  })
  ctx.effect(() => fleet.start())
}

class Fleet {
  constructor(ctx, config) {
    this.ctx = ctx
    // The Loader may hand the plugin the Config Schema instead of validated
    // values while an entry is being (re)activated; keep only plain values.
    const plain = config !== null && typeof config === 'object'
      && (typeof config.role === 'string' || Array.isArray(config.instances))
    this.baseConfig = plain ? config : {}
    this.runtimes = new Map()
    this.sessionsCache = new Map()
    this.sessionsFullCache = new Map()
    this.everRefreshed = false
    this.lastClientAt = 0
    this.lastReconcileAt = 0
    this.appliedPollMs = 0
    this.agentSessionsCache = null
    this.ns = NS
    this.config = this.baseConfig
    this.started = false
    this.stopping = false
    this.healthTimer = null
    this.configTimer = null
    this.healthBusy = false
    this.lastStatusAt = 0
  }

  /** Read the live settings value for this entry (falls back to the boot config). */
  readSettings() {
    try {
      const descriptors = this.ctx.settings.describe()
      const found = descriptors.find((entry) => String(entry.ns) === this.ns)
      if (found !== undefined && found.value !== undefined && found.value !== null) {
        return { ...this.baseConfig, ...found.value }
      }
    } catch (error) {
      this.log(`settings.describe failed: ${macMessage(error)}`)
    }
    return this.baseConfig
  }

  start() {
    this.started = true
    this.config = this.readSettings()
    this.log(`start: role=${String(this.config.role)} roles=${JSON.stringify(this.config.roles ?? null)} instances=${Array.isArray(this.config.instances) ? this.config.instances.length : 'none'}`)
    const disposers = []
    const run = async () => {
      try {
        this.config = this.readSettings()
        if (this.masterEnabled()) await this.reconcile()
        else this.log('agent-only mode: master proxies stay off')
        if (this.masterEnabled()) this.log('master mode: proxies and panel active')
        this.appliedPollMs = Math.max(2000, Number(this.config.pollMs) || 5000)
        this.healthTimer = setInterval(() => { void this.healthTick() }, this.appliedPollMs)
        this.configTimer = setInterval(() => { void this.configTick() }, 2500)
        if (this.masterEnabled()) void this.healthTick()
        // Settings may not be readable during activation; retry briefly.
        for (let attempt = 0; attempt < 5 && this.masterEnabled() && this.runtimes.size === 0; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1500))
          await this.ensureRuntimes()
        }
      } catch (error) {
        this.log(`start failed: ${macMessage(error)}`)
      }
    }
    void run()
    disposers.push(() => this.stop())
    this.registerRoutes()
    return () => {
      for (const dispose of disposers) dispose()
    }
  }

  /** Re-create runtimes when the registry has entries but none are running. */
  async ensureRuntimes() {
    if (this.stopping || !this.masterEnabled()) return
    const config = this.readSettings()
    const declared = Array.isArray(config.instances) ? config.instances.filter((item) => item.enabled !== false && typeof item?.id === 'string' && typeof item?.dshUrl === 'string') : []
    if (declared.length === 0) return
    if (declared.every((item) => this.runtimes.has(item.id))) return
    // A failed instance (port conflict, bad URL) is retried at most every 10s.
    if (Date.now() - this.lastReconcileAt < 10000) return
    this.config = config
    await this.reconcile()
  }

  async stop() {
    this.stopping = true
    if (this.healthTimer !== null) clearInterval(this.healthTimer)
    if (this.configTimer !== null) clearInterval(this.configTimer)
    this.healthTimer = null
    this.configTimer = null
    for (const runtime of this.runtimes.values()) await runtime.stop()
    this.runtimes.clear()
  }

  log(message) {
    console.error(`[dsh-fleet] ${message}`)
  }

  /** Whether this instance runs the master half (panel, proxies, aggregation). */
  masterEnabled() {
    const roles = Array.isArray(this.config.roles) ? this.config.roles : []
    // Only an explicit agent-only declaration turns the master half off; a missing
    // or partial role list defaults to master so a settings write cannot strand it.
    if (roles.includes('agent') && !roles.includes('master')) return false
    if (roles.includes('master')) return true
    return typeof this.config.role !== 'string' || this.config.role === 'master'
  }

  /** Reconcile declared instances with running proxy runtimes. */
  reconcile() {
    this.reconcileChain = (this.reconcileChain ?? Promise.resolve())
      .then(() => this.reconcileOnce())
      .catch((error) => this.log(`reconcile failed: ${macMessage(error)}`))
    return this.reconcileChain
  }

  async reconcileOnce() {
    if (this.stopping) return
    this.lastReconcileAt = Date.now()
    if (!this.masterEnabled()) {
      for (const runtime of this.runtimes.values()) await runtime.stop()
      this.runtimes.clear()
      return
    }
    const config = this.readSettings()
    this.config = config
    const declared = new Map()
    const instances = Array.isArray(config.instances) ? config.instances : []
    for (const [index, instance] of instances.entries()) {
      if (instance.enabled === false) continue
      if (typeof instance.id !== 'string' || instance.id === '' || typeof instance.dshUrl !== 'string') continue
      declared.set(instance.id, { instance, index })
    }
    for (const [id, runtime] of [...this.runtimes.entries()]) {
      if (!declared.has(id) || runtime.signature !== this.signature(declared.get(id).instance)) {
        this.runtimes.delete(id)
        await runtime.stop()
        this.sessionsFullCache.delete(id)
        for (const key of [...this.sessionsCache.keys()]) if (key.startsWith(`${id}|`)) this.sessionsCache.delete(key)
        this.log(`stopped proxy for ${id}`)
      }
    }
    for (const [id, { instance, index }] of declared) {
      if (this.runtimes.has(id)) {
        this.runtimes.get(id).instance = instance
        continue
      }
      try {
        const runtime = await this.createRuntime(instance, index)
        this.runtimes.set(id, runtime)
        this.log(`proxy ready for ${id}: ${runtime.dshProxy?.url ?? 'no dsh url'}`)
      } catch (error) {
        this.log(`failed to start ${id}: ${macMessage(error)}`)
      }
    }
  }

  signature(instance) {
    return JSON.stringify([instance.dshUrl, instance.panelUrl, instance.dshPort, instance.panelPort, Number(this.config.portBase) || 0])
  }

  async createRuntime(instance, index) {
    const id = instance.id
    const state = {
      instance,
      signature: this.signature(instance),
      dshProxy: null,
      panelProxy: null,
      cookie: '',
      cookieExpiresAt: 0,
      authError: null,
      online: false,
      authed: false,
      latencyMs: null,
      error: null,
      sessions: null,
      agent: { ok: false },
      panel: null,
      panelError: null,
    }
    const stored = await this.readRecord(id)
    if (stored !== null) {
      state.cookie = stored.cookie
      state.cookieExpiresAt = stored.expiresAt ?? 0
    }
    const key = randomBytes(18).toString('base64url')
    state.key = key
    const portBase = Number(this.config.portBase) || 37800
    const dshPort = Number(instance.dshPort) > 0 ? Number(instance.dshPort) : portBase + index * 2
    const panelPort = Number(instance.panelPort) > 0 ? Number(instance.panelPort) : dshPort + 1
    try {
      state.dshProxy = await startProxy({
        id,
        port: dshPort,
        upstreamUrl: instance.dshUrl,
        key,
        getCookie: () => state.cookie,
        label: `${id}:dsh`,
      })
    } catch (error) {
      this.log(`dsh proxy for ${id} failed on ${dshPort}: ${macMessage(error)}`)
      state.dshProxy = await startProxy({
        id, port: 0, upstreamUrl: instance.dshUrl, key, getCookie: () => state.cookie, label: `${id}:dsh`,
      })
    }
    if (typeof instance.panelUrl === 'string' && instance.panelUrl !== '') {
      try {
        state.panelProxy = await startProxy({
          id: `${id}-panel`,
          port: panelPort,
          upstreamUrl: instance.panelUrl,
          key,
          getCookie: () => '',
          label: `${id}:panel`,
        })
      } catch (error) {
        this.log(`panel proxy for ${id} failed: ${macMessage(error)}`)
      }
    }
    return {
      get instance() { return state.instance },
      set instance(value) { state.instance = value },
      get signature() { return state.signature },
      dshProxy: state.dshProxy,
      panelProxy: state.panelProxy,
      state,
      async stop() {
        await state.dshProxy?.close()
        await state.panelProxy?.close()
        state.dshProxy = null
        state.panelProxy = null
      },
    }
  }

  /** Full session list of one instance, cached for 30s (agent fallback when no cookie). */
  async fullSessions(runtime) {
    const id = runtime.state.instance.id
    const cached = this.sessionsFullCache.get(id)
    if (cached !== undefined && Date.now() - cached.at < 30000) return cached.items
    const state = runtime.state
    if (!state.authed) {
      if (state.agent?.ok === true && this.config.agentKey) {
        const wrapper = await agentCall(state.instance.agentUrl, this.config.agentKey, 'sessions', 6000)
        const items = Array.isArray(wrapper?.items) ? wrapper.items : []
        this.sessionsFullCache.set(id, { at: Date.now(), items })
        return items
      }
      throw new Error('not authorized')
    }
    const value = await callRemote(state.instance.dshUrl, state.cookie, 'session/list', { _request: {} })
    const items = Array.isArray(value?.items) ? value.items : []
    this.sessionsFullCache.set(id, { at: Date.now(), items })
    return items
  }

  recordKey(id) {
    return `${this.ns}/${id}`
  }

  async readRecord(id) {
    try {
      const record = await this.ctx.credentials.readRecord(this.recordKey(id))
      if (record === undefined || record === null) return null
      if (record.kind !== 'grant') return null
      const payload = record.payload ?? {}
      if (typeof payload.cookie !== 'string' || payload.cookie === '') return null
      return { cookie: payload.cookie, authority: payload.authority, expiresAt: Number(payload.expiresAt) || 0 }
    } catch (error) {
      this.log(`read credential for ${id} failed: ${macMessage(error)}`)
      return null
    }
  }

  async writeRecord(id, value) {
    await this.ctx.credentials.modifyRecord(this.recordKey(id), async () => ({
      kind: 'grant',
      payload: { cookie: value.cookie, authority: value.authority, expiresAt: value.expiresAt },
    }))
  }

  /** Acquire a fresh cookie for one runtime (SSH log token or local log file). */
  async authorize(runtime, explicitToken = '') {
    const instance = runtime.state.instance
    let token = explicitToken
    if (token === '') {
      if (typeof instance.ssh === 'string' && instance.ssh !== '') {
        token = await fetchTokenViaSsh({ ssh: instance.ssh, logPath: instance.tokenLogPath || '~/.dsh/dsh-web.log' })
      } else {
        token = await readLocalToken(instance.tokenLogPath || '~/.dsh/dsh-web.log')
      }
    }
    const exchanged = await exchangeToken(instance.dshUrl, token)
    runtime.state.cookie = exchanged.cookie
    runtime.state.cookieExpiresAt = exchanged.expiresAt
    runtime.state.authError = null
    await this.writeRecord(instance.id, exchanged)
    this.log(`authorized ${instance.id} (cookie valid ~${new Date(exchanged.expiresAt).toISOString().slice(0, 10)})`)
    return exchanged
  }

  async healthTick() {
    if (this.stopping || this.healthBusy || !this.masterEnabled()) return
    // No panel request for a while: stop the steady background polling; the next
    // request refreshes on demand, so the panel still opens with fresh data.
    if (this.lastClientAt !== 0 && Date.now() - this.lastClientAt > 90000) return
    this.healthBusy = true
    try {
      await this.ensureRuntimes()
      await Promise.all([...this.runtimes.values()].map((runtime) => this.refreshRuntime(runtime)))
      this.lastStatusAt = Date.now()
      this.everRefreshed = true
    } finally {
      this.healthBusy = false
    }
  }

  async refreshRuntime(runtime) {
    const state = runtime.state
    const instance = state.instance
    try {
      let probe = await probeInstance(instance.dshUrl, state.cookie)
      state.latencyMs = probe.latencyMs
      if (probe.status === 401) {
        state.authed = false
        // Retrying SSH/log token discovery every tick would hammer the slave when
        // it is down or its log format changed; back off to once per 30s.
        if (state.authAttemptAt === undefined || now - state.authAttemptAt > 30000) {
          state.authAttemptAt = now
          try {
            await this.authorize(runtime)
            probe = await probeInstance(instance.dshUrl, state.cookie)
            state.latencyMs = probe.latencyMs
          } catch (error) {
            state.authError = macMessage(error)
          }
        }
      }
      state.online = probe.status === 200 || (probe.status !== 0 && probe.status < 500 && probe.status !== 401)
      state.authed = probe.status === 200
      state.error = probe.status === 0 ? (probe.error ?? 'unreachable') : null
      if (!state.authed && state.cookieExpiresAt !== 0 && state.cookieExpiresAt < Date.now()) {
        state.cookie = ''
        state.cookieExpiresAt = 0
      }
      // Agent: the preferred data path when the remote runs the agent role.
      // Ping/info change rarely (hostname, version), so cache them for 30s.
      const now = Date.now()
      if (state.agentAt === undefined || now - state.agentAt > 30000) {
        state.agentAt = now
        state.agent = { ok: false }
        if (typeof instance.agentUrl === 'string' && instance.agentUrl !== '' && this.config.agentKey) {
          try {
            const ping = await agentCall(instance.agentUrl, this.config.agentKey, 'ping', 3000)
            state.agent = { ok: ping?.ok === true, ...(await agentCall(instance.agentUrl, this.config.agentKey, 'info', 4000)) }
          } catch (error) {
            state.agent = { ok: false, error: macMessage(error) }
          }
        }
      }
      // Session summary is expensive (a full session list on the remote); refresh
      // it on its own cadence and keep the last good value when a call fails.
      if (state.sessionsAt === undefined || now - state.sessionsAt > 30000) {
        state.sessionsAt = now
        try {
          if (state.agent.ok) {
            state.sessions = await agentCall(instance.agentUrl, this.config.agentKey, 'sessions', 8000)
          } else if (state.authed) {
            state.sessions = await remoteSessions(instance.dshUrl, state.cookie, 6)
          }
        } catch (error) {
          const reason = macMessage(error)
          if (state.sessionsError !== reason || now - (state.sessionsErrorAt ?? 0) > 60000) {
            this.log(`sessions for ${instance.id} failed: ${reason}`)
            state.sessionsError = reason
            state.sessionsErrorAt = now
          }
        }
      }
      // Dashboard: the remote page's /api/status is comparatively expensive, so
      // refresh it every 15s and reuse the previous value between ticks.
      if (typeof instance.panelUrl === 'string' && instance.panelUrl !== '' && (state.panelAt === undefined || now - state.panelAt > 15000)) {
        state.panelAt = now
        try {
          let panel = null
          if (state.agent.ok) {
            try {
              const wrapper = await agentCall(instance.agentUrl, this.config.agentKey, 'panel/status', 5000)
              panel = normalizePanel(wrapper?.status ?? wrapper)
            } catch { panel = null }
          }
          if (panel === null) panel = await panelStatus(instance.panelUrl, 4000)
          state.panel = panel
          state.panelError = null
        } catch (error) {
          state.panelError = macMessage(error)
        }
      }
    } catch (error) {
      state.error = macMessage(error)
      state.online = false
    }
  }

  async configTick() {
    try {
      const next = this.readSettings()
      const previous = this.config
      const changed = JSON.stringify([next.instances, next.agentKey, next.role, next.roles, next.portBase])
        !== JSON.stringify([previous.instances, previous.agentKey, previous.role, previous.roles, previous.portBase])
      const pollChanged = (Number(next.pollMs) || 5000) !== (this.appliedPollMs || 5000)
      this.config = next
      if (changed) await this.reconcile()
      if (pollChanged) {
        const interval = Math.max(2000, Number(next.pollMs) || 5000)
        if (this.healthTimer !== null) clearInterval(this.healthTimer)
        this.healthTimer = setInterval(() => { void this.healthTick() }, interval)
        this.appliedPollMs = interval
        this.log(`poll interval -> ${interval}ms`)
      }
      if ((changed || pollChanged) && this.masterEnabled()) void this.healthTick()
    } catch (error) {
      this.log(`config sync failed: ${macMessage(error)}`)
    }
  }

  statusSnapshot() {
    const instances = [...this.runtimes.values()].map((runtime) => {
      const state = runtime.state
      const instance = state.instance
      return {
        id: instance.id,
        name: instance.name || instance.id,
        enabled: instance.enabled !== false,
        dshUrl: instance.dshUrl,
        panelUrl: instance.panelUrl ?? '',
        ssh: instance.ssh ?? '',
        dshPort: state.dshProxy?.port ?? null,
        panelPort: state.panelProxy?.port ?? null,
        dshProxyUrl: state.dshProxy?.url ?? null,
        panelProxyUrl: state.panelProxy?.url ?? null,
        online: state.online,
        authed: state.authed,
        latencyMs: state.latencyMs,
        cookieExpiresAt: state.cookieExpiresAt || null,
        authError: state.authError,
        error: state.error,
        agent: { ok: state.agent?.ok === true, hostname: state.agent?.hostname ?? null, dshVersion: state.agent?.dshVersion ?? null },
        sessions: state.sessions === null || state.sessions === undefined
          ? null
          : { count: state.sessions.count, running: state.sessions.running },
        panel: state.panel === null ? null : {
          ok: true,
          hostname: state.panel.hostname,
          cpuPct: state.panel.cpuPct,
          memPct: state.panel.memPct,
          gpuCount: state.panel.gpuCount,
        },
        panelError: state.panelError,
      }
    })
    return { ok: true, now: Date.now(), role: this.config.role ?? 'master', instances }
  }

  overviewSnapshot() {
    const machines = [...this.runtimes.values()].map((runtime) => {
      const state = runtime.state
      const instance = state.instance
      return {
        id: instance.id,
        name: instance.name || instance.id,
        online: state.online,
        source: state.agent?.ok === true ? 'agent' : 'direct',
        ...(state.panel === null ? { panelOk: false, error: state.panelError } : { panelOk: true, ...state.panel }),
      }
    })
    return { ok: true, now: Date.now(), machines }
  }

  registerRoutes() {
    const register = (route) => this.ctx.effect(() => this.ctx.webServer.register(route))
    const guard = (req, res) => {
      const rejection = this.ctx.connection.requestRejection(req)
      if (rejection === undefined) return true
      res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return false
    }
    const json = (res, value, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    const refreshIfStale = async () => {
      if (Date.now() - this.lastStatusAt > 2000) await this.healthTick()
    }
    const runtimeOf = (instanceId) => this.runtimes.get(instanceId)

    register({
      kind: 'exact',
      path: '/fleet/models',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const runtime = runtimeOf(url.searchParams.get('instanceId') ?? '')
          if (runtime === undefined) throw new Error('unknown instance')
          if (!runtime.state.authed) throw new Error('instance is not authorized')
          const value = await callRemote(runtime.state.instance.dshUrl, runtime.state.cookie, 'session/modelCatalog', {})
          json(res, {
            ok: true,
            default: value?.default ?? null,
            groups: (Array.isArray(value?.groups) ? value.groups : []).map((group) => ({
              id: group.id,
              name: group.name ?? group.id,
              models: (Array.isArray(group.models) ? group.models : []).map((model) => ({
                id: model.id,
                name: model.name ?? model.id,
              })),
            })),
            failures: (Array.isArray(value?.failures) ? value.failures : []).map((failure) => failure.id),
          })
        } catch (error) {
          json(res, { ok: false, error: macMessage(error) }, 400)
        }
      },
    })
    register({
      kind: 'exact',
      path: '/fleet/folders',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const runtime = runtimeOf(url.searchParams.get('instanceId') ?? '')
          if (runtime === undefined) throw new Error('unknown instance')
          const items = await this.fullSessions(runtime)
          const folders = [...new Set(items.map((item) => item.cwd).filter((cwd) => typeof cwd === 'string' && cwd !== ''))]
          json(res, { ok: true, folders: folders.slice(0, 80) })
        } catch (error) {
          json(res, { ok: false, error: macMessage(error) }, 400)
        }
      },
    })
    register({
      kind: 'exact',
      path: '/fleet/launch',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') { json(res, { ok: false, error: 'method not allowed' }, 405); return }
        try {
          const body = JSON.parse(await readBody(req))
          const runtime = runtimeOf(String(body.instanceId ?? ''))
          if (runtime === undefined) throw new Error('unknown instance')
          if (!runtime.state.authed) throw new Error('instance is not authorized')
          const cwd = typeof body.cwd === 'string' && body.cwd.trim() !== '' ? body.cwd.trim() : undefined
          const created = await callRemote(runtime.state.instance.dshUrl, runtime.state.cookie, 'session/create', { request: cwd === undefined ? {} : { cwd } })
          const sessionId = created?.sessionId
          if (typeof sessionId !== 'string' || sessionId === '') throw new Error('session/create returned no sessionId')
          let modelError = null
          if (typeof body.provider === 'string' && body.provider !== '' && typeof body.model === 'string' && body.model !== '') {
            try {
              await callRemote(runtime.state.instance.dshUrl, runtime.state.cookie, 'session/selectModel', {
                request: {
                  sessionId,
                  provider: body.provider,
                  model: body.model,
                  ...(typeof body.reasoningEffort === 'string' && body.reasoningEffort !== '' ? { reasoningEffort: body.reasoningEffort } : {}),
                },
              })
            } catch (error) {
              modelError = macMessage(error)
            }
          }
          this.sessionsFullCache.delete(runtime.state.instance.id)
          for (const key of [...this.sessionsCache.keys()]) {
            if (key.startsWith(`${runtime.state.instance.id}|`)) this.sessionsCache.delete(key)
          }
          json(res, { ok: true, sessionId, modelError })
        } catch (error) {
          json(res, { ok: false, error: macMessage(error) }, 400)
        }
      },
    })
    register({
      kind: 'exact',
      path: '/fleet/status',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        this.lastClientAt = Date.now()
        try {
          await this.ensureRuntimes()
          if (this.everRefreshed) {
            if (Date.now() - this.lastStatusAt > 2000) void this.healthTick()
            json(res, this.statusSnapshot())
            return
          }
          await refreshIfStale()
          json(res, this.statusSnapshot())
        } catch (error) {
          json(res, { ok: false, error: macMessage(error) }, 500)
        }
      },
    })
    register({
      kind: 'exact',
      path: '/fleet/overview',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        this.lastClientAt = Date.now()
        try {
          await refreshIfStale()
          json(res, this.overviewSnapshot())
        } catch (error) {
          json(res, { ok: false, error: macMessage(error) }, 500)
        }
      },
    })
    register({
      kind: 'exact',
      path: '/fleet/config',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        this.lastClientAt = Date.now()
        if (req.method === 'GET') {
          this.config = this.readSettings()
          json(res, {
            ok: true,
            role: this.config.role ?? 'master',
            roles: this.config.roles ?? ['master'],
            instances: this.config.instances ?? [],
            agentKey: this.config.agentKey ?? '',
            panelLocalUrl: this.config.panelLocalUrl ?? 'http://127.0.0.1:40005',
            pollMs: Number(this.config.pollMs) || 5000,
            portBase: Number(this.config.portBase) || 37800,
          })
          return
        }
        if (req.method !== 'PUT') {
          json(res, { ok: false, error: 'method not allowed' }, 405)
          return
        }
        try {
          const patch = JSON.parse(await readBody(req))
          if (!Array.isArray(patch.instances)) throw new Error('instances must be an array')
          await this.ctx.settings.update(this.ns, {
            instances: patch.instances,
            ...(typeof patch.agentKey === 'string' ? { agentKey: patch.agentKey } : {}),
            ...(Array.isArray(patch.roles) ? { roles: patch.roles } : {}),
            ...(Number(patch.pollMs) >= 2000 ? { pollMs: Number(patch.pollMs) } : {}),
            ...(Number(patch.portBase) > 0 ? { portBase: Number(patch.portBase) } : {}),
            ...(typeof patch.panelLocalUrl === 'string' && patch.panelLocalUrl !== '' ? { panelLocalUrl: patch.panelLocalUrl } : {}),
          })
          this.config = this.readSettings()
          await this.reconcile()
          json(res, { ok: true })
        } catch (error) {
          json(res, { ok: false, error: macMessage(error) }, 400)
        }
      },
    })
    register({
      kind: 'exact',
      path: '/fleet/authorize',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') {
          json(res, { ok: false, error: 'method not allowed' }, 405)
          return
        }
        try {
          const body = JSON.parse(await readBody(req))
          const runtime = this.runtimes.get(body.instanceId)
          if (runtime === undefined) throw new Error(`unknown instance: ${String(body.instanceId)}`)
          const token = extractToken(String(body.token ?? ''))
          if (token === '') throw new Error('token is empty')
          await this.authorize(runtime, token)
          await this.refreshRuntime(runtime)
          json(res, { ok: true, status: this.statusSnapshot() })
        } catch (error) {
          json(res, { ok: false, error: macMessage(error) }, 400)
        }
      },
    })
    register({
      kind: 'exact',
      path: '/fleet/aggregate',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        this.lastClientAt = Date.now()
        if (this.everRefreshed) { if (Date.now() - this.lastStatusAt > 2000) void this.healthTick() }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
        const onlyRunning = url.searchParams.get('running') === '1'
        const includeChildren = url.searchParams.get('children') === '1'
        const titledOnly = url.searchParams.get('titled') === '1'
        const perInstance = await Promise.all([...this.runtimes.values()].map(async (runtime) => {
          const instance = runtime.state.instance
          try {
            const items = await this.fullSessions(runtime)
            return {
              id: instance.id,
              name: instance.name || instance.id,
              online: runtime.state.online,
              sessions: items.map((item) => ({
                sessionId: item.sessionId,
                title: typeof item.projections?.values?.title === 'string' ? item.projections.values.title : '',
                updatedAt: item.updatedAt ?? null,
                cwd: item.cwd ?? null,
                running: item.running === true,
                origin: item.origin ?? null,
                parentSessionId: item.parentSessionId ?? null,
                label: typeof item.projections?.values?.subagent?.label === 'string' ? item.projections.values.subagent.label : null,
              })),
            }
          } catch (error) {
            return { id: instance.id, name: instance.name || instance.id, online: runtime.state.online, error: macMessage(error), sessions: [] }
          }
        }))
        const flattened = perInstance.flatMap((entry) => entry.sessions.map((session) => ({
          ...session,
          instanceId: entry.id,
          instanceName: entry.name,
        })))
        const all = includeChildren ? flattened : flattened.filter((session) => session.origin !== 'subagent')
        const matched = all.filter((session) => {
          if (titledOnly && String(session.title ?? '').trim() === '' && String(session.label ?? '').trim() === '') return false
          if (onlyRunning && session.running !== true) return false
          if (query === '') return true
          return session.title.toLowerCase().includes(query) || String(session.sessionId).toLowerCase().includes(query)
        })
        matched.sort((a, b) => {
          if (a.running !== b.running) return a.running ? -1 : 1
          return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
        })
        json(res, {
          ok: true,
          now: Date.now(),
          total: all.length,
          matched: matched.length,
          running: all.filter((session) => session.running === true).length,
          sessions: matched.slice(0, 300),
          instances: perInstance.map(({ id, name, online, error }) => ({ id, name, online, error })),
        })
      },
    })
    register({
      kind: 'exact',
      path: '/fleet/sessions',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        this.lastClientAt = Date.now()
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const instanceId = url.searchParams.get('instanceId') ?? ''
          const runtime = this.runtimes.get(instanceId)
          if (runtime === undefined) throw new Error(`unknown instance: ${instanceId}`)
          const state = runtime.state
          const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
          const onlyRunning = url.searchParams.get('running') === '1'
          const includeChildren = url.searchParams.get('children') === '1'
          const titledOnly = url.searchParams.get('titled') === '1'
          const cacheKey = `${instanceId}|${query}|${onlyRunning ? '1' : '0'}|${includeChildren ? '1' : '0'}|${titledOnly ? '1' : '0'}`
          const cached = this.sessionsCache.get(cacheKey)
          if (cached !== undefined && Date.now() - cached.at < 10000) {
            json(res, { ok: true, sessions: cached.value })
            return
          }
          let raw
          try {
            raw = await this.fullSessions(runtime)
          } catch (error) {
            if (!state.authed) {
              json(res, { ok: false, error: state.authError ?? 'not authorized' }, 409)
              return
            }
            throw error
          }
          const all = includeChildren ? raw : raw.filter((item) => item.origin !== 'subagent')
          const matched = all.filter((item) => {
            if (titledOnly && !sessionHasTitle(item)) return false
            if (onlyRunning && item.running !== true) return false
            if (query === '') return true
            const title = typeof item.projections?.values?.title === 'string' ? item.projections.values.title.toLowerCase() : ''
            return title.includes(query) || String(item.sessionId).toLowerCase().includes(query)
          })
          const sessionsValue = {
              count: matched.length,
              total: all.length,
              running: all.filter((item) => item.running === true).length,
              items: matched.slice(0, 200).map((item) => ({
                sessionId: item.sessionId,
                title: typeof item.projections?.values?.title === 'string' ? item.projections.values.title : '',
                running: item.running === true,
                updatedAt: item.updatedAt ?? null,
                cwd: item.cwd ?? null,
                origin: item.origin ?? null,
                parentSessionId: item.parentSessionId ?? null,
                label: typeof item.projections?.values?.subagent?.label === 'string' ? item.projections.values.subagent.label : null,
              })),
            }
          this.sessionsCache.set(cacheKey, { at: Date.now(), value: sessionsValue })
          json(res, { ok: true, sessions: sessionsValue })
        } catch (error) {
          json(res, { ok: false, error: macMessage(error) }, 500)
        }
      },
    })
    // Agent role routes: master reads these with the shared key.
    register({
      kind: 'exact',
      path: '/fleet-agent/ping',
      handler: (req, res) => {
        if (!this.agentEnabled()) {
          json(res, { ok: false, error: 'agent role disabled' }, 404)
          return
        }
        json(res, { ok: true, service: 'dsh-fleet', role: 'agent' })
      },
    })
    register({
      kind: 'exact',
      path: '/fleet-agent/info',
      handler: async (req, res) => {
        if (!this.agentAllowed(req, res)) return
        const panel = await this.agentPanel().catch(() => null)
        json(res, {
          ok: true,
          hostname: hostname(),
          dshVersion: await this.dshVersion(),
          fleetVersion: await this.fleetVersion(),
          uptimeS: process.uptime(),
          panelOk: panel !== null,
          panelUrl: this.config.panelLocalUrl ?? 'http://127.0.0.1:40005',
          dshUrl: `http://${req.headers.host ?? '127.0.0.1'}`,
          ts: Date.now(),
        })
      },
    })
    register({
      kind: 'exact',
      path: '/fleet-agent/sessions',
      handler: async (req, res) => {
        if (!this.agentAllowed(req, res)) return
        try {
          const controller = this.ctx.get('sessionController')
          if (controller === undefined || typeof controller.list !== 'function') throw new Error('sessionController unavailable')
          const cache = this.agentSessionsCache
          if (cache === null || Date.now() - cache.at > 15000) {
            const value = await controller.list({}, AbortSignal.timeout(12000))
            const items = Array.isArray(value?.items) ? value.items : []
            this.agentSessionsCache = {
              at: Date.now(),
              count: items.length,
              running: items.filter((item) => item.running === true).length,
              items,
            }
          }
          const cached = this.agentSessionsCache
          json(res, {
            ok: true,
            count: cached.count,
            running: cached.running,
            items: cached.items.slice(0, 200).map((item) => ({
              sessionId: item.sessionId,
              title: typeof item.projections?.values?.title === 'string' ? item.projections.values.title : '',
              running: item.running === true,
              updatedAt: item.updatedAt ?? null,
              cwd: item.cwd ?? null,
              origin: item.origin ?? null,
              parentSessionId: item.parentSessionId ?? null,
              label: typeof item.projections?.values?.subagent?.label === 'string' ? item.projections.values.subagent.label : null,
            })),
          })
        } catch (error) {
          json(res, { ok: false, error: macMessage(error) }, 500)
        }
      },
    })
    register({
      kind: 'exact',
      path: '/fleet-agent/panel/status',
      handler: async (req, res) => {
        if (!this.agentAllowed(req, res)) return
        try {
          const status = await panelRaw(this.config.panelLocalUrl ?? 'http://127.0.0.1:40005', 5000)
          json(res, { ok: true, status })
        } catch (error) {
          json(res, { ok: false, error: macMessage(error) }, 502)
        }
      },
    })
  }

  agentEnabled() {
    const roles = Array.isArray(this.config.roles) ? this.config.roles : []
    return roles.includes('agent') || this.config.role === 'agent'
  }

  agentAllowed(req, res) {
    if (!this.agentEnabled()) {
      json404(res)
      return false
    }
    const key = this.config.agentKey
    if (typeof key !== 'string' || key === '') {
      this.jsonDeny(res, 'agent key not configured')
      return false
    }
    if (req.headers['x-fleet-key'] !== key) {
      this.jsonDeny(res, 'unauthorized')
      return false
    }
    return true
  }

  jsonDeny(res, message) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: false, error: message }))
  }

  async agentPanel() {
    const url = this.config.panelLocalUrl ?? 'http://127.0.0.1:40005'
    return await panelStatus(url, 5000)
  }

  async dshVersion() {
    try {
      const require = createRequire(import.meta.url)
      const path = require.resolve('@deepseek-ai/dsh/package.json')
      const pkg = JSON.parse(await readFile(path, 'utf8'))
      return typeof pkg.version === 'string' ? pkg.version : null
    } catch {
      return null
    }
  }

  async fleetVersion() {
    try {
      const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
      return typeof pkg.version === 'string' ? pkg.version : null
    } catch {
      return null
    }
  }
}

/** Expand a leading `~` and read the token out of a local dsh-web log. */
async function readLocalToken(logPath) {
  const path = logPath.startsWith('~') ? join(homedir(), logPath.slice(1)) : logPath
  const text = await readFile(path, 'utf8')
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /token=([A-Za-z0-9_-]+)/u.exec(lines[index])
    if (match !== null) return match[1]
  }
  throw new Error(`no token in ${path}`)
}

/** Accept a bare token or a URL containing `?token=`. */
function extractToken(value) {
  if (value === '') return ''
  const match = /token=([A-Za-z0-9_-]+)/u.exec(value)
  return match === null ? value.trim() : match[1]
}

/** Read a bounded JSON request body. */
async function readBody(req, limit = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function json404(res) {
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: false, error: 'not found' }))
}

function macMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
