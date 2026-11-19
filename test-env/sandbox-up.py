#!/usr/bin/env python3
"""Create/reuse N CubeSandbox microVMs, install DSH **and the dsh-fleet
plugin** in each, start it, and publish the host port mapping.

Run on the CubeSandbox host with the E2B venv interpreter.
Prints one JSON document to stdout.

What this script owns:
  * the sandboxes tagged with the `dsh-fleet-name` metadata (cube-1, cube-2, ...)
  * the host ports `proxyBasePort .. proxyBasePort+count-1` (13181, 13182, ...)

Reuse rules: a sandbox that is still alive AND still carries our name metadata
is reused (its lease is renewed with `Sandbox.connect(sid, timeout=ttl)`), so a
re-run does not orphan the fleet entries that point at it.
"""
import argparse, json, os, re, shutil, subprocess, threading, time

os.environ.setdefault('E2B_API_URL', 'http://127.0.0.1:3000')
os.environ.setdefault('E2B_API_KEY', 'e2b_000000')
from e2b_code_interpreter import Sandbox

NAME_KEY = 'dsh-fleet-name'
AGENT_KEY = 'dsh-fleet-agent-key'
PLUGIN_TAR_IN_SANDBOX = '/tmp/dsh-fleet-plugin.tar.gz'

# ---------------------------------------------------------------------------
# Inside the sandbox
# ---------------------------------------------------------------------------

# 1) DSH itself. npmmirror first: CubeEgress to nodejs.org is very slow.
INSTALL_DSH = r"""
set -e
export PATH=/opt/node-v24.16.0-linux-x64/bin:$PATH
if [ ! -x /opt/node-v24.16.0-linux-x64/bin/dsh ]; then
  if [ ! -x /opt/node-v24.16.0-linux-x64/bin/node ]; then
    curl -fsSL --retry 3 -o /tmp/node24.tar.xz https://registry.npmmirror.com/-/binary/node/v24.16.0/node-v24.16.0-linux-x64.tar.xz
    python3 -c "import tarfile; tarfile.open('/tmp/node24.tar.xz','r:xz').extractall('/opt')"
    rm -f /tmp/node24.tar.xz
  fi
  npm i -g --registry https://registry.npmmirror.com --cache /tmp/npmcache @deepseek-ai/dsh@0.2.2-rc.1 > /tmp/npm.log 2>&1 \
    || npm i -g --cache /tmp/npmcache @deepseek-ai/dsh@0.2.2-rc.1 > /tmp/npm.log 2>&1 \
    || { tail -40 /tmp/npm.log; exit 11; }
  rm -rf /tmp/npmcache
fi
/opt/node-v24.16.0-linux-x64/bin/dsh --version || true
"""

