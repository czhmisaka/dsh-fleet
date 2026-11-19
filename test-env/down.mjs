#!/usr/bin/env node
// Tear down the standard test environment: unregister instances, kill VMs and proxy.
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(process.argv[2] ?? join(here, 'config.json'), 'utf8'))
const manifestPath = join(here, '.manifest.json')
if (!existsSync(manifestPath)) { console.error('no .manifest.json — nothing to tear down'); process.exit(1) }
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const expand = (path) => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path

const log = readFileSync(expand(config.masterTokenLog), 'utf8')
const token = [...log.matchAll(/token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1]
const login = await fetch(`${config.masterUrl}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (login.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0]).find((item) => item.startsWith('dsh-auth-'))
if (cookie === undefined) throw new Error('no master cookie')

const response = await fetch(config.masterUrl + '/fleet/config', { headers: { cookie } })
const current = await response.json()
const prefix = config.instancePrefix ?? 'cube-'
const kept = (current.instances ?? []).filter((item) => !String(item.id).startsWith(prefix))
await fetch(config.masterUrl + '/fleet/config', {
  method: 'PUT',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ instances: kept }),
})
console.log(`· unregistered ${(current.instances ?? []).length - kept.length} instance(s)`)

execFileSync('scp', ['-q', join(here, 'sandbox-down.py'), `${config.sandboxHost}:/tmp/dsh-fleet-testenv-sandbox-down.py`])
const output = execFileSync('ssh', [config.sandboxHost, [
  `'${config.e2bPython}' /tmp/dsh-fleet-testenv-sandbox-down.py --state '${manifest.statePath}'`,
].join(' ')], { encoding: 'utf8' })
console.log(output.trim())
rmSync(manifestPath)
console.log('✓ test environment torn down')
