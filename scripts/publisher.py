#!/usr/bin/env python3
"""Plan immutable builds and publish complete, verified pairs. No third-party modules."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / 'config.json').read_text())
ASSETS = ('T3Code-Construct-Setup.exe', 't3code-server-linux-x64.tar.gz', 'manifest.json', 'SHA256SUMS')


def run(*args, **kwargs):
    return subprocess.check_output([str(a) for a in args], text=True, **kwargs).strip()


def digest(path):
    with open(path, 'rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def recipe_hash(root=ROOT):
    # Only artifact-producing inputs. Workflow, README, tests, and polling changes
    # do not rebuild binaries. Explicitly bump config.formatVersion for migrations.
    paths = ['config.json', 'scripts/build.sh', 'scripts/package-linux.mjs']
    return hashlib.sha256(''.join(f'{digest(root / p)}  {p}\n' for p in paths).encode()).hexdigest()


def identity(version, patch_hash, recipe):
    return hashlib.sha256(f'{version}\nstable\n{patch_hash}\n{recipe}\n'.encode()).hexdigest()


def patch_hash(construct, inventory):
    return run('bash', '-c', '''
_FUNCS_ONLY=true source "$1/bin/build-t3code.sh"
t3_build_integration_hash "$1/bin/t3code-build-recipe.sh" "$1/bin/apply-t3code-source.mjs" \
 "$1/patches/t3code-$2/source-transforms.json" "$1/patches/t3code-$2/overlays" \
 "$1/extension/vm/construct-t3park-patch.mjs" "$1/extension/vm/construct-t3-opencode-monitor-patch.mjs"
''', 'hash', construct, inventory)


def api(url):
    headers = {'Accept': 'application/json', 'User-Agent': 'construct-t3-builds'}
    if url.startswith('https://api.github.com/') and os.getenv('GH_TOKEN'):
        headers['Authorization'] = 'Bearer ' + os.environ['GH_TOKEN']
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def complete_release(release):
    return bool(release and not release['draft'] and not release['prerelease']
                and set(ASSETS) <= {a['name'] for a in release['assets']})


def choose(version, hashes, recipe, existing, compatible):
    """Try complete inventories independently; never mix patches from two channels."""
    for inventory in ('release', 'nightly'):
        build = identity(version, hashes[inventory], recipe)
        tag = f't3-{version}-{build}'
        if existing(tag):
            return dict(inventory=inventory, tag=tag, buildHash=build, build=False,
                        sourcePatchHash=hashes[inventory])
        if compatible(inventory):
            return dict(inventory=inventory, tag=tag, buildHash=build, build=True,
                        sourcePatchHash=hashes[inventory])
    return dict(build=False, reason='Neither complete patch inventory applies to the stable source.')


def plan(work, repository, construct):
    version = api('https://registry.npmjs.org/t3/latest')['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError(f'Expected a stable npm version, got {version!r}')
    construct = construct.resolve()
    hashes = {i: patch_hash(construct, i) for i in ('release', 'nightly')}
    source = work / 'upstream'

    def compatible(inventory):
        if not source.exists():
            subprocess.run(['git', 'clone', '--quiet', '--depth', '1', '--branch', f'v{version}',
                            f'https://github.com/{CONFIG["upstreamRepository"]}.git', str(source)], check=True)
        inventory_dir = construct / f'patches/t3code-{inventory}'
        result = subprocess.run(['node', str(construct / 'bin/apply-t3code-source.mjs'), 'status',
                                 '--source', str(source), '--manifest', str(inventory_dir / 'source-transforms.json'),
                                 '--overlays', str(inventory_dir / 'overlays')], capture_output=True, text=True)
        if result.returncode not in (0, 2):
            raise RuntimeError(result.stderr or result.stdout)
        status = json.loads(result.stdout)
        if not status['compatible']:
            print(f'::warning::{inventory}: ' + '; '.join(status['conflicts']))
        return status['compatible']

    result = choose(version, hashes, recipe_hash(),
                    lambda tag: complete_release(api(f'https://api.github.com/repos/{repository}/releases/tags/{tag}')),
                    compatible)
    result.update(version=version, channel='stable', constructCommit=run('git', '-C', construct, 'rev-parse', 'HEAD'),
                  constructDirectory=str(construct), publisherRecipeHash=recipe_hash(), repository=repository,
                  publisherCommit=run('git', '-C', ROOT, 'rev-parse', 'HEAD'), **CONFIG)
    if result['build']:
        result['upstreamCommit'] = run('git', '-C', source, 'rev-parse', 'HEAD')
    (work / 'plan.json').write_text(json.dumps(result, indent=2) + '\n')
    if os.getenv('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as f:
            f.write(f'build={str(result["build"]).lower()}\n')
    summary = result.get('reason') or f'{"Build" if result["build"] else "Reuse"} {result["tag"]} ({result["inventory"]} inventory)'
    print(summary)
    if os.getenv('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as f:
            f.write(summary + '\n')


def finalize(work):
    plan = json.loads((work / 'plan.json').read_text())
    out = work / 'artifacts'
    manifest = json.loads((out / 'manifest.json').read_text())
    if manifest['version'] != plan['version'] or manifest['commit'] != plan['upstreamCommit'] or manifest['patchHash'] != plan['sourcePatchHash']:
        raise ValueError('Built sources differ from the approved plan')
    manifest.update(sourcePatchHash=manifest['patchHash'], localBuildHash=manifest['buildHash'],
                    # Host compares patchHash; include publisher recipe so runtime/packaging changes update the pair.
                    patchHash=hashlib.sha256(f'{plan["sourcePatchHash"]}\n{plan["publisherRecipeHash"]}\n'.encode()).hexdigest(),
                    buildHash=plan['buildHash'], publisherRecipeHash=plan['publisherRecipeHash'],
                    publisherCommit=plan['publisherCommit'], constructCommit=plan['constructCommit'],
                    inventory=plan['inventory'], nodeVersion=plan['nodeVersion'], target=plan['target'],
                    formatVersion=plan['formatVersion'], releaseTag=plan['tag'])
    base = f'https://github.com/{plan["repository"]}/releases/download/{plan["tag"]}'
    manifest['assets'] = {name: dict(sha256=digest(out / name), size=(out / name).stat().st_size,
                                    url=f'{base}/{name}') for name in ASSETS[:2]}
    manifest['downloadUrl'] = manifest['assets'][ASSETS[0]]['url']
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (out / 'SHA256SUMS').write_text(''.join(f'{digest(out / name)}  {name}\n' for name in ASSETS[:3]))


def publish(work):
    plan = json.loads((work / 'plan.json').read_text())
    if not plan['build']:
        return
    repository, tag = plan['repository'], plan['tag']
    out = work / 'artifacts'
    manifest = json.loads((out / 'manifest.json').read_text())
    if manifest['buildHash'] != plan['buildHash']:
        raise ValueError('Manifest does not match planned release')
    for name in ASSETS[:2]:
        if digest(out / name) != manifest['assets'][name]['sha256']:
            raise ValueError(f'Asset changed after validation: {name}')
    existing = api(f'https://api.github.com/repos/{repository}/releases/tags/{tag}')
    if complete_release(existing):
        print('Already published; preserving immutable assets.')
        return
    if existing and not existing['draft']:
        raise ValueError('Published release is incomplete; refusing to modify published assets')
    if not existing:
        notes = work / 'release-notes.md'
        notes.write_text(f'Patched T3 Code **{plan["version"]}**, stable channel, using the **{plan["inventory"]}** inventory.\n\n'
                         f'Windows x64 installer and Ubuntu 24.04 x64 server runtime (bundled Node {plan["nodeVersion"]}). '
                         'The Windows installer is unsigned.\n\n'
                         f'Construct: https://github.com/{CONFIG["constructRepository"]}/commit/{plan["constructCommit"]}\n\n'
                         f'Upstream: https://github.com/{CONFIG["upstreamRepository"]}/commit/{plan["upstreamCommit"]}\n\n'
                         f'Build identity: `{tag}`. See `manifest.json` for exact inputs and checksums.\n')
        run('gh', 'release', 'create', tag, '--repo', repository, '--draft', '--target', plan['publisherCommit'],
            '--title', f'T3 Code {plan["version"]} · Construct {plan["buildHash"][:12]}', '--notes-file', notes)
    run('gh', 'release', 'upload', tag, *[out / n for n in ASSETS], '--repo', repository, '--clobber')
    # Verify the uploaded bytes while the release is still hidden from consumers.
    downloaded = work / 'uploaded'
    downloaded.mkdir(exist_ok=True)
    run('gh', 'release', 'download', tag, '--repo', repository, '--dir', downloaded, '--clobber')
    for name in ASSETS:
        if digest(downloaded / name) != digest(out / name):
            raise ValueError(f'Uploaded checksum mismatch: {name}')
    run('gh', 'release', 'edit', tag, '--repo', repository, '--draft=false', '--latest')
    print(f'Published https://github.com/{repository}/releases/tag/{tag}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['plan', 'finalize', 'publish'])
    parser.add_argument('--work', type=Path, default=ROOT / 'work')
    parser.add_argument('--repository', default='permissionBRICK/construct-t3-builds')
    parser.add_argument('--construct', type=Path, default=ROOT / 'work/construct')
    args = parser.parse_args()
    args.work = args.work.resolve()
    args.work.mkdir(parents=True, exist_ok=True)
    if args.command == 'plan':
        plan(args.work, args.repository, args.construct)
    elif args.command == 'finalize':
        finalize(args.work)
    else:
        publish(args.work)
