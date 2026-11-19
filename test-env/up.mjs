#!/usr/bin/env node
// Bring up the standard test environment: CubeSandbox DSH instances + fleet registration.
//
// Ownership rules (do not relax):
//   * this script only owns the fleet entries whose id starts with `instancePrefix`
//     (cube-*); every other entry is copied verbatim out of the master's
//     GET /fleet/config so master-owned fields (ssh, agentUrl, tokenLogPath,
//     dshPort, panelPort, ...) survive untouched.
//   * cube entries are merged against the sandboxes that are *actually alive*:
//     same id -> keep the entry but refresh its fields; dead and not rebuilt ->
//     drop it. Never blind-delete every cube-* entry, that detaches the fleet
//     from the sandboxes that are still running.
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// CLI: `node up.mjs [configPath] [--ttl <seconds>] [--count <n>] [--template <id>]`
// The flags win over config.json so a run never silently inherits a stale value.
const cli = { configPath: undefined, ttl: undefined, count: undefined, template: undefined }
const argv = process.argv.slice(2)
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg.startsWith('--')) {
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) { cli[key] = next; index += 1 } else { cli[key] = 'true' }
  } else if (cli.configPath === undefined) {
    cli.configPath = arg
  }
}
const configPath = cli.configPath ?? join(here, 'config.json')
if (!existsSync(configPath)) {
  copyFileSync(join(here, 'config.example.json'), configPath)
  console.error(`created ${configPath}, fill in sandboxHost/templateId/masterUrl first`)
  process.exit(1)
}
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const expand = (path) => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
const remoteState = '/tmp/dsh-fleet-testenv-sandboxes.json'
const remotePluginTar = '/tmp/dsh-fleet-testenv-plugin.tar.gz'
const prefix = config.instancePrefix ?? 'cube-'
const publicHost = config.publicHost
const tokenDir = expand(config.tokenDir ?? '~/.dsh/fleet-assistant/tokens')
const pluginSource = expand(config.pluginSource ?? '~/.dsh/profiles/web/plugins/dsh-fleet')
// Master-side fleet proxy ports for the cube entries (lead's numbering).
const fleetDshPortBase = Number(config.fleetDshPortBase ?? 37808)
const fleetDshPortStep = Number(config.fleetDshPortStep ?? 2)
// Resolved run parameters: CLI first, then config.json, then the built-in default.
const sandboxCount = Number(cli.count ?? config.sandboxCount ?? 2)
const sandboxTtlSeconds = Number(cli.ttl ?? config.sandboxTtlSeconds ?? 2592000)
const templateId = String(cli.template ?? config.templateId)
if (!Number.isFinite(sandboxTtlSeconds) || sandboxTtlSeconds < 60) {
  throw new Error(`bad sandbox TTL: ${String(sandboxTtlSeconds)}`)
}

