#!/usr/bin/env python3
"""Test the extracted runtime in isolation, including a native PTY and HTTP UI."""
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

with tempfile.TemporaryDirectory(prefix='t3-runtime-smoke-') as directory:
    root = Path(directory)
    runtime = root / 'runtime'
    runtime.mkdir()
    subprocess.run(['tar', '-xzf', sys.argv[1], '-C', str(runtime)], check=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(('T3CODE_', 'NODE_'))}
    env.update(HOME=str(root / 'home'), XDG_CONFIG_HOME=str(root / 'config'), XDG_CACHE_HOME=str(root / 'cache'))
    subprocess.run([runtime / 'bin/t3', '--help'], cwd=root, env=env, check=True, stdout=subprocess.DEVNULL)
    subprocess.run([runtime / 'bin/node', '-e', '''
const pty = require('node-pty');
const p = pty.spawn('/bin/sh', ['-c', 'printf CONSTRUCT_PTY_OK'], {env:process.env});
let output = ''; const timer = setTimeout(() => process.exit(2), 10000);
p.onData(s => output += s); p.onExit(() => {clearTimeout(timer); process.exit(output.includes('CONSTRUCT_PTY_OK') ? 0 : 1)});
'''], cwd=runtime, env=env, check=True)
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
    with open(root / 'server.log', 'w+') as log:
        process = subprocess.Popen([runtime / 'bin/t3', '--host', '127.0.0.1', '--port', str(port),
                                    '--no-browser', '--base-dir', str(root / 'data')], cwd=root, env=env,
                                   stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(120):
                if process.poll() is not None:
                    raise RuntimeError('Isolated server exited early')
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=1) as r:
                        body = r.read().decode()
                        assert r.status == 200 and '<html' in body.lower(), 'Missing web UI'
                    break
                except (urllib.error.URLError, TimeoutError):
                    time.sleep(.5)
            else:
                raise RuntimeError('Isolated server never served its web UI')
            print('PASS: extracted runtime starts, native PTY works, HTTP serves the built web UI')
        except Exception:
            log.seek(0)
            print(log.read())
            raise
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