# 2) dsh-fleet plugin + profile wiring + start DSH.
#    The plugin has to be in the sandbox *before* `dsh web` boots, otherwise
#    __DSH_BOOT__.entries never lists dsh-fleet and the master never gets a
#    dshf:ready handshake.
PLUGIN_AND_BOOT = r"""
set -e
export PATH=/opt/node-v24.16.0-linux-x64/bin:$PATH
python3 - <<'PYEOF'
import json, os, pathlib, tarfile

home = pathlib.Path(os.path.expanduser('~'))
profile = home / '.dsh' / 'profiles' / 'web'
plugin = profile / 'plugins' / 'dsh-fleet'
profile.mkdir(parents=True, exist_ok=True)
plugin.parent.mkdir(parents=True, exist_ok=True)

# --- unpack the plugin -----------------------------------------------------
tar_path = pathlib.Path('__PLUGIN_TAR__')
if not tar_path.exists():
    raise SystemExit('PLUGIN_TAR_MISSING')
with tarfile.open(tar_path, 'r:gz') as tf:
    tf.extractall(plugin)
if not (plugin / 'index.js').exists():
    raise SystemExit('PLUGIN_EXTRACT_FAILED')
if not (plugin / 'package.json').exists():
    raise SystemExit('PLUGIN_PACKAGE_JSON_MISSING')

# --- the bundle's own patch decides the role -------------------------------
# The plugin ships `cordis.patch.yml` with `role: master`. In the sandbox the
# profile-level override does not always win, so the *bundle* patch itself is
# rewritten to the agent role; then both layers agree and the sandbox really
# runs as an agent (master half off, /fleet-agent/* registered).
plugin_patch = plugin / 'cordis.patch.yml'
plugin_patch.write_text(
    '- insert:\n'
    '    - id: dsh-fleet\n'
    '      name: dsh-fleet\n'
    '      config:\n'
    '        role: agent\n'
    '        roles:\n'
    '          - agent\n'
    '        agentKey: __AGENT_KEY__\n'
)

# --- profile manifest ------------------------------------------------------
pkg_path = profile / 'package.json'
if pkg_path.exists():
    pkg = json.loads(pkg_path.read_text())
else:
    pkg = {
        'name': 'dsh-profile-web',
        'private': True,
        'dependencies': {},
        'dsh': {'profile': {'bundles': ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']}},
    }
profile_cfg = pkg.setdefault('dsh', {}).setdefault('profile', {})
bundles = list(profile_cfg.get('bundles') or ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
if 'dsh-fleet' not in bundles:
    bundles.append('dsh-fleet')
profile_cfg['bundles'] = bundles
# The profile patch only reaches the *running* entry when the profile watches
# its patch file; without this the composed tree carries `role: agent` but the
# live plugin keeps its default config and the /fleet-agent/* routes stay off.
profile_cfg['patchReload'] = 'live'
deps = pkg.setdefault('dependencies', {})
deps['dsh-fleet'] = 'link:./plugins/dsh-fleet'
pkg_path.write_text(json.dumps(pkg, indent=2) + '\n')

# --- node_modules link so the loader can resolve the bundle ----------------
modules = profile / 'node_modules'
modules.mkdir(parents=True, exist_ok=True)
link = modules / 'dsh-fleet'
if link.is_symlink() or link.exists():
    link.unlink()
link.symlink_to(os.path.join('..', 'plugins', 'dsh-fleet'))

# --- pnpm settings (same template the harness writes) ----------------------
ws = profile / 'pnpm-workspace.yaml'
if not ws.exists():
    ws.write_text('packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')

# --- loader entry in the profile patch -------------------------------------
# The harness writes a template that ends with a literal `[]` (an empty flow
# sequence). Appending a row *after* that is invalid YAML:
#   "end of the stream or a document separator is expected (5:1)"
# so the marker has to go and the row becomes the sequence itself.
patch = profile / 'cordis.patch.yml'
text = patch.read_text() if patch.exists() else '# Your patch layer for this dsh profile, applied after every bundle layer:\n'
kept, skip = [], False
for line in text.splitlines():
    if line.strip() == '[]':
        continue                      # drop the empty-sequence marker
    if line.startswith('- ') and not line.startswith('-  '):
        skip = line.strip().startswith('- id: dsh-fleet')
    if not skip:
        kept.append(line)
row = (
    '- id: dsh-fleet\n'
    '  name: dsh-fleet\n'
    '  config:\n'
    '    role: agent\n'
    '    roles:\n'
    '      - agent\n'
    '    agentKey: __AGENT_KEY__\n'
)
patch.write_text('\n'.join(kept).rstrip('\n') + '\n' + row)
try:
    import yaml  # noqa: F401
    yaml.safe_load(patch.read_text())
    print('PATCH_YAML_OK')
except ImportError:
    print('PATCH_YAML_SKIPPED')
except Exception as error:
    raise SystemExit(f'PATCH_YAML_INVALID {error}')
print('PLUGIN_SETUP_OK')
PYEOF

# Stop a DSH left over from an earlier boot so the new one really loads the plugin.
python3 - <<'PYEOF'
import glob, os, signal
needle = 'dsh' + ' ' + 'web'          # never spelled out in this script
mark = 'dsh-fleet-boot-marker-9f2c'   # our own shell carries it -> never killed
skip = {os.getpid(), os.getppid()}
for path in glob.glob('/proc/[0-9]*/cmdline'):
    try:
        pid = int(path.split('/')[2])
    except ValueError:
        continue
    if pid in skip:
        continue
    try:
        cmd = open(path, 'rb').read().decode('utf-8', 'ignore').replace('\0', ' ')
    except Exception:
        continue
    if mark in cmd or 'start-dsh.sh' in cmd:
        continue
    if needle in cmd:
        try:
            os.kill(pid, signal.SIGTERM)
            print('stopped previous dsh pid', pid)
        except Exception:
            pass
PYEOF
sleep 2

cat > /tmp/start-dsh.sh <<'SCRIPT'
#!/bin/sh
export PATH=/opt/node-v24.16.0-linux-x64/bin:$PATH
IP=$(hostname -I | awk '{print $1}')
exec dsh web --no-open --host $IP --port 3080 --trusted-host "$DSH_FLEET_SID".cube.app
SCRIPT
chmod +x /tmp/start-dsh.sh
DSH_FLEET_SID=3080-{sid} nohup /tmp/start-dsh.sh > /tmp/dsh.log 2>&1 &
echo $! > /tmp/dsh.pid

IP=$(hostname -I | awk '{print $1}')
for i in $(seq 1 40); do
  if grep -q 'token=' /tmp/dsh.log 2>/dev/null; then break; fi
  sleep 3
done
sleep 3
echo "---- token ----"
grep -o 'http://[^ ]*token=[A-Za-z0-9_-]*' /tmp/dsh.log | tail -1 || true
echo "---- dsh-fleet boot log ----"
grep -F '[dsh-fleet]' /tmp/dsh.log | tail -3 || true
echo "---- page entries ----"
TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' /tmp/dsh.log | tail -1 | cut -d= -f2)
rm -f /tmp/dsh-cookie
curl -s -c /tmp/dsh-cookie -b /tmp/dsh-cookie -L "http://$IP:3080/?token=$TOKEN" -o /tmp/dsh-page.html || true
grep -o '"id":"dsh-fleet"' /tmp/dsh-page.html | head -1 || true
echo "---- http code ----"
curl -s -o /dev/null -w '%{http_code}\n' -c /tmp/dsh-cookie -b /tmp/dsh-cookie -L "http://$IP:3080/?token=$TOKEN" || true
echo "---- dsh fleet role ----"
grep -F '[dsh-fleet]' /tmp/dsh.log | tail -2 || true
exit 0
"""

