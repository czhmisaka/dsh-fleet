#!/usr/bin/env node
// Standard test-environment smoke test (HTTP only; UI check lives in the panel).
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(process.argv[2] ?? join(here, 'config.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(here, '.manifest.json'), 'utf8'))
const prefix = config.instancePrefix ?? 'cube-'
const expand = (path) => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path

const log = readFileSync(expand(config.masterTokenLog), 'utf8')
const token = [...log.matchAll(/token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1]
if (token === undefined) throw new Error('no master token')
const login = await fetch(`${config.masterUrl}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (login.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0]).find((item) => item.startsWith('dsh-auth-'))
if (cookie === undefined) throw new Error('no master cookie')

async function api(path, method = 'GET', body) {
  const response = await fetch(config.masterUrl + path, {
    method, headers: { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const value = await response.json()
  if (!response.ok || value.ok === false) throw new Error(`${path}: ${value.error ?? response.status}`)
  return value
}

const checks = []
const check = (name, ok, detail = '') => checks.push({ name, ok, detail })

let status
for (let attempt = 0; attempt < 12; attempt += 1) {
  status = await api('/fleet/status')
  const ours = status.instances.filter((item) => item.id.startsWith(prefix))
  if (ours.length > 0 && ours.every((item) => item.online && item.authed)) break
  await new Promise((resolve) => setTimeout(resolve, 1500))
}
for (const item of status.instances.filter((entry) => entry.id.startsWith(prefix))) {
  check(`${item.id} online+authed`, item.online === true && item.authed === true, JSON.stringify({ online: item.online, authed: item.authed }))
}

for (const item of manifest.instances) {
  const sessions = await api(`/fleet/sessions?instanceId=${encodeURIComponent(item.name)}`)
  check(`${item.name} session/list`, Array.isArray(sessions.sessions?.items), `count=${sessions.sessions?.count}`)
}

const usage = await api('/fleet/usage?range=today')
check('/fleet/usage responds', Array.isArray(usage.instances), `total=${usage.totals?.tokens ?? 0}`)

const assistant = await api('/fleet/assistant/session')
check('/fleet/assistant/session', typeof assistant.sessionId === 'string' && assistant.sessionId.startsWith('session-'), assistant.sessionId)

const failed = checks.filter((item) => !item.ok)
for (const item of checks) console.log(`${item.ok ? '✓' : '✗'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) failed`)
  process.exit(1)
}
console.log(`\nall ${checks.length} checks passed`)
