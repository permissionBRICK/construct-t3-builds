#!/usr/bin/env node
// Package exactly the external runtime dependency closure from the compiled
// checkout. Keep separate dependency instances and internal relative links;
// never copy the workspace's dev dependencies or depend on its absolute paths.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const [source, destination, nodeBinary] = process.argv.slice(2).map(x => path.resolve(x));
if (fs.existsSync(destination)) throw new Error('Package destination must be new');
const { selectCliRuntimeExternalDependencies } = await import(pathToFileURL(path.join(source, 'scripts/lib/cli-external-packages.ts')));
const server = path.join(source, 'apps/server');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const roots = Object.keys(selectCliRuntimeExternalDependencies(json(path.join(server, 'package.json')).dependencies));
const seen = new Map();
fs.mkdirSync(destination, {recursive:true});
fs.cpSync(path.join(server, 'dist'), path.join(destination, 'apps/server/dist'), {recursive:true});

function locate(name, from) {
  const require = createRequire(path.join(from, 'package.json'));
  for (const base of require.resolve.paths(name) ?? []) {
    const p = path.join(base, name);
    if (fs.existsSync(path.join(p, 'package.json'))) return fs.realpathSync(p);
  }
  return null;
}
function link(name, target, parent) {
  const p = path.join(parent, 'node_modules', name);
  fs.mkdirSync(path.dirname(p), {recursive:true});
  if (!fs.existsSync(p)) fs.symlinkSync(path.relative(path.dirname(p), target), p);
}
function copyPackage(original) {
  if (seen.has(original)) return seen.get(original);
  const pkg = json(path.join(original, 'package.json'));
  const key = createHash('sha256').update(path.relative(source, original)).digest('hex').slice(0,16);
  const target = path.join(destination, 'packages', key);
  seen.set(original, target);
  fs.cpSync(original, target, {recursive:true, dereference:true,
    filter: p => path.basename(p) !== 'node_modules'});
  const optional = {...pkg.optionalDependencies};
  const dependencies = {...pkg.peerDependencies, ...pkg.dependencies, ...optional};
  for (const [name] of Object.entries(dependencies)) {
    const resolved = locate(name, original);
    if (!resolved) {
      if (name in optional || pkg.peerDependenciesMeta?.[name]?.optional) continue;
      throw new Error(`Missing dependency ${pkg.name} -> ${name}`);
    }
    link(name, copyPackage(resolved), target);
  }
  return target;
}
for (const name of roots) {
  const original = locate(name, server);
  if (!original) throw new Error(`Missing external root ${name}`);
  link(name, copyPackage(original), destination);
}
fs.mkdirSync(path.join(destination, 'bin'));
fs.copyFileSync(nodeBinary, path.join(destination, 'bin/node'));
fs.chmodSync(path.join(destination, 'bin/node'), 0o755);
fs.writeFileSync(path.join(destination, 'bin/t3'), `#!/bin/sh
set -eu
runtime="$(CDPATH='' cd -- "$(dirname -- "$(readlink -f -- "$0")")/.." && pwd)"
exec "$runtime/bin/node" "$runtime/apps/server/dist/bin.mjs" "$@"
`, {mode:0o755});
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(destination, 'LICENSE'));
fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify({private:true, type:'module'}));
console.log(`Packaged ${roots.length} runtime roots, ${seen.size} dependency instances.`);
