#!/usr/bin/env node
// Bring up the standard test environment: CubeSandbox DSH instances + fleet registration.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const configPath = process.argv[2] ?? join(here, 'config.json')
if (!existsSync(configPath)) {
  copyFileSync(join(here, 'config.example.json'), configPath)
  console.error(`created ${configPath}, fill in sandboxHost/templateId/masterUrl first`)
  process.exit(1)
}
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const expand = (path) => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
const remoteState = '/tmp/dsh-fleet-testenv-sandboxes.json'

function ssh(command) {
  return execFileSync('ssh', [config.sandboxHost, command], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'` }

try {
  execFileSync('scp', ['-q', join(here, 'sandbox-up.py'), `${config.sandboxHost}:/tmp/dsh-fleet-testenv-sandbox-up.py`])
  const command = [
    quote(config.e2bPython), '/tmp/dsh-fleet-testenv-sandbox-up.py',
    '--count', String(config.sandboxCount ?? 2),
    '--prefix', quote(config.instancePrefix ?? 'cube-'),
    '--template', quote(config.templateId),
    '--base-port', String(config.proxyBasePort ?? 13181),
    '--public-host', quote(config.publicHost),
    '--ttl', String(config.sandboxTtlSeconds ?? 7200),
    '--state', remoteState,
    '--e2b-url', quote(config.cubeApi ?? 'http://127.0.0.1:3000'),
  ].join(' ')
  console.log('· creating sandboxes and installing DSH (may take a few minutes)…')
  const output = ssh(command)
  const line = output.split('\n').filter((item) => item.trim().startsWith('{')).pop()
  if (line === undefined) throw new Error(`unexpected sandbox output:\n${output.slice(-1500)}`)
  const sandboxResult = JSON.parse(line)
  if (!sandboxResult.ok) throw new Error(`sandbox setup failed: ${JSON.stringify(sandboxResult.instances).slice(0, 1000)}`)

  const cookie = await masterCookie(config)
  const api = (method, path, body) => request(config.masterUrl + path, method, cookie, body)
  const current = await api('GET', '/fleet/config')
  const prefix = config.instancePrefix ?? 'cube-'
  const kept = (current.instances ?? []).filter((item) => !String(item.id).startsWith(prefix))
  const created = sandboxResult.instances.map((item) => ({
    id: item.name, name: `Cube 沙箱 ${item.name.replace(prefix, '')}`,
    dshUrl: item.dshUrl, panelUrl: '', ssh: '',
  }))
  await api('PUT', '/fleet/config', { instances: [...kept, ...created] })
  for (const item of sandboxResult.instances) {
    const result = await api('POST', '/fleet/authorize', { instanceId: item.name, token: item.token })
    if (!result.ok) throw new Error(`authorize ${item.name} failed: ${result.error}`)
  }
  const manifest = {
    createdAt: new Date().toISOString(),
    sandboxHost: config.sandboxHost,
    proxyPid: sandboxResult.proxyPid,
    instances: sandboxResult.instances.map(({ name, sandboxId, port, dshUrl }) => ({ name, sandboxId, port, dshUrl })),
    statePath: remoteState,
  }
  writeFileSync(join(here, '.manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`✓ test environment ready: ${manifest.instances.map((item) => item.name).join(', ')}`)
} catch (error) {
  console.error('✗ up failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
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
  const response = await fetch(url, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const value = await response.json()
  if (!response.ok || value.ok === false) throw new Error(`${method} ${url}: ${value.error ?? response.status}`)
  return value
}
