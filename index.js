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
import { randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { startProxy } from './host/proxy.js'
import {
  agentCall, callRemote, contextDetail, contextOverview, exchangeToken, fetchTokenViaSsh, normalizePanel, panelRaw,
  panelStatus, probeInstance, remoteSessions,
} from './host/remote.js'

export const name = 'dsh-fleet'

/** Host services used by both roles. */
export const inject = ['webServer', 'connection', 'settings', 'credentials', 'timer', 'sessionController']

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
  budgetDailyUsd: z.number().default(0),
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
  budgetDailyUsd: z.number().default(0).volatile(),
  budgetWarnPct: z.natural().default(80).volatile(),
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
    this.usageCache = new Map()
    this.usageDaysCache = new Map()
    this.usageBusy = new Set()
    this.usageContextCache = undefined
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

  get assistantDir() {
    return path.join(os.homedir(), '.dsh', 'fleet-assistant')
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
      if (changed) { this.usageCache.clear(); await this.reconcile() }
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
        authed: state.authed,
        latencyMs: state.latencyMs,
        sessions: state.sessions === null || state.sessions === undefined
          ? null
          : { count: state.sessions.count, running: state.sessions.running },
        hasDashboard: typeof instance.panelUrl === 'string' && instance.panelUrl !== '',
        dshVersion: state.agent?.dshVersion ?? null,
        source: state.agent?.ok === true ? 'agent' : 'direct',
        ...(state.panel === null ? { panelOk: false, error: state.panelError } : { panelOk: true, ...state.panel }),
      }
    })
    return { ok: true, now: Date.now(), machines }
  }

  /** Local-midnight range start for the usage view. */
  usageRangeStart(range) {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    const days = range === '7d' ? 7 : range === '30d' ? 30 : 1
    return date.getTime() - (days - 1) * 86400000
  }

  /** Token total of one session-list item (fallback when dsh-context is absent). */
  sessionTokens(item) {
    const usage = item?.projections?.values?.tokenUsage
    if (usage === null || usage === undefined) return 0
    return ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
      .map((key) => (typeof usage[key] === 'number' ? usage[key] : 0))
      .reduce((sum, value) => sum + value, 0)
  }

  /** Fetch usage for one instance; degrades to session/list sums without dsh-context. */
  async fetchInstanceUsage(runtime, range) {
    const instance = runtime.state.instance
    const start = this.usageRangeStart(range)
    const state = runtime.state
    const base = { id: instance.id, name: instance.name || instance.id, online: state.online }
    if (!state.authed) {
      return { ...base, error: state.authError ?? 'not authorized', degraded: false, summary: null, models: [], topSessions: [], days: [] }
    }
    try {
      // dsh-context summary reports lifetime tokens of the sessions active in a
      // range; per-day buckets are the range-accurate source, so fetch them and
      // derive range totals from the buckets below.
      const summaryValue = await contextOverview(instance.dshUrl, state.cookie, {
        part: 'summary',
        scope: { range: { start, end: null }, coverage: 'all' },
      }, 8000)
      const pageValue = await contextOverview(instance.dshUrl, state.cookie, {
        part: 'page',
        scope: { range: { start, end: null }, coverage: 'all' },
        sort: 'tokens',
        page: 0,
      }, 8000)
      const summary = summaryValue?.summary ?? null
      const items = Array.isArray(pageValue?.page?.items) ? pageValue.page.items : []
      const models = new Map()
      for (const item of items) {
        const model = typeof item.model === 'string' && item.model !== '' ? item.model : '—'
        const entry = models.get(model) ?? { model, tokens: 0, sessions: 0, costUsd: null }
        entry.tokens += typeof item.tokens === 'number' ? item.tokens : 0
        entry.sessions += 1
        if (typeof item.costUsd === 'number') entry.costUsd = (entry.costUsd ?? 0) + item.costUsd
        models.set(model, entry)
      }
      const topSessions = items.slice(0, 50).map((item) => ({
        sessionId: item.id,
        title: typeof item.title === 'string' ? item.title : '',
        tokens: typeof item.tokens === 'number' ? item.tokens : 0,
        turns: typeof item.turns === 'number' ? item.turns : 0,
        costUsd: typeof item.costUsd === 'number' ? item.costUsd : null,
        model: typeof item.model === 'string' ? item.model : null,
        contextWindow: typeof item.contextWindow === 'number' ? item.contextWindow : null,
        running: item.running === true,
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : null,
      }))
      let days = []
      const dayCached = this.usageDaysCache.get(instance.id)
      // An empty bucket list usually means dsh-context had not backfilled yet;
      // never trust such a cache, otherwise range totals fall back to lifetime.
      if (dayCached !== undefined && Date.now() - dayCached.at < 300000 && Array.isArray(dayCached.value) && dayCached.value.length > 0) {
        days = dayCached.value
      } else {
        try {
          const dayValue = await contextOverview(instance.dshUrl, state.cookie, { part: 'days', scope: { coverage: 'all' } }, 8000)
          days = (Array.isArray(dayValue?.days) ? dayValue.days : []).map((day) => ({
            key: day.key,
            tokens: typeof day.tokens === 'number' ? day.tokens : 0,
            sessions: typeof day.sessions === 'number' ? day.sessions : 0,
            costUsd: typeof day.costUsd === 'number' ? day.costUsd : null,
          }))
          this.usageDaysCache.set(instance.id, { at: Date.now(), value: days })
        } catch {
          days = dayCached?.value ?? []
        }
      }
      const startDate = new Date(start)
      const startKey = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`
      const rangeDays = days.filter((day) => day.key >= startKey)
      const rangeTokens = rangeDays.reduce((sum, day) => sum + day.tokens, 0)
      const pricedDays = rangeDays.filter((day) => typeof day.costUsd === 'number')
      const costPartial = rangeDays.length > 0 && pricedDays.length < rangeDays.length
      const rangeCost = pricedDays.length > 0 ? pricedDays.reduce((sum, day) => sum + day.costUsd, 0) : null
      const useDays = rangeDays.length > 0
      return {
        ...base,
        error: null,
        degraded: false,
        summary: {
          tokens: useDays ? rangeTokens : (typeof summary?.tokens === 'number' ? summary.tokens : 0),
          costUsd: useDays ? rangeCost : (typeof summary?.costUsd === 'number' ? summary.costUsd : null),
          costPartial: useDays ? costPartial : false,
          cacheHit: typeof summary?.cacheHit === 'string' ? summary.cacheHit : null,
          sessions: typeof summary?.sessions === 'number' ? summary.sessions : items.length,
          turns: typeof summary?.turns === 'number' ? summary.turns : 0,
          coverage: summary?.coverage ?? null,
          pricingReady: summaryValue?.pricingReady === true,
          tokenParts: Array.isArray(summary?.tokenParts) ? summary.tokenParts : [],
        },
        models: [...models.values()].sort((a, b) => b.tokens - a.tokens),
        topSessions,
        days,
      }
    } catch (error) {
      this.log(`usage context for ${instance.id} failed: ${macMessage(error)}`)
      // No dsh-context (or it failed): fall back to session-list token sums.
      try {
        const allSessions = await this.fullSessions(runtime)
        const items = allSessions.filter((item) => typeof item.updatedAt !== 'number' || item.updatedAt >= start)
        const models = new Map()
        let tokens = 0
        for (const item of items) {
          const value = this.sessionTokens(item)
          tokens += value
          const model = item?.projections?.values?.modelSelection?.lastUsed?.model
          if (typeof model === 'string' && model !== '') {
            const entry = models.get(model) ?? { model, tokens: 0, sessions: 0, costUsd: null }
            entry.tokens += value
            entry.sessions += 1
            models.set(model, entry)
          }
        }
        const topSessions = items
          .map((item) => ({
            sessionId: item.sessionId,
            title: typeof item.projections?.values?.title === 'string' ? item.projections.values.title : '',
            tokens: this.sessionTokens(item),
            turns: 0,
            costUsd: null,
            model: item?.projections?.values?.modelSelection?.lastUsed?.model ?? null,
            contextWindow: null,
            running: item.running === true,
            updatedAt: item.updatedAt ?? null,
          }))
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 50)
        return {
          ...base,
          error: null,
          degraded: true,
          degradedReason: macMessage(error),
          summary: { tokens, costUsd: null, cacheHit: null, sessions: items.length, turns: 0, coverage: null, pricingReady: false, tokenParts: [] },
          models: [...models.values()].sort((a, b) => b.tokens - a.tokens),
          topSessions,
          days: [],
        }
      } catch (fallbackError) {
        return { ...base, error: macMessage(fallbackError), degraded: true, summary: null, models: [], topSessions: [], days: [] }
      }
    }
  }

  /** Refresh the usage aggregate for one range (per-instance failures stay isolated). */
  async refreshUsage(range) {
    const key = range
    if (this.usageBusy.has(key)) return
    this.usageBusy.add(key)
    try {
      const runtimes = [...this.runtimes.values()]
      const instances = await Promise.all(runtimes.map((runtime) => this.fetchInstanceUsage(runtime, range)))
      let tokens = 0
      let cost = 0
      let priced = true
      let costPartial = false
      let sessions = 0
      let running = 0
      let totalsCost = null
      for (const entry of instances) {
        tokens += entry.summary?.tokens ?? 0
        if (entry.summary?.costPartial === true) costPartial = true
        if (typeof entry.summary?.costUsd === 'number') {
          cost += entry.summary.costUsd
          totalsCost = (totalsCost ?? 0) + entry.summary.costUsd
        } else if (entry.summary !== null) priced = false
        sessions += entry.summary?.sessions ?? 0
        running += entry.topSessions.filter((session) => session.running).length
      }
      const warnPct = Number(this.config.budgetWarnPct) || 80
      const globalBudget = Number(this.config.budgetDailyUsd) || 0
      const warnings = []
      const budgetByInstance = {}
      for (const entry of instances) {
        const configured = entry.id === undefined ? 0 : Number(this.runtimes.get(entry.id)?.state.instance.budgetDailyUsd) || 0
        budgetByInstance[entry.id] = configured
        // Explicit per-instance budgets get their own warning; otherwise the
        // global warning below already covers it (avoids duplicate banners).
        const limit = configured
        if (limit <= 0) continue
        const spent = entry.summary?.costUsd
        if (typeof spent !== 'number') continue
        const pct = Math.round((spent / limit) * 100)
        if (pct >= warnPct) warnings.push({ instanceId: entry.id, name: entry.name, kind: 'budget', spent, limit, pct, exceeded: spent > limit })
      }
      if (globalBudget > 0 && typeof totalsCost === 'number') {
        const pct = Math.round((totalsCost / globalBudget) * 100)
        if (pct >= warnPct) warnings.push({ instanceId: null, name: 'all', kind: 'budget', spent: totalsCost, limit: globalBudget, pct, exceeded: totalsCost > globalBudget })
      }
      const value = {
        ok: true,
        generatedAt: Date.now(),
        range,
        totals: { tokens, costUsd: priced ? cost : null, costPartial, sessions, running, priced, budget: globalBudget > 0 ? { usd: globalBudget, spent: totalsCost, warnPct } : null },
        instances,
        warnings,
      }
      this.usageCache.set(key, { at: Date.now(), value })
    } finally {
      this.usageBusy.delete(key)
    }
  }

  /** Candidate hosts for dispatch: online + authorized, fewest running first, lowest latency. */
  dispatchCandidates() {
    return [...this.runtimes.values()]
      .filter((runtime) => runtime.state.online && runtime.state.authed)
      .map((runtime) => ({
        runtime,
        running: runtime.state.sessions?.running ?? 0,
        latency: runtime.state.latencyMs ?? 9999,
      }))
      .sort((a, b) => a.running - b.running || a.latency - b.latency)
  }

  /** Running (non-subagent) sessions across every host. */
  async runningSessions() {
    const out = []
    for (const runtime of this.runtimes.values()) {
      const instance = runtime.state.instance
      if (!runtime.state.authed) continue
      try {
        const items = await this.fullSessions(runtime)
        for (const item of items) {
          if (item.running !== true || item.origin === 'subagent') continue
          out.push({
            instanceId: instance.id,
            instanceName: instance.name || instance.id,
            sessionId: item.sessionId,
            title: typeof item.projections?.values?.title === 'string' ? item.projections.values.title : '',
            cwd: item.cwd ?? null,
          })
        }
      } catch {
        // A single host failing should not break the assistant.
      }
    }
    return out
  }

  /** Read or create the local control key used by the fleetctl helper. */
  async ensureCtlKey() {
    const file = path.join(this.assistantDir, 'ctl.json')
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      if (typeof parsed.key === 'string' && parsed.key.length >= 32) return parsed.key
    } catch {
      // missing or unreadable: regenerate below
    }
    const key = randomBytes(24).toString('hex')
    await fs.writeFile(file, JSON.stringify({ key }, null, 2), { mode: 0o600 })
    return key
  }

  /** Make sure the dispatcher workspace (AGENTS.md + fleetctl + ctl.json) exists. */
  async ensureAssistantWorkspace() {
    await fs.mkdir(this.assistantDir, { recursive: true })
    const key = await this.ensureCtlKey()
    const port = this.ctx.webServer.port
    if (typeof port !== 'number') throw new Error('webServer is not listening yet')
    const host = this.ctx.webServer.host === '::1' ? '[::1]' : this.ctx.webServer.host
    const ctl = { key, baseUrl: `http://${host}:${port}` }
    await fs.writeFile(path.join(this.assistantDir, 'ctl.json'), JSON.stringify(ctl, null, 2), { mode: 0o600 })

    const agents = [
      '# Fleet 调度员',
      '',
      '你是 dsh-fleet 的调度助手，运行在 master 上。你的职责是理解用户需求，把它拆解成任务，**优先派发给被管理的实例**去执行，并跟踪、汇总、回报。',
      '',
      '## 工具',
      '',
      '在 Bash 里使用本目录的 `./fleetctl`（Node 脚本，自带访问凭据）：',
      '',
      '- `./fleetctl state` 查看所有实例状态',
      '- `./fleetctl running` 查看正在运行的会话',
      '- `./fleetctl sessions [--instance <id>]` 列出会话',
      '- `./fleetctl usage` 查看今日用量',
      '- `./fleetctl dispatch --cwd <目录> [--instance <id>] [--prompt <任务>]` 派发会话（默认选最空闲在线实例）',
      '- `./fleetctl prompt --instance <id> --session <id> --prompt <文本>` 继续/追加指令',
      '- `./fleetctl tail --instance <id> --session <id> [--count 20]` 看会话最近输出',
      '',
      '## 行为准则',
      '',
      '1. 先判断任务适合在哪台实例执行（看 state 的在线/运行中/负载），用 dispatch 下发，而不是在本机直接干活。',
      '2. 用户问“某任务怎么样了”时，用 sessions/tail 查真实状态，不要猜。',
      '3. 回复精简：先说结论，再给设备、会话、耗时、链接要点。',
      '4. 需要更多信息时直接问用户，不要编造。',
      '5. 不要执行破坏性命令；不要改 master 上无关的文件。',
      '',
    ].join('\n')
    await fs.writeFile(path.join(this.assistantDir, 'AGENTS.md'), agents)

    const ctlScript = `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ctl = JSON.parse(readFileSync(join(here, 'ctl.json'), 'utf8'))
const args = process.argv.slice(2)
const command = args.shift() ?? 'state'
const flags = {}
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg.startsWith('--')) {
    const key = arg.slice(2)
    const next = args[index + 1]
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; index += 1 } else { flags[key] = 'true' }
  }
}
async function call(method, route, body) {
  const response = await fetch(ctl.baseUrl + route, {
    method,
    headers: { 'x-fleet-ctl': ctl.key, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let value
  try { value = JSON.parse(text) } catch { value = text }
  if (!response.ok) {
    console.error(JSON.stringify(value, null, 2))
    process.exit(1)
  }
  return value
}
const query = new URLSearchParams()
if (flags.instance) query.set('instanceId', flags.instance)
if (flags.session) query.set('sessionId', flags.session)
if (flags.count) query.set('count', flags.count)
switch (command) {
  case 'state': console.log(JSON.stringify(await call('GET', '/fleet/ctl/state'), null, 2)); break
  case 'running': console.log(JSON.stringify(await call('GET', '/fleet/ctl/running'), null, 2)); break
  case 'sessions': console.log(JSON.stringify(await call('GET', '/fleet/ctl/sessions?' + query.toString()), null, 2)); break
  case 'usage': console.log(JSON.stringify(await call('GET', '/fleet/ctl/usage'), null, 2)); break
  case 'tail': console.log(JSON.stringify(await call('GET', '/fleet/ctl/tail?' + query.toString()), null, 2)); break
  case 'dispatch': console.log(JSON.stringify(await call('POST', '/fleet/ctl/dispatch', { cwd: flags.cwd ?? '', prompt: flags.prompt ?? '', instanceId: flags.instance }), null, 2)); break
  case 'prompt': console.log(JSON.stringify(await call('POST', '/fleet/ctl/prompt', { instanceId: flags.instance, sessionId: flags.session, text: flags.prompt ?? flags.text ?? '' }), null, 2)); break
  default: console.error('unknown command: ' + command); process.exit(2)
}
`
    await fs.writeFile(path.join(this.assistantDir, 'fleetctl'), ctlScript, { mode: 0o755 })
    return key
  }

  /** Reuse or create the dedicated dispatcher session on this master. */
  async ensureAssistantSession(controller) {
    await this.ensureAssistantWorkspace()
    const stateFile = path.join(this.assistantDir, 'session.json')
    try {
      const parsed = JSON.parse(await fs.readFile(stateFile, 'utf8'))
      const listed = await controller.list({}, new AbortController().signal)
      if (typeof parsed.sessionId === 'string' && parsed.sessionId !== '' && (listed.items ?? []).some((item) => item.sessionId === parsed.sessionId)) {
        return parsed.sessionId
      }
    } catch {
      // missing session: create below
    }
    const created = await controller.create({ cwd: this.assistantDir }, new AbortController().signal)
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('assistant session/create returned no sessionId')
    await fs.writeFile(stateFile, JSON.stringify({ sessionId }, null, 2))
    return sessionId
  }

  /** Flatten assistant text parts from one history record. */
  assistantRecordText(record) {
    const event = record?.event ?? record
    if (event?.type !== 'assistant/message') return ''
    const message = event?.data?.message
    const parts = Array.isArray(message?.content) ? message.content : []
    return parts.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('')
  }

  /** Send one message to the dispatcher session and wait for its assistant output. */
  async askDispatcher(message) {
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) throw new Error('sessionController unavailable')
    const sessionId = await this.ensureAssistantSession(controller)
    const signal = new AbortController().signal
    let cursor = 0
    try {
      const page = await controller.page({ address: { kind: 'session', sessionId }, maxMessages: 1 }, signal)
      cursor = Number(page?.cursor) || 0
    } catch {
      cursor = 0
    }
    await controller.prompt({
      sessionId,
      requestId: randomUUID(),
      mode: 'queue',
      content: [{ type: 'text', text: message }],
    }, signal)

    const deadline = Date.now() + 300000
    let seen = cursor
    let text = ''
    let started = false
    let idleStreak = 0
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1200))
      try {
        const page = await controller.page({ address: { kind: 'session', sessionId }, maxMessages: 50 }, signal)
        const events = (page?.records ?? []).map((record) => record?.event ?? record).filter((event) => typeof event?.seq === 'number' && event.seq > seen)
        for (const event of events) {
          started = true
          if (event.type === 'assistant/message') {
            const chunk = this.assistantRecordText(event)
            if (chunk !== '') text += chunk
          }
          seen = Math.max(seen, event.seq)
        }
        const state = await controller.state({ sessionId }, signal)
        if (state?.running === true) { started = true; idleStreak = 0 } else if (started) {
          idleStreak += 1
          if (idleStreak >= 2) break
        }
      } catch {
        // transient read errors: keep polling until the deadline
      }
    }
    if (text === '') {
      try {
        const page = await controller.page({ address: { kind: 'session', sessionId }, maxMessages: 5 }, signal)
        const events = (page?.records ?? []).map((record) => record?.event ?? record).filter((event) => event?.type === 'assistant/message')
        text = events.map((event) => this.assistantRecordText(event)).filter((chunk) => chunk !== '').join('')
      } catch { /* keep empty */ }
    }
    return { sessionId, text: text.trim() }
  }

  /** Dispatch one task to the least-loaded online host (shared by assistant + ctl routes). */
  async dispatchTask({ cwd = '', prompt = '', instanceId = '' }) {
    const candidates = this.dispatchCandidates()
    if (candidates.length === 0) throw new Error('没有在线且已授权的实例可以派发')
    const named = instanceId === '' ? null : candidates.find(({ runtime }) => runtime.state.instance.id === instanceId)
    const target = named ?? candidates[0]
    const instance = target.runtime.state.instance
    const created = await callRemote(instance.dshUrl, target.runtime.state.cookie, 'session/create', {
      request: cwd === '' ? {} : { cwd },
    })
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('session/create returned no sessionId')
    if (prompt !== '') {
      await callRemote(instance.dshUrl, target.runtime.state.cookie, 'session/prompt', {
        request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] },
      })
    }
    this.sessionsFullCache.delete(instance.id)
    for (const key of [...this.sessionsCache.keys()]) if (key.startsWith(`${instance.id}|`)) this.sessionsCache.delete(key)
    return { instanceId: instance.id, instanceName: instance.name || instance.id, sessionId }
  }

  /** Deterministic fleet assistant: understand a few intents and execute them. */
  async assistantReply(message) {
    const text = String(message ?? '').trim()
    if (text === '') throw new Error('message is empty')
    const help = [
      '我可以帮你：',
      '· 「状态汇总」：所有实例在线 / 会话 / 运行中 / 看板',
      '· 「查看运行中」：列出正在跑的会话',
      '· 「今天花了多少」：tokens / 费用 / 缓存命中',
      '· 「派发任务 到 /某个/目录：<任务描述>」：选最空闲的机器建会话并下发',
      '· 「继续运行中的会话」：给所有运行中会话发继续指令',
      '· 「设置预算 5 美元」：修改全局日预算',
    ].join('\n')
    if (/帮助|help|能做什么|怎么用|capabilities/i.test(text)) return { reply: help }

    if (/预算|budget/i.test(text)) {
      const match = /(\d+(?:\.\d+)?)/u.exec(text)
      if (match !== null && /设置|设成|改成|调成|set/i.test(text)) {
        await this.ctx.settings.update(this.ns, { budgetDailyUsd: Number(match[1]) })
        this.usageCache.clear()
        return { reply: `已把全局每日预算设为 $${match[1]}，告警阈值沿用 ${Number(this.config.budgetWarnPct) || 80}%。` }
      }
      const budget = Number(this.config.budgetDailyUsd) || 0
      return { reply: budget > 0 ? `当前全局日预算是 $${budget}，告警阈值 ${Number(this.config.budgetWarnPct) || 80}%。` : '当前没有设置全局日预算（0 = 不限）。' }
    }

    if (/状态|汇总|summary|status|健康|health/i.test(text)) {
      const snapshot = this.statusSnapshot()
      if (snapshot.instances.length === 0) return { reply: '还没有配置任何实例。先在左栏底部「添加实例」。' }
      const lines = snapshot.instances.map((instance) => {
        const running = instance.sessions?.running ?? 0
        const sessions = instance.sessions?.count ?? '—'
        return `· ${instance.name}：${instance.online ? (instance.authed ? '在线' : '需授权') : '离线'} · ${sessions} 会话${running > 0 ? ` · ${running} 运行中` : ''}${instance.panelUrl ? (instance.panel?.ok ? ' · 看板在线' : ' · 看板离线') : ' · 无看板'}`
      })
      return { reply: [`共 ${snapshot.instances.length} 台设备：`, ...lines].join('\n') }
    }

    if (/运行中|在跑|running/i.test(text)) {
      const sessions = await this.runningSessions()
      if (sessions.length === 0) return { reply: '当前没有正在运行的会话。' }
      return {
        reply: [`共 ${sessions.length} 条运行中会话：`, ...sessions.map((session) => `· ${session.instanceName} · ${session.title || String(session.sessionId).slice(-10)}`)].join('\n'),
      }
    }

    if (/花费|花了|花销|费用|开销|用量|消耗|usage|cost|token/i.test(text)) {
      const cached = this.usageCache.get('today')
      if (cached === undefined) await this.refreshUsage('today')
      const usage = this.usageCache.get('today')?.value
      if (usage === undefined) return { reply: '暂时拿不到用量数据。' }
      const lines = usage.instances.map((instance) => {
        const summary = instance.summary
        if (summary === null || summary === undefined) return `· ${instance.name}：不可用`
        return `· ${instance.name}：${Math.round(summary.tokens / 1e6)}M tokens · ${typeof summary.costUsd === 'number' ? `$${summary.costUsd.toFixed(2)}` : '费用未知'} · 缓存 ${summary.cacheHit ?? '—'}%`
      })
      return { reply: [`今日总计 ${Math.round(usage.totals.tokens / 1e6)}M tokens${typeof usage.totals.costUsd === 'number' ? ` · $${usage.totals.costUsd.toFixed(2)}` : ''}：`, ...lines].join('\n') }
    }

    if (/继续|恢复|resume/i.test(text)) {
      const sessions = await this.runningSessions()
      let count = 0
      for (const session of sessions.slice(0, 8)) {
        const runtime = this.runtimes.get(session.instanceId)
        if (runtime === undefined) continue
        try {
          await callRemote(runtime.state.instance.dshUrl, runtime.state.cookie, 'session/prompt', {
            request: {
              requestId: randomUUID(),
              sessionId: session.sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: '请继续之前未完成的工作。' }],
            },
          })
          count += 1
        } catch {
          // ignore one failed session
        }
      }
      return { reply: count === 0 ? '没有可以继续的会话。' : `已给 ${count} 条运行中会话发送继续指令。` }
    }

    if (/派发|分配|下发|新建|启动|launch|dispatch|create/i.test(text)) {
      const candidates = this.dispatchCandidates()
      if (candidates.length === 0) return { reply: '没有在线且已授权的实例可以派发。' }
      // Optional explicit target: mention an instance name/id in the message.
      const named = candidates.find(({ runtime }) => {
        const instance = runtime.state.instance
        return text.includes(instance.name || instance.id) || text.includes(instance.id)
      })
      const target = named ?? candidates[0]
      const cwdMatch = /(?:到|在|目录[:：]?\s*)(\/[^\s，,。:：]+)/u.exec(text)
      const cwd = cwdMatch === null ? '' : cwdMatch[1]
      const promptMatch = /(?:任务|内容|prompt)[:：]\s*([\s\S]+)$/iu.exec(text)
      const prompt = promptMatch === null ? '' : promptMatch[1].trim()
      const instance = target.runtime.state.instance
      const created = await callRemote(instance.dshUrl, target.runtime.state.cookie, 'session/create', {
        request: cwd === '' ? {} : { cwd },
      })
      const sessionId = created?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') throw new Error('session/create returned no sessionId')
      if (prompt !== '') {
        await callRemote(instance.dshUrl, target.runtime.state.cookie, 'session/prompt', {
          request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] },
        })
      }
      this.sessionsFullCache.delete(instance.id)
      for (const key of [...this.sessionsCache.keys()]) if (key.startsWith(`${instance.id}|`)) this.sessionsCache.delete(key)
      return {
        reply: `已派发到「${instance.name || instance.id}」${cwd === '' ? '' : `（目录 ${cwd}）`}${prompt === '' ? '' : `，任务已下发`}。`,
        action: { type: 'open-session', instanceId: instance.id, sessionId },
      }
    }

    return { reply: `我还不会处理这句话。\n\n${help}` }
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
      path: '/fleet/usage/context',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        this.lastClientAt = Date.now()
        try {
          const cached = this.usageContextCache
          if (cached !== undefined && Date.now() - cached.at < 30000) {
            json(res, { ...cached.value, stale: false })
            return
          }
          const sessions = []
          const errors = []
          await Promise.all([...this.runtimes.values()].map(async (runtime) => {
            const state = runtime.state
            const instance = state.instance
            if (!state.authed) return
            try {
              const items = await this.fullSessions(runtime)
              const running = items.filter((item) => item.running === true && item.origin !== 'subagent')
              for (const item of running.slice(0, 12)) {
                try {
                  const detail = await contextDetail(instance.dshUrl, state.cookie, item.sessionId, 6000)
                  const head = detail?.head ?? detail
                  const window = typeof head?.contextWindow === 'number' ? head.contextWindow : null
                  const used = typeof head?.current?.total === 'number' ? head.current.total : null
                  sessions.push({
                    instanceId: instance.id,
                    instanceName: instance.name || instance.id,
                    sessionId: item.sessionId,
                    title: typeof item.projections?.values?.title === 'string' ? item.projections.values.title : '',
                    cwd: item.cwd ?? null,
                    model: typeof head?.model === 'string' ? head.model : null,
                    contextWindow: window,
                    contextUsedTokens: used,
                    contextPct: window !== null && used !== null && window > 0 ? Math.round((used / window) * 1000) / 10 : null,
                  })
                } catch (error) {
                  errors.push({ instanceId: instance.id, sessionId: item.sessionId, error: macMessage(error) })
                }
              }
            } catch (error) {
              errors.push({ instanceId: instance.id, error: macMessage(error) })
            }
          }))
          sessions.sort((a, b) => (b.contextPct ?? 0) - (a.contextPct ?? 0))
          const value = { ok: true, generatedAt: Date.now(), sessions, errors }
          this.usageContextCache = { at: Date.now(), value }
          json(res, { ...value, stale: false })
        } catch (error) {
          json(res, { ok: false, error: macMessage(error) }, 500)
        }
      },
    })
    const ctlGuard = async (req, res) => {
      const address = req.socket?.remoteAddress ?? ''
      const loopback = address === '::1' || address.startsWith('127.') || address === '::ffff:127.0.0.1'
      if (!loopback) { json(res, { ok: false, error: 'loopback only' }, 403); return null }
      let key = ''
      try { key = await this.ensureCtlKey() } catch { key = '' }
      if (key === '' || req.headers['x-fleet-ctl'] !== key) { json(res, { ok: false, error: 'bad ctl key' }, 403); return null }
      return key
    }
    const ctlRoute = (path, handler) => register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (await ctlGuard(req, res) === null) return
        try { await handler(req, res) } catch (error) { json(res, { ok: false, error: macMessage(error) }, 400) }
      },
    })
    ctlRoute('/fleet/ctl/state', async (req, res) => {
      if (req.method !== 'GET') { json(res, { ok: false, error: 'method not allowed' }, 405); return }
      const snapshot = this.statusSnapshot()
      json(res, {
        ok: true,
        instances: snapshot.instances.map((instance) => ({
          id: instance.id, name: instance.name, online: instance.online, authed: instance.authed,
          latencyMs: instance.latencyMs, sessions: instance.sessions, panel: instance.panel,
        })),
        running: await this.runningSessions(),
      })
    })
    ctlRoute('/fleet/ctl/running', async (req, res) => {
      json(res, { ok: true, running: await this.runningSessions() })
    })
    ctlRoute('/fleet/ctl/sessions', async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const instanceId = url.searchParams.get('instanceId') ?? ''
      const out = []
      for (const runtime of this.runtimes.values()) {
        if (instanceId !== '' && runtime.state.instance.id !== instanceId) continue
        if (!runtime.state.authed) continue
        try {
          const items = await this.fullSessions(runtime)
          for (const item of items.slice(0, 100)) {
            out.push({
              instanceId: runtime.state.instance.id,
              instanceName: runtime.state.instance.name || runtime.state.instance.id,
              sessionId: item.sessionId,
              title: item.projections?.values?.title ?? '',
              running: item.running === true,
              origin: item.origin ?? 'ordinary',
              cwd: item.cwd ?? null,
              updatedAt: item.projections?.values?.updatedAt ?? null,
            })
          }
        } catch { /* skip one host */ }
      }
      json(res, { ok: true, sessions: out })
    })
    ctlRoute('/fleet/ctl/usage', async (req, res) => {
      const cached = this.usageCache.get('today')
      if (cached === undefined) await this.refreshUsage('today')
      json(res, { ok: true, usage: this.usageCache.get('today')?.value ?? null })
    })
    ctlRoute('/fleet/ctl/tail', async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const instanceId = url.searchParams.get('instanceId') ?? ''
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const count = Math.max(1, Math.min(100, Number(url.searchParams.get('count') ?? 20) || 20))
      const runtime = this.runtimes.get(instanceId)
      if (runtime === undefined) { json(res, { ok: false, error: 'unknown instance' }, 404); return }
      const page = await callRemote(runtime.state.instance.dshUrl, runtime.state.cookie, 'session/page', {
        request: { address: { kind: 'session', sessionId }, maxMessages: count },
      })
      const records = (page?.records ?? []).map((record) => {
        const event = record?.event ?? record
        const type = event?.type ?? ''
        const message = event?.data?.message
        const parts = Array.isArray(message?.content) ? message.content : []
        const text = parts.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('')
        return { seq: event?.seq ?? 0, role: type === 'assistant/message' ? 'assistant' : type === 'user/message' ? 'user' : type, text }
      }).filter((record) => record.text !== '')
      json(res, { ok: true, sessionId, records })
    })
    ctlRoute('/fleet/ctl/dispatch', async (req, res) => {
      if (req.method !== 'POST') { json(res, { ok: false, error: 'method not allowed' }, 405); return }
      const body = JSON.parse(await readBody(req))
      const result = await this.dispatchTask({ cwd: String(body.cwd ?? ''), prompt: String(body.prompt ?? ''), instanceId: String(body.instanceId ?? '') })
      json(res, { ok: true, ...result })
    })
    ctlRoute('/fleet/ctl/prompt', async (req, res) => {
      if (req.method !== 'POST') { json(res, { ok: false, error: 'method not allowed' }, 405); return }
      const body = JSON.parse(await readBody(req))
      const runtime = this.runtimes.get(String(body.instanceId ?? ''))
      if (runtime === undefined) { json(res, { ok: false, error: 'unknown instance' }, 404); return }
      await callRemote(runtime.state.instance.dshUrl, runtime.state.cookie, 'session/prompt', {
        request: {
          requestId: randomUUID(),
          sessionId: String(body.sessionId ?? ''),
          mode: 'queue',
          content: [{ type: 'text', text: String(body.text ?? '') }],
        },
      })
      json(res, { ok: true })
    })

    register({
      kind: 'exact',
      path: '/fleet/assistant/session',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'GET') { json(res, { ok: false, error: 'method not allowed' }, 405); return }
        try {
          const controller = this.ctx.get('sessionController')
          if (controller === undefined) throw new Error('sessionController unavailable')
          const sessionId = await this.ensureAssistantSession(controller)
          json(res, { ok: true, sessionId })
        } catch (error) {
          json(res, { ok: false, error: macMessage(error) }, 400)
        }
      },
    })

    register({
      kind: 'exact',
      path: '/fleet/assistant',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') { json(res, { ok: false, error: 'method not allowed' }, 405); return }
        this.lastClientAt = Date.now()
        try {
          const body = JSON.parse(await readBody(req))
          const message = String(body.message ?? '').trim()
          if (message === '') throw new Error('message is empty')
          let result
          try {
            const answered = await this.askDispatcher(message)
            result = { reply: answered.text === '' ? '（助手这一轮没有返回文本，可以再问一次或让我打开完整会话。）' : answered.text, assistantSessionId: answered.sessionId }
          } catch (error) {
            this.log(`assistant dispatcher failed, falling back to rules: ${macMessage(error)}`)
            result = await this.assistantReply(message)
          }
          json(res, { ok: true, ...result })
        } catch (error) {
          json(res, { ok: false, error: macMessage(error) }, 400)
        }
      },
    })
    register({
      kind: 'exact',
      path: '/fleet/usage',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        this.lastClientAt = Date.now()
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const rangeParam = url.searchParams.get('range') ?? 'today'
          const range = ['today', '7d', '30d'].includes(rangeParam) ? rangeParam : 'today'
          const cached = this.usageCache.get(range)
          if (cached !== undefined) {
            if (Date.now() - cached.at > 45000) void this.refreshUsage(range)
            json(res, { ...cached.value, stale: Date.now() - cached.at > 45000 })
            return
          }
          await this.refreshUsage(range)
          const value = this.usageCache.get(range)
          json(res, value === undefined ? { ok: false, error: 'usage unavailable' } : { ...value.value, stale: false })
        } catch (error) {
          json(res, { ok: false, error: macMessage(error) }, 500)
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
            budgetDailyUsd: Number(this.config.budgetDailyUsd) || 0,
            budgetWarnPct: Number(this.config.budgetWarnPct) || 80,
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
            ...(Number(patch.budgetDailyUsd) >= 0 ? { budgetDailyUsd: Number(patch.budgetDailyUsd) } : {}),
            ...(Number(patch.budgetWarnPct) >= 1 && Number(patch.budgetWarnPct) <= 100 ? { budgetWarnPct: Number(patch.budgetWarnPct) } : {}),
          })
          this.config = this.readSettings()
          await this.reconcile()
          this.usageCache.clear()
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
