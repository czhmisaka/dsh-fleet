/**
 * Remote-side operations for the fleet panel: launch-token acquisition (local
 * log or SSH), token-to-cookie exchange, health probes, the Remote RPC used for
 * session summaries, agent calls, and :40005 dashboard normalization.
 * @module dsh-fleet/host/remote
 */

import http from 'node:http'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const SSH_TARGET = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/u
const LOG_PATH = /^[~\w./-]+$/u
const TOKEN_LINE = /token=([A-Za-z0-9_-]+)/u

/** Issue one plain-HTTP request with full header control. */
export function requestWithHeaders(url, { method = 'GET', headers = {}, body, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request({
      hostname: target.hostname,
      port: target.port === '' ? 80 : Number(target.port),
      method,
      path: `${target.pathname}${target.search}`,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** Extract `token=` value from a remote (or local) dsh-web log through SSH. */
export function fetchTokenViaSsh({ ssh, logPath }, timeoutMs = 10000) {
  if (!SSH_TARGET.test(ssh ?? '')) return Promise.reject(new Error(`invalid ssh target: ${String(ssh)}`))
  if (!LOG_PATH.test(logPath ?? '')) return Promise.reject(new Error(`invalid log path: ${String(logPath)}`))
  const command = `grep -a -o "token=[A-Za-z0-9_-]*" ${logPath} | tail -1`
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', ssh, command], { timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        reject(new Error(`ssh token fetch failed: ${error.message}`))
        return
      }
      const match = TOKEN_LINE.exec(stdout)
      if (match === null) {
        reject(new Error('no launch token in remote log'))
        return
      }
      resolve(match[1])
    })
  })
}

/** Exchange a launch token for the authority-bound browser cookie. */
export async function exchangeToken(dshUrl, token) {
  const response = await requestWithHeaders(`${dshUrl}/?token=${encodeURIComponent(token)}`, {
    headers: { referer: '' },
    timeoutMs: 8000,
  })
  const setCookie = response.headers['set-cookie']
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie
  if (typeof first !== 'string' || !first.includes('=')) {
    throw new Error(`token exchange failed (HTTP ${String(response.status)})`)
  }
  const cookie = first.split(';')[0].trim()
  const maxAge = /Max-Age=(\d+)/iu.exec(first)
  const expiresAt = Date.now() + (maxAge === null ? 30 * 24 * 3600 * 1000 : Number(maxAge[1]) * 1000)
  return { cookie, authority: new URL(dshUrl).host, expiresAt }
}

