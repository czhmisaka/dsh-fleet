#!/usr/bin/env node
// Renew the CubeSandbox leases only — no sandbox is rebuilt, no Node/DSH is
// reinstalled, nothing is registered with the master.
//
// The platform's `timeout` field is the *lease*: the sandbox is killed when
// `endAt` passes (default on_timeout = kill). `POST /sandboxes/<sid>/timeout`
// extends the lease from now, so a 30-day lease can be pushed forward any time.
//
//   node test-env/renew.mjs                      # renew every live cube sandbox
//   node test-env/renew.mjs --ttl 2592000        # explicit lease length (default 2592000 = 30d)
//   node test-env/renew.mjs --id <sandbox-id>     # one sandbox only
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const configPath = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : join(here, 'config.json')
const config = JSON.parse(readFileSync(configPath, 'utf8'))

const cli = { ttl: undefined, id: undefined }
const argv = process.argv.slice(2)
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (!arg.startsWith('--')) continue
  const key = arg.slice(2)
  const next = argv[index + 1]
  if (next !== undefined && !next.startsWith('--')) { cli[key] = next; index += 1 } else { cli[key] = 'true' }
}
const ttl = Number(cli.ttl ?? config.sandboxTtlSeconds ?? 2592000)
if (!Number.isFinite(ttl) || ttl < 60) throw new Error(`bad ttl: ${String(cli.ttl)}`)

// One shell command on the sandbox host: list the live sandboxes, extend each
// lease, print the new endAt. No e2b SDK, no rebuild.
const script = `
set -e
KEY='e2b_000000'
API='http://127.0.0.1:3000'
for sid in $(curl -s -m 20 -H "X-API-Key: $KEY" $API/sandboxes | python3 -c "
import json,sys
want='${cli.id ?? ''}'
for x in json.load(sys.stdin):
    if x.get('state') != 'running': continue
    name=(x.get('metadata') or {}).get('dsh-fleet-name','')
    if want:
        if x['sandboxID'] != want and name != want: continue
    elif not name:
        continue
    print(x['sandboxID'])
"); do
  body=$(printf '{"timeout":%s}' "${ttl}")
  code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$API/sandboxes/$sid/timeout" -H "X-API-Key: $KEY" -H 'content-type: application/json' -d "$body")
  end=$(curl -s -m 20 -H "X-API-Key: $KEY" "$API/sandboxes/$sid" | python3 -c "import json,sys; print(json.load(sys.stdin).get('endAt'))")
  echo "$sid  http=$code  endAt=$end"
done
`

console.log(`· renewing cube sandbox leases to ${ttl}s (${(ttl / 86400).toFixed(1)} days)…`)
const output = execFileSync('ssh', [config.sandboxHost, script], { encoding: 'utf8' })
console.log(output.trim())