PROXY = r"""
const http = require('node:http')
const https = require('node:https')
const targets = JSON.parse(process.argv[2])
for (const [portText, host] of Object.entries(targets)) {
  const port = Number(portText)
  const server = http.createServer((req, res) => {
    const upstream = https.request({ host: '127.0.0.1', port: 443, method: req.method, path: req.url,
      servername: host, rejectUnauthorized: false, headers: { ...req.headers, host } },
      (upstreamRes) => { res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers); upstreamRes.pipe(res) })
    upstream.on('error', (error) => { res.writeHead(502); res.end(String(error)) })
    req.pipe(upstream)
  })
  server.on('upgrade', (req, socket, head) => {
    const upstream = https.request({ host: '127.0.0.1', port: 443, method: req.method, path: req.url,
      servername: host, rejectUnauthorized: false,
      headers: { ...req.headers, host, connection: 'Upgrade', upgrade: req.headers.upgrade } })
    upstream.on('upgrade', (res, proxySocket, proxyHead) => {
      let headBuf = Buffer.from(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`)
      for (let i = 0; i < res.rawHeaders.length; i += 2) headBuf = Buffer.concat([headBuf, Buffer.from(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`)])
      socket.write(Buffer.concat([headBuf, Buffer.from('\r\n'), proxyHead ?? Buffer.alloc(0), head ?? Buffer.alloc(0)]))
      proxySocket.pipe(socket); socket.pipe(proxySocket)
    })
    upstream.on('error', () => socket.destroy())
    upstream.end()
  })
  server.listen(port, '0.0.0.0', () => console.log('proxy', port, '->', host))
}
"""

SYSTEMD_PROXY_SCRIPT = os.path.expanduser('~/dsh工作分区/cubesandbox/cube-http-proxy.js')
SYSTEMD_PROXY_UNIT = 'cube-http-proxy.service'

results, lock = [], threading.Lock()


# ---------------------------------------------------------------------------
# host helpers
# ---------------------------------------------------------------------------

def kill_listeners(ports):
    try:
        out = subprocess.check_output(['ss', '-ltnp'], text=True, stderr=subprocess.DEVNULL)
    except Exception:
        return
    for port in ports:
        for line in out.splitlines():
            if f':{port} ' not in line:
                continue
            match = re.search(r'pid=(\d+)', line)
            if match is None:
                continue
            try:
                os.kill(int(match.group(1)), 9)
                print(f'killed stale listener on {port} (pid {match.group(1)})', flush=True)
            except Exception:
                pass


def systemd_proxy_targets(path):
    """Read the port -> cube.app host map out of the host proxy script."""
    if not os.path.exists(path):
        return {}
    text = open(path, encoding='utf-8').read()
    match = re.search(r'const targets = \{(.*?)\n\}', text, re.S)
    if match is None:
        return {}
    out = {}
    for port, host in re.findall(r'(\d+)\s*:\s*[\'"]([^\'"]+)[\'"]', match.group(1)):
        out[port] = host
    return out


