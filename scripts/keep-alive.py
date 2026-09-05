#!/usr/bin/env python3
import base64
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess

path = '.github/activity.json'
content = json.dumps({'month': datetime.now(timezone.utc).strftime('%Y-%m')}) + '\n'
if Path(path).exists() and Path(path).read_text() == content:
    raise SystemExit(0)
endpoint = f'repos/{os.environ["GITHUB_REPOSITORY"]}/contents/{path}'
previous = subprocess.run(['gh', 'api', endpoint], capture_output=True, text=True)
body = {'message': 'chore: keep upstream polling active', 'content': base64.b64encode(content.encode()).decode(), 'branch': 'main'}
if previous.returncode == 0:
    body['sha'] = json.loads(previous.stdout)['sha']
elif '404' not in previous.stderr:
    raise RuntimeError(previous.stderr)
subprocess.run(['gh', 'api', endpoint, '--method', 'PUT', '--input', '-'],
               input=json.dumps(body), text=True, stdout=subprocess.DEVNULL, check=True)
