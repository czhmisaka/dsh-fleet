#!/usr/bin/env python3
"""Create N CubeSandbox microVMs, install DSH in each, start it, and expose
HTTP proxies on the sandbox host. Run on the CubeSandbox host with the E2B venv
interpreter. Prints one JSON document to stdout."""
import argparse, json, os, re, subprocess, threading

os.environ.setdefault('E2B_API_URL', 'http://127.0.0.1:3000')
os.environ.setdefault('E2B_API_KEY', 'e2b_000000')
from e2b_code_interpreter import Sandbox

INSTALL = r"""
set -e
export PATH=/opt/node-v24.16.0-linux-x64/bin:$PATH
if [ ! -x /opt/node-v24.16.0-linux-x64/bin/dsh ]; then
  # one-time bootstrap (a baked template skips this branch entirely)
  if [ ! -x /opt/node-v24.16.0-linux-x64/bin/node ]; then
    curl -fsSL --retry 3 -o /tmp/node24.tar.xz https://registry.npmmirror.com/-/binary/node/v24.16.0/node-v24.16.0-linux-x64.tar.xz
    python3 -c "import tarfile; tarfile.open('/tmp/node24.tar.xz','r:xz').extractall('/opt')"
    rm -f /tmp/node24.tar.xz
  fi
  npm i -g --cache /tmp/npmcache @deepseek-ai/dsh@0.2.2-rc.1 > /tmp/npm.log 2>&1 || { tail -40 /tmp/npm.log; exit 11; }
  rm -rf /tmp/npmcache
fi
IP=$(hostname -I | awk '{print $1}')
nohup dsh web --no-open --host $IP --port 3080 --trusted-host 3080-{sid}.cube.app > /tmp/dsh.log 2>&1 &
sleep 18
grep -o 'http://[^ ]*token=[A-Za-z0-9_-]*' /tmp/dsh.log | tail -1
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

results, lock = [], threading.Lock()

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


def one(index, args):
    name = f"{args.prefix}{index}"
    try:
        sb = Sandbox.create(template=args.template, timeout=args.ttl)
        sid = sb.sandbox_id
        out = ''
        for attempt in range(2):
            try:
                r = sb.commands.run(INSTALL.replace('{sid}', sid), timeout=1800)
                out = r.stdout or ''
                if r.exit_code == 0:
                    break
            except Exception as error:
                out = str(error)
        match = re.search(r'http://[^ ]*token=([A-Za-z0-9_-]*)', out)
        token = match.group(1) if match else ''
        info = {'name': name, 'sandboxId': sid, 'token': token, 'port': args.base_port + index - 1,
                'dshUrl': f'http://{args.public_host}:{args.base_port + index - 1}'}
        if token == '':
            info['error'] = 'DSH token not found: ' + out[-1200:]
        with lock:
            results.append(info); json.dump(results, open(args.state, 'w'), indent=2)
        print(name, 'ok' if token else 'FAILED', flush=True)
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
    parser.add_argument('--ttl', type=int, default=7200)
    parser.add_argument('--e2b-url', default='http://127.0.0.1:3000')
    parser.add_argument('--e2b-key', default='e2b_000000')
    parser.add_argument('--state', default='/tmp/dsh-fleet-testenv-sandboxes.json')
    parser.add_argument('--proxy-script', default='/tmp/dsh-fleet-testenv-proxy.js')
    parser.add_argument('--proxy-pid', default='/tmp/dsh-fleet-testenv-proxy.pid')
    args = parser.parse_args()
    json.dump([], open(args.state, 'w'))
    os.environ['E2B_API_URL'] = args.e2b_url
    os.environ['E2B_API_KEY'] = args.e2b_key

    threads = [threading.Thread(target=one, args=(i, args)) for i in range(1, args.count + 1)]
    for thread in threads: thread.start()
    for thread in threads: thread.join()

    ok = [item for item in results if 'error' not in item and item.get('token')]
    if len(ok) != args.count:
        print(json.dumps({'ok': False, 'instances': results}, ensure_ascii=False))
        raise SystemExit(1)
    # continue with the successful set

    kill_listeners(range(args.base_port, args.base_port + args.count))
    open(args.proxy_script, 'w').write(PROXY)
    targets = {str(item['port']): f"3080-{item['sandboxId']}.cube.app" for item in ok}
    if os.path.exists(args.proxy_pid):
        try:
            os.kill(int(open(args.proxy_pid).read().strip()), 9)
        except Exception:
            pass
    proc = subprocess.Popen(['node', args.proxy_script, json.dumps(targets)],
                            stdout=open('/tmp/dsh-fleet-testenv-proxy.log', 'a'), stderr=subprocess.STDOUT,
                            start_new_session=True)
    open(args.proxy_pid, 'w').write(str(proc.pid))
    print(json.dumps({'ok': True, 'proxyPid': proc.pid, 'instances': ok}, ensure_ascii=False))

if __name__ == '__main__':
    main()
