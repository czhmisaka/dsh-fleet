#!/usr/bin/env node
// Self-test for the fleet-config merge in up.mjs.
//
// Two things are proven here:
//   1) the *fixed* merge keeps every master-owned instance byte-identical and
//      gives each live cube instance a complete entry (agentUrl included);
//   2) the *old* merge (filter every id that starts with the prefix, then
//      re-add a 5-field stub) really does break both of those guarantees.
//
// The second half is the reverse test: without it, a merge that silently drops
// fields would still pass the first half.
import { mergeInstances } from './up.mjs'

const prefix = 'cube-'
const publicHost = '192.0.2.10'

const masterOwned = [
  { id: 'mac', name: 'Mac 本机', dshUrl: 'http://127.0.0.1:36900', panelUrl: '', ssh: '', tokenLogPath: '/Users/chenzhihan/Desktop/螃蟹的家/logs/dsh-web.log', dshPort: 37805, panelPort: 0, agentUrl: 'http://127.0.0.1:36900/fleet-agent', enabled: true, budgetDailyUsd: 0 },
  { id: 'spark2', name: 'spark2', dshUrl: 'http://192.0.2.26:3080', panelUrl: 'http://192.0.2.26:40005', ssh: 'user@192.0.2.26', tokenLogPath: '~/.dsh/dsh-web.log', dshPort: 37801, panelPort: 37802, agentUrl: 'http://192.0.2.26:3080/fleet-agent', enabled: true, budgetDailyUsd: 0 },
  { id: 's169', name: '4090 服务器', dshUrl: 'http://192.0.2.10:3080', panelUrl: 'http://192.0.2.10:40005', ssh: 'user@fleet-s169', tokenLogPath: '~/.dsh/dsh-web.log', dshPort: 37803, panelPort: 37804, agentUrl: 'http://192.0.2.10:3080/fleet-agent', enabled: true, budgetDailyUsd: 0 },
  { id: 'x99', name: 'X99 盒子', dshUrl: 'http://192.0.2.54:3080', panelUrl: 'http://192.0.2.54:40005', ssh: 'user@fleet-x99', tokenLogPath: '~/.dsh/dsh-web.log', dshPort: 37806, panelPort: 37807, agentUrl: 'http://192.0.2.54:3080/fleet-agent', enabled: true, budgetDailyUsd: 0 },
]

const liveSandboxes = [
  { name: 'cube-1', sandboxId: 'aaaa', port: 13181, dshUrl: 'http://192.0.2.10:13181' },
  { name: 'cube-2', sandboxId: 'bbbb', port: 13182, dshUrl: 'http://192.0.2.10:13182' },
]

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

// ---------------------------------------------------------------------------
// 1) the fixed merge
// ---------------------------------------------------------------------------
const before = [
  ...masterOwned,
  // a stale cube entry that no sandbox backs any more -> must disappear
  { id: 'cube-9', name: 'Cube 沙箱 9', dshUrl: 'http://192.0.2.10:13189', panelUrl: '', ssh: '', tokenLogPath: '/tmp/old.log', dshPort: 37818, panelPort: 0, agentUrl: 'http://192.0.2.10:13189/fleet-agent', enabled: true, budgetDailyUsd: 0 },
]
const merged = mergeInstances(before, liveSandboxes)

for (const original of masterOwned) {
  const kept = merged.find((item) => item.id === original.id)
  check(`master-owned ${original.id} kept verbatim`, kept !== undefined && JSON.stringify(kept) === JSON.stringify(original),
    kept === undefined ? 'missing' : `ssh=${kept.ssh} agentUrl=${kept.agentUrl}`)
}
check('stale cube-9 removed', merged.find((item) => item.id === 'cube-9') === undefined)

for (const live of liveSandboxes) {
  const entry = merged.find((item) => item.id === live.name)
  check(`${live.name} present`, entry !== undefined)
  if (entry === undefined) continue
  const expected = {
    id: live.name,
    name: `Cube 沙箱 ${live.name.replace(prefix, '')}`,
    dshUrl: live.dshUrl,
    panelUrl: '',
    ssh: '',
    tokenLogPath: entry.tokenLogPath,
    dshPort: live.name === 'cube-1' ? 37808 : 37810,
    panelPort: 0,
    agentUrl: `http://${publicHost}:${live.port}/fleet-agent`,
    enabled: true,
    budgetDailyUsd: 0,
  }
  check(`${live.name} has every schema field`, JSON.stringify(entry) === JSON.stringify(expected), JSON.stringify(entry))
  check(`${live.name} agentUrl is non-empty`, typeof entry.agentUrl === 'string' && entry.agentUrl !== '')
  check(`${live.name} ssh is empty (no sshd in the sandbox)`, entry.ssh === '')
  check(`${live.name} tokenLogPath points at the master-local token file`, /fleet-assistant[\\/]tokens[\\/]/.test(entry.tokenLogPath), entry.tokenLogPath)
}

// ---------------------------------------------------------------------------
// 2) reverse test: the old merge really is broken
// ---------------------------------------------------------------------------
const oldKept = before.filter((item) => !String(item.id).startsWith(prefix))
const oldCreated = liveSandboxes.map((item) => ({
  id: item.name,
  name: `Cube 沙箱 ${item.name.replace(prefix, '')}`,
  dshUrl: item.dshUrl,
  panelUrl: '',
  ssh: '',
}))
const oldMerged = [...oldKept, ...oldCreated]
const oldCube = oldMerged.find((item) => item.id === 'cube-1')
check('REVERSE: old merge drops agentUrl', oldCube !== undefined && (oldCube.agentUrl ?? '') === '')
check('REVERSE: old merge drops tokenLogPath/dshPort/panelPort/enabled/budgetDailyUsd',
  oldCube !== undefined && oldCube.tokenLogPath === undefined && oldCube.dshPort === undefined)
check('REVERSE: old merge deletes a still-alive cube entry from the fleet', oldKept.find((item) => item.id === 'cube-1') === undefined)
check('REVERSE: old merge cannot keep a master-owned ssh alias', JSON.stringify(oldKept) === JSON.stringify(masterOwned))

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log(`\nall checks passed`)