function ssh(command) {
  return execFileSync('ssh', [config.sandboxHost, command], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'` }

/** Master-side fleet proxy port for one cube instance (cube-1 -> 37808, cube-2 -> 37810). */
function fleetDshPort(name) {
  const index = Number(String(name).replace(prefix, ''))
  return fleetDshPortBase + (Number.isFinite(index) ? Math.max(0, index - 1) : 0) * fleetDshPortStep
}

/** Where the master keeps this instance's DSH token so the plugin can re-authorize itself. */
function tokenPathFor(name) { return join(tokenDir, `${name}.log`) }

/** Write the sandbox token into a master-local log the fleet plugin can read back. */
function writeTokenFile(name, token) {
  mkdirSync(tokenDir, { recursive: true, mode: 0o700 })
  const path = tokenPathFor(name)
  writeFileSync(path, `token=${token}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

/** Build one complete cube entry; every field the plugin schema knows about is present. */
function cubeEntry(previous, live) {
  const suffix = String(live.name).replace(prefix, '')
  return {
    id: live.name,
    name: typeof previous?.name === 'string' && previous.name !== '' ? previous.name : `Cube 沙箱 ${suffix}`,
    dshUrl: live.dshUrl,
    panelUrl: typeof previous?.panelUrl === 'string' ? previous.panelUrl : '',
    // The sandbox has no sshd: an empty ssh forces the plugin to read the
    // master-local token file instead of trying `ssh <host> grep token=`.
    ssh: '',
    tokenLogPath: tokenPathFor(live.name),
    dshPort: Number(previous?.dshPort) > 0 ? Number(previous.dshPort) : fleetDshPort(live.name),
    panelPort: Number(previous?.panelPort) || 0,
    // The agent channel lives on the *host* mapping port, not on 3080.
    agentUrl: `http://${publicHost}:${live.port}/fleet-agent`,
    enabled: previous?.enabled !== false,
    budgetDailyUsd: Number(previous?.budgetDailyUsd) || 0,
  }
}

/**
 * Merge the master's instances with the alive sandboxes.
 * Non-cube entries are passed through untouched; cube entries are rebuilt from
 * the live sandbox (new ports/urls) and dead ones disappear.
 */
function mergeInstances(current, liveInstances) {
  const alive = new Map(liveInstances.map((item) => [item.name, item]))
  const merged = []
  const seen = new Set()
  for (const item of current ?? []) {
    const id = String(item.id ?? '')
    if (!id.startsWith(prefix)) {
      merged.push(item) // master-owned entry: keep every field exactly as it was
      continue
    }
    const live = alive.get(id)
    if (live === undefined) continue // dead sandbox, not rebuilt -> drop
    merged.push(cubeEntry(item, live))
    seen.add(id)
  }
  for (const live of liveInstances) {
    if (seen.has(live.name)) continue
    merged.push(cubeEntry(undefined, live))
    seen.add(live.name)
  }
  return merged
}

/** Pack the dsh-fleet plugin so the sandbox can install it before DSH starts. */
function stagePlugin() {
  if (!existsSync(pluginSource)) throw new Error(`plugin source not found: ${pluginSource}`)
  const tar = join(tmpdir(), `dsh-fleet-testenv-plugin-${process.pid}.tar.gz`)
  rmSync(tar, { force: true })
  execFileSync('tar', ['-czf', tar, '--exclude', 'node_modules', '--exclude', '.git', '-C', pluginSource, '.'])
  execFileSync('scp', ['-q', tar, `${config.sandboxHost}:${remotePluginTar}`])
  rmSync(tar, { force: true })
  console.log(`· staged dsh-fleet plugin -> ${config.sandboxHost}:${remotePluginTar}`)
}

async function main() {
try {
  const cookie = await masterCookie(config)
  const api = (method, path, body) => request(config.masterUrl + path, method, cookie, body)

  // Read the master config first: it owns the shared fleet agent key.
  const before = await api('GET', '/fleet/config')
  const agentKey = typeof before.agentKey === 'string' && before.agentKey !== ''
    ? before.agentKey
    : (config.agentKey ?? '')
  if (agentKey === '') throw new Error('no fleet agentKey on the master and none in config.json')
  if (config.agentKey !== undefined && before.agentKey !== '' && config.agentKey !== before.agentKey) {
    throw new Error(`agentKey mismatch: master=${before.agentKey} config=${config.agentKey}`)
  }

  stagePlugin()
  execFileSync('scp', ['-q', join(here, 'sandbox-up.py'), `${config.sandboxHost}:/tmp/dsh-fleet-testenv-sandbox-up.py`])
  const command = [
    quote(config.e2bPython), '/tmp/dsh-fleet-testenv-sandbox-up.py',
    '--count', String(sandboxCount),
    '--prefix', quote(prefix),
    '--template', quote(templateId),
    '--base-port', String(config.proxyBasePort ?? 13181),
    '--public-host', quote(publicHost),
    '--ttl', String(sandboxTtlSeconds),
    '--state', remoteState,
    '--e2b-url', quote(config.cubeApi ?? 'http://127.0.0.1:3000'),
    '--agent-key', quote(agentKey),
    '--plugin-tar', quote(remotePluginTar),
  ].join(' ')
  console.log(`· creating sandboxes and installing DSH (count=${sandboxCount} ttl=${sandboxTtlSeconds}s template=${templateId})…`)
  const output = ssh(command)
  const line = output.split('\n').filter((item) => item.trim().startsWith('{')).pop()
  if (line === undefined) throw new Error(`unexpected sandbox output:\n${output.slice(-1500)}`)
  const sandboxResult = JSON.parse(line)
  if (!sandboxResult.ok) throw new Error(`sandbox setup failed: ${JSON.stringify(sandboxResult.instances).slice(0, 1000)}`)

  // The plugin re-authorizes from this file, so keep it in sync with the sandbox.
  for (const item of sandboxResult.instances) {
    if (!item.token) throw new Error(`no DSH token for ${item.name}`)
    writeTokenFile(item.name, item.token)
  }

  // Read again right before the write so a concurrent master edit is not clobbered.
  const current = await api('GET', '/fleet/config')
  const instances = mergeInstances(current.instances ?? [], sandboxResult.instances)
  const payload = { instances }
  // Only fill the key in when the master does not have one yet.
  if (!current.agentKey) payload.agentKey = agentKey
  console.log('· GET /fleet/config BEFORE the PUT:')
  for (const item of current.instances ?? []) {
    console.log(`    ${item.id}  dshUrl=${item.dshUrl}  agentUrl=${item.agentUrl ?? ''}  ssh=${item.ssh ?? ''}  tokenLogPath=${item.tokenLogPath ?? ''}  dshPort=${item.dshPort}  panelPort=${item.panelPort}`)
  }
  await api('PUT', '/fleet/config', payload)
  for (const item of sandboxResult.instances) {
    const result = await api('POST', '/fleet/authorize', { instanceId: item.name, token: item.token })
    if (!result.ok) throw new Error(`authorize ${item.name} failed: ${result.error}`)
  }
  const after = await api('GET', '/fleet/config')
  const manifest = {
    createdAt: new Date().toISOString(),
    sandboxHost: config.sandboxHost,
    proxyPid: sandboxResult.proxyPid,
    agentKey,
    instances: sandboxResult.instances.map(({ name, sandboxId, port, dshUrl, agentUrl }) => ({ name, sandboxId, port, dshUrl, agentUrl })),
    statePath: remoteState,
  }
  writeFileSync(join(here, '.manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`✓ test environment ready: ${manifest.instances.map((item) => item.name).join(', ')}`)
  console.log('· GET /fleet/config AFTER the PUT:')
  for (const item of after.instances ?? []) {
    console.log(`    ${item.id}  dshUrl=${item.dshUrl}  agentUrl=${item.agentUrl ?? ''}  ssh=${item.ssh ?? ''}  tokenLogPath=${item.tokenLogPath ?? ''}  dshPort=${item.dshPort}  panelPort=${item.panelPort}`)
  }
} catch (error) {
  console.error('✗ up failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
}
}

export { mergeInstances, cubeEntry }

// Only run the bring-up when this file is the entry point; the merge logic is
// importable so `up-selftest.mjs` can exercise it without touching the master.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}

async function masterCookie(cfg) {
  const log = readFileSync(expand(cfg.masterTokenLog), 'utf8')
  const matches = [...log.matchAll(/token=([A-Za-z0-9_-]+)/g)]
  if (matches.length === 0) throw new Error(`no dsh token in ${cfg.masterTokenLog}`)
  const token = matches.at(-1)[1]
  const response = await fetch(`${cfg.masterUrl}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const setCookies = response.headers.getSetCookie?.() ?? []
  const pair = setCookies.map((item) => item.split(';')[0]).find((item) => item.startsWith('dsh-auth-'))
  if (pair === undefined) throw new Error('master did not return a dsh-auth cookie')
  return pair
}

async function request(url, method, cookie, body) {
  // The master may close an idle keep-alive socket while the sandboxes boot;
  // undici surfaces that as a bare "fetch failed", so retry a few times.
  let lastError
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        method,
        headers: { cookie, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const value = await response.json()
      if (!response.ok || value.ok === false) throw new Error(`${method} ${url}: ${value.error ?? response.status}`)
      return value
    } catch (error) {
      lastError = error
      if (error instanceof Error && error.message.startsWith(`${method} ${url}:`)) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
    }
  }
  throw lastError
}
