#!/usr/bin/env python3
"""Kill the CubeSandbox VMs recorded by sandbox-up.py and stop its proxy."""
import argparse, json, os, signal
from e2b_code_interpreter import Sandbox

parser = argparse.ArgumentParser()
parser.add_argument('--state', required=True)
parser.add_argument('--proxy-pid', default='/tmp/dsh-fleet-testenv-proxy.pid')
args = parser.parse_args()
items = json.load(open(args.state))
for item in items:
    if item.get('sandboxId'):
        try:
            Sandbox.connect(item['sandboxId'], timeout=60).kill()
            print('killed', item['sandboxId'])
        except Exception as error:
            print('skip', item['sandboxId'], str(error)[:120])
if os.path.exists(args.proxy_pid):
    try:
        os.kill(int(open(args.proxy_pid).read().strip()), signal.SIGKILL)
        print('proxy stopped')
    except Exception:
        pass
