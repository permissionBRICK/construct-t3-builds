// Run against the built, patched channel with T3_TEST_SOURCE=/path/to/upstream.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.ok(process.env.T3_TEST_SOURCE, 'T3_TEST_SOURCE must name a built patched checkout');
const source = resolve(process.env.T3_TEST_SOURCE);
const require = createRequire(join(source, 'scripts/package.json'));
const Effect = await import(require.resolve('effect/Effect'));
const NodeServices = await import(require.resolve('@effect/platform-node/NodeServices'));
const { createConstructWslRuntimeArchive } = await import(pathToFileURL(join(source, 'scripts/build-desktop-artifact.ts')));
const { buildWslRuntimeInstallScript } = await import(pathToFileURL(join(source, 'apps/desktop/src/wsl/DesktopWslEnvironment.ts')));
const serverRequire = createRequire(join(source, 'apps/server/package.json'));
const prebuildPath = join(dirname(serverRequire.resolve('node-pty/package.json')), 'build/Release/pty.node');
const temporary = mkdtempSync(join(tmpdir(), 'construct-wsl-test-'));
const home = join(temporary, 'home with spaces');
mkdirSync(home);
const env = { ...process.env, HOME: home, T3CODE_HOME: join(home, 't3'), NODE_PATH: '' };
const run = (file, args, options = {}) => execFileSync(file, args, { env, encoding: 'utf8', timeout: 120_000, ...options });

try {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const archive = yield* createConstructWslRuntimeArchive({
      repoRoot: source, serverDistDir: join(source, 'apps/server/dist'),
      prebuildPath, version: '0.0.41-test', arch: 'x64',
    });
    const sha = createHash('sha256').update(readFileSync(archive)).digest('hex');
    const install = buildWslRuntimeInstallScript(archive, sha, sha);
    run('/bin/sh', ['-c', install]);
    const runtime = join(home, '.t3/wsl-runtime', sha);
    const bundledServer = join(runtime, 'apps/server/dist/bin.mjs');
    const original = readFileSync(join(source, 'apps/server/dist/bin.mjs'));
    assert.deepEqual(readFileSync(bundledServer), original);
    assert.match(original.toString(), /\/\*__T3PARK v7\*\//);
    assert.match(original.toString(), /__CONSTRUCT_T3_OPENCODE_MONITOR/);
    assert.deepEqual(readFileSync(join(runtime, 'node')), readFileSync(process.execPath));
    assert.match(run(join(runtime, 't3'), ['--version']), /t3 v/);
    const finderPackage = join(runtime, 'node_modules/@ff-labs/fff-node');
    renameSync(finderPackage, `${finderPackage}.hidden`);
    try {
      assert.match(run(join(runtime, 'node'), ['--no-global-search-paths', bundledServer, '--version']), /t3 v/);
    } finally {
      renameSync(`${finderPackage}.hidden`, finderPackage);
    }
    run(join(runtime, 'node'), ['-e', `
      const p = require('node-pty').spawn('/bin/sh', ['-c', 'printf CONSTRUCT_PTY_OK'], {env:process.env});
      let output = ''; const timer = setTimeout(() => process.exit(2), 10000);
      p.onData(s => output += s);
      p.onExit(() => { clearTimeout(timer); process.exit(output.includes('CONSTRUCT_PTY_OK') ? 0 : 1); });
    `], { cwd: runtime });
    run(join(runtime, 'node'), ['--input-type=module', '-e', `
      import { FileFinder, closeLibrary } from '@ff-labs/fff-node';
      const result = FileFinder.create({basePath:process.cwd()});
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      result.value.destroy(); closeLibrary();
    `], { cwd: runtime });
    console.log('PASS WSL archive installs with the patched server, pinned Node, native PTY and file finder');

    const marker = join(runtime, '.t3code-wsl-runtime-ready');
    const digest = readFileSync(marker, 'utf8');
    const sentinel = join(runtime, 'warm-cache-sentinel');
    writeFileSync(sentinel, 'keep on warm reuse');
    run('/bin/sh', ['-c', install]);
    assert.equal(readFileSync(marker, 'utf8'), digest);
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep on warm reuse');
    // A still-runnable edited bundle must invalidate the cached runtime too.
    writeFileSync(bundledServer, Buffer.concat([original, Buffer.from('\n// changed after extraction\n')]));
    run('/bin/sh', ['-c', install]);
    assert.deepEqual(readFileSync(bundledServer), original);
    assert.equal(existsSync(sentinel), false);
    console.log('PASS WSL cache reuses the verified runtime and restores an altered server bundle');
  })).pipe(Effect.provide(NodeServices.layer)));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
