// Run after a recipe build with T3_TEST_SOURCE=/path/to/the built patched upstream checkout
// and T3_TEST_INSTALLER=/path/to/T3Code-Construct-Setup.exe (needs 7z).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.ok(process.env.T3_TEST_SOURCE, 'T3_TEST_SOURCE must name the built patched checkout');
assert.ok(process.env.T3_TEST_INSTALLER, 'T3_TEST_INSTALLER must name the Windows installer built from it');
const source = resolve(process.env.T3_TEST_SOURCE);
const installer = resolve(process.env.T3_TEST_INSTALLER);
const { buildWslRuntimeInstallScript } = await import(pathToFileURL(join(source, 'apps/desktop/src/wsl/DesktopWslEnvironment.ts')));
const version = JSON.parse(readFileSync(join(source, 'apps/server/package.json'), 'utf8')).version;
const temporary = mkdtempSync(join(tmpdir(), 'construct-wsl-test-'));
const home = join(temporary, 'home with spaces');
mkdirSync(home);
const env = { ...process.env, HOME: home, T3CODE_HOME: join(home, 't3') };
const run = (file, args, options = {}) => execFileSync(file, args, { env, encoding: 'utf8', timeout: 120_000, ...options });

try {
  // The NSIS installer carries the packaged app as $PLUGINSDIR/app-64.7z.
  run('7z', ['x', '-y', `-o${temporary}`, installer, '$PLUGINSDIR/app-64.7z']);
  run('7z', ['x', '-y', `-o${join(temporary, 'app')}`, join(temporary, '$PLUGINSDIR/app-64.7z'),
    'resources/wsl-runtime.tar.gz', 'resources/wsl-runtime.tar.gz.sha256']);
  const archive = join(temporary, 'app/resources/wsl-runtime.tar.gz');
  const sha = createHash('sha256').update(readFileSync(archive)).digest('hex');
  assert.equal(readFileSync(`${archive}.sha256`, 'utf8').trim(), sha);

  // Upstream's own archive smoke test: `t3 --version` and `t3 serve` from the extracted archive.
  run(process.execPath, ['scripts/smoke-cli-archive.ts', '--archive', archive, '--expect-version', version],
    { cwd: source, stdio: 'inherit' });

  // The Desktop app installs the archive in the distro with this script (runtime id as upstream names it).
  const output = run('/bin/sh', ['-c', buildWslRuntimeInstallScript(archive, `sha256-${sha}`, sha)]);
  const runtime = /^runtimeRoot:(.+)$/m.exec(output)?.[1];
  assert.ok(runtime?.startsWith(join(home, '.t3/wsl-runtime/')), `unexpected install output: ${output}`);
  assert.ok(run(join(runtime, 't3'), ['--version']).includes(version));
  console.log('PASS the embedded WSL runtime installs with upstream\'s script and its t3 starts');

  const executable = readFileSync(join(runtime, 't3'));
  for (const code of ['__T3PARK source__', '__CONSTRUCT_T3_OPENCODE_MONITOR source__', '"voiceInput.start"',
    '"voiceInput.audio"', '"voiceInput.stop"', '"construct.diskSpace"', '"construct.vaultPending"', '"/construct/session/renew"']) {
    assert.ok(executable.includes(code), `the WSL t3 executable lacks Construct's ${code}`);
  }
  console.log('PASS the WSL t3 executable contains the patched Construct server');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