def update_systemd_proxy(targets, owned_ports):
    """Point the systemd-managed host proxy at the new sandboxes.

    The systemd unit owns 13181/13182; a second proxy process would fight it
    for the port, so we rewrite the unit's target map and restart it.
    """
    if not os.path.exists(SYSTEMD_PROXY_SCRIPT):
        return False
    # A stale proxy process (from an earlier run) can still hold the ports;
    # the systemd unit would then fail to bind and the stale mapping would
    # keep serving dead sandboxes (the host answers 404).
    kill_listeners(owned_ports)
    time.sleep(1)
    current = systemd_proxy_targets(SYSTEMD_PROXY_SCRIPT)
    merged = dict(current)
    for port in owned_ports:
        merged.pop(str(port), None)
    merged.update({str(port): host for port, host in targets.items()})
    text = open(SYSTEMD_PROXY_SCRIPT, encoding='utf-8').read()
    block = 'const targets = {\n' + ''.join(f"  {port}: '{host}',\n" for port, host in sorted(merged.items(), key=lambda item: int(item[0]))) + '}\n'
    new_text, count = re.subn(r'const targets = \{.*?\n\}\n', block, text, count=1, flags=re.S)
    if count != 1:
        return False
    backup = f'{SYSTEMD_PROXY_SCRIPT}.bak-testenv'
    shutil.copyfile(SYSTEMD_PROXY_SCRIPT, backup)
    open(SYSTEMD_PROXY_SCRIPT, 'w', encoding='utf-8').write(new_text)
    try:
        subprocess.check_call(['systemctl', '--user', 'restart', SYSTEMD_PROXY_UNIT])
    except Exception as error:
        print(f'systemd restart failed: {error}', flush=True)
        shutil.copyfile(backup, SYSTEMD_PROXY_SCRIPT)
        subprocess.call(['systemctl', '--user', 'restart', SYSTEMD_PROXY_UNIT])
        return False
    time.sleep(2)
    print(f'systemd proxy targets: {json.dumps(merged)}', flush=True)
    return True


def start_standalone_proxy(targets, args):
    """Fallback: run our own proxy when the systemd unit is not available."""
    kill_listeners(range(args.base_port, args.base_port + args.count))
    open(args.proxy_script, 'w').write(PROXY)
    if os.path.exists(args.proxy_pid):
        try:
            os.kill(int(open(args.proxy_pid).read().strip()), 9)
        except Exception:
            pass
    proc = subprocess.Popen(['node', args.proxy_script, json.dumps(targets)],
                             stdout=open('/tmp/dsh-fleet-testenv-proxy.log', 'a'), stderr=subprocess.STDOUT,
                             start_new_session=True)
    open(args.proxy_pid, 'w').write(str(proc.pid))
    return proc.pid


# ---------------------------------------------------------------------------
# sandbox helpers
# ---------------------------------------------------------------------------

def list_alive():
    """Every sandbox the platform still knows about (paginated)."""
    alive = []
    paginator = Sandbox.list()
    while paginator.has_next:
        alive.extend(paginator.next_items())
    return alive


def previous_state(path):
    try:
        return json.load(open(path, encoding='utf-8'))
    except Exception:
        return []


def find_reusable(alive, name, state):
    """Find a live sandbox that already belongs to `name`."""
    for info in alive:
        metadata = getattr(info, 'metadata', None) or {}
        if metadata.get(NAME_KEY) == name:
            return info.sandbox_id
    for item in state:
        if item.get('name') == name and item.get('sandboxId'):
            sid = item['sandboxId']
            for info in alive:
                if info.sandbox_id == sid:
                    return sid
    return None


def run_in_sandbox(sb, sid, args, agent_key, plugin_tar):
    """Install DSH + the plugin, boot it, and read the token back."""
    if args.plugin_tar and os.path.exists(args.plugin_tar):
        with open(args.plugin_tar, 'rb') as handle:
            sb.files.write(PLUGIN_TAR_IN_SANDBOX, handle, request_timeout=900)
    output = ''
    # 1) DSH itself (skipped when the template already carries it).
    try:
        install = sb.commands.run(INSTALL_DSH, timeout=2400)
        output += (install.stdout or '') + '\n'
        if install.exit_code != 0:
            output += (install.stderr or '')
    except Exception as error:
        output += f'INSTALL_DSH_ERROR {error}\n'
    # 2) plugin + profile wiring + boot.
    boot = (PLUGIN_AND_BOOT
            .replace('__PLUGIN_TAR__', PLUGIN_TAR_IN_SANDBOX)
            .replace('__AGENT_KEY__', agent_key)
            .replace('{sid}', sid))
    for attempt in range(2):
        try:
            result = sb.commands.run(boot, timeout=2400)
            output += result.stdout or ''
            if result.exit_code == 0:
                break
            output += '\n' + (result.stderr or '')
        except Exception as error:
            output += str(error)
    # The token is read back from the sandbox's own log: it is the only
    # authoritative source (a retried boot prints a *new* token).
    token = ''
    try:
        probe = sb.commands.run("grep -o 'token=[A-Za-z0-9_-]*' /tmp/dsh.log | tail -1", timeout=120)
        found = re.findall(r'token=([A-Za-z0-9_-]+)', probe.stdout or '')
        if found:
            token = found[-1]
    except Exception as error:
        output += f'\nTOKEN_PROBE_ERROR {error}\n'
    if token == '':
        found = re.findall(r'http://[^ ]*token=([A-Za-z0-9_-]*)', output)
        token = found[-1] if found else ''
    return token, output