/** Probe an instance root with its cookie: 200 valid, 401 needs authorization, else unreachable. */
export async function probeInstance(dshUrl, cookie, timeoutMs = 4000) {
  const started = Date.now()
  try {
    const response = await requestWithHeaders(`${dshUrl}/`, {
      headers: cookie ? { cookie } : {},
      timeoutMs,
    })
    return { status: response.status, latencyMs: Date.now() - started }
  } catch (error) {
    return { status: 0, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Call one unary Remote endpoint on a remote instance with its browser cookie. */
export async function callRemote(dshUrl, cookie, endpoint, args, timeoutMs = 12000) {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: randomUUID(),
    method: endpoint,
    payload: { args },
  })
  const response = await requestWithHeaders(`${dshUrl}/api/${endpoint}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    body,
    timeoutMs,
  })
  if (response.status !== 200) throw new Error(`rpc ${endpoint}: HTTP ${String(response.status)}`)
  const parsed = JSON.parse(response.text)
  if (parsed?.result?.ok !== true) {
    const error = parsed?.result?.error
    throw new Error(`rpc ${endpoint}: ${error?.code ?? 'failed'} ${error?.message ?? ''}`.trim())
  }
  return parsed.result.value
}

/** Read a session summary (trimmed) from a remote instance through its own Remote API. */
export async function remoteSessions(dshUrl, cookie, limit = 6) {
  const value = await callRemote(dshUrl, cookie, 'session/list', { _request: {} })
  const items = Array.isArray(value?.items) ? value.items : []
  const running = items.filter((item) => item.running === true).length
  const top = items.slice(0, limit).map((item) => ({
    sessionId: item.sessionId,
    title: typeof item.projections?.values?.title === 'string' ? item.projections.values.title : '',
    running: item.running === true,
    updatedAt: item.updatedAt ?? null,
    cwd: item.cwd ?? null,
  }))
  return { count: items.length, running, items: top }
}

/** Call one agent route on a remote instance. */
export async function agentCall(agentUrl, key, path, timeoutMs = 5000) {
  const separator = agentUrl.endsWith('/') ? '' : '/'
  const response = await requestWithHeaders(`${agentUrl}${separator}${path}`, {
    headers: key ? { 'x-fleet-key': key } : {},
    timeoutMs,
  })
  if (response.status !== 200) throw new Error(`agent ${path}: HTTP ${String(response.status)}`)
  return JSON.parse(response.text)
}

/** Read one :40005 dashboard status document without normalizing it. */
export async function panelRaw(panelUrl, timeoutMs = 5000) {
  const response = await requestWithHeaders(`${panelUrl}/api/status`, { timeoutMs })
  if (response.status !== 200) throw new Error(`panel status: HTTP ${String(response.status)}`)
  return JSON.parse(response.text)
}

/** Read and normalize one :40005 dashboard status document. */
export async function panelStatus(panelUrl, timeoutMs = 5000) {
  return normalizePanel(await panelRaw(panelUrl, timeoutMs))
}

/** Normalize the panel's /api/status across monitor versions (gpus list vs single gpu vs absent). */
export function normalizePanel(data) {
  const system = data?.system ?? {}
  const cpu = data?.cpu ?? {}
  const memory = data?.memory ?? {}
  const gpuList = Array.isArray(data?.gpus)
    ? data.gpus
    : (data?.gpu !== undefined && data.gpu !== null && data.gpu.available !== false ? [data.gpu] : [])
  const gpus = gpuList.map((gpu) => ({
    name: typeof gpu.name === 'string' ? gpu.name : 'GPU',
    memUsedMb: numberOr(gpu.mem_used_mb),
    memTotalMb: numberOr(gpu.mem_total_mb),
    memPct: numberOr(gpu.mem_pct),
    tempC: numberOr(gpu.temp_c),
    powerW: numberOr(gpu.power_w),
    utilPct: numberOr(gpu.util_pct),
  }))
  return {
    hostname: typeof system.hostname === 'string' ? system.hostname : '',
    os: typeof system.os === 'string' ? system.os : '',
    arch: typeof system.arch === 'string' ? system.arch : '',
    uptimeS: numberOr(system.uptime_s),
    cpuPct: numberOr(cpu.total_pct),
    load: Array.isArray(cpu.loadavg) ? cpu.loadavg.map(numberOr) : [],
    cores: numberOr(cpu.n_cores ?? cpu.n_threads),
    memUsedGb: numberOr(memory.ram_used_gb),
    memTotalGb: numberOr(memory.ram_total_gb),
    memPct: numberOr(memory.ram_pct),
    disks: (Array.isArray(data?.disks) ? data.disks : []).map((disk) => ({
      mount: typeof disk.mount === 'string' ? disk.mount : '',
      usedGb: numberOr(disk.used_gb),
      totalGb: numberOr(disk.total_gb),
      pct: numberOr(disk.pct),
    })),
    gpus,
    gpuCount: numberOr(data?.gpu_count) ?? gpus.length,
    panelVersion: typeof system.monitor_version === 'string' ? system.monitor_version : '',
  }
}

function numberOr(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Call the dsh-context overview API on a remote DSH (usage aggregation).
 * @param {string} dshUrl - remote origin.
 * @param {string} cookie - authenticated browser cookie.
 * @param {object} body - overview request ({ part, scope, sort, page }).
 * @param {number} timeoutMs - request budget.
 * @returns {Promise<object>} the `value` envelope (summary/page/days/...).
 */
export async function contextOverview(dshUrl, cookie, body, timeoutMs = 8000) {
  const raw = JSON.stringify(body)
  const response = await requestWithHeaders(`${dshUrl}/api/dsh-context/overview`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) },
    body: raw,
    timeoutMs,
  })
  if (response.status !== 200) throw new Error(`dsh-context overview: HTTP ${String(response.status)}`)
  const parsed = JSON.parse(response.text)
  if (parsed?.ok !== true || parsed.value === null || typeof parsed.value !== 'object') {
    throw new Error('dsh-context overview: invalid response')
  }
  return parsed.value
}