def one(index, args):
    name = f"{args.prefix}{index}"
    port = args.base_port + index - 1
    try:
        alive = list_alive()
        state = previous_state(args.state)
        sid = find_reusable(alive, name, state)
        reused = sid is not None
        if sid is None:
            sb = Sandbox.create(template=args.template, timeout=args.ttl,
                                 metadata={NAME_KEY: name, AGENT_KEY: args.agent_key})
            sid = sb.sandbox_id
            print(f'{name}: created sandbox {sid}', flush=True)
        else:
            print(f'{name}: reusing live sandbox {sid}', flush=True)
        sb = Sandbox.connect(sid, timeout=args.ttl)
        token, output = run_in_sandbox(sb, sid, args, args.agent_key, args.plugin_tar)
        info = {'name': name, 'sandboxId': sid, 'token': token, 'port': port,
                'dshUrl': f'http://{args.public_host}:{port}',
                'agentUrl': f'http://{args.public_host}:{port}/fleet-agent',
                'reused': reused, 'ttl': args.ttl}
        if token == '':
            info['error'] = 'DSH token not found: ' + output[-1600:]
        if 'PLUGIN_SETUP_OK' not in output:
            info['pluginError'] = 'plugin setup marker missing'
        with lock:
            results.append(info)
            json.dump(results, open(args.state, 'w'), indent=2)
        print(name, 'ok' if token else 'FAILED', '(reused)' if reused else '(new)', flush=True)
    except Exception as error:
        with lock:
            results.append({'name': name, 'error': str(error)[:800]})
            json.dump(results, open(args.state, 'w'), indent=2)
        print(name, 'ERROR', str(error)[:300], flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--count', type=int, default=2)
    parser.add_argument('--prefix', default='cube-')
    parser.add_argument('--template', required=True)
    parser.add_argument('--base-port', type=int, default=13181)
    parser.add_argument('--public-host', required=True)
    parser.add_argument('--ttl', type=int, default=604800)
    parser.add_argument('--e2b-url', default='http://127.0.0.1:3000')
    parser.add_argument('--e2b-key', default='e2b_000000')
    parser.add_argument('--state', default='/tmp/dsh-fleet-testenv-sandboxes.json')
    parser.add_argument('--proxy-script', default='/tmp/dsh-fleet-testenv-proxy.js')
    parser.add_argument('--proxy-pid', default='/tmp/dsh-fleet-testenv-proxy.pid')
    parser.add_argument('--agent-key', default='')
    parser.add_argument('--plugin-tar', default='')
    args = parser.parse_args()
    os.environ['E2B_API_URL'] = args.e2b_url
    os.environ['E2B_API_KEY'] = args.e2b_key
    if not args.agent_key:
        raise SystemExit('--agent-key is required (the sandbox agent must share the master fleet key)')

    state = previous_state(args.state)
    json.dump([], open(args.state, 'w'))

    threads = [threading.Thread(target=one, args=(i, args)) for i in range(1, args.count + 1)]
    for thread in threads: thread.start()
    for thread in threads: thread.join()

    ok = [item for item in results if 'error' not in item and item.get('token')]
    if len(ok) != args.count:
        print(json.dumps({'ok': False, 'instances': results}, ensure_ascii=False))
        raise SystemExit(1)

    targets = {str(item['port']): f"3080-{item['sandboxId']}.cube.app" for item in ok}
    owned = [item['port'] for item in ok]
    proxy_pid = None
    if not update_systemd_proxy(targets, owned):
        proxy_pid = start_standalone_proxy(targets, args)
    print(json.dumps({'ok': True, 'proxyPid': proxy_pid, 'instances': ok}, ensure_ascii=False))


if __name__ == '__main__':
    main()
