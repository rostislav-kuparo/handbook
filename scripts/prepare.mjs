// Prepares generated assets before dev/build:
//  1. copies the libraries that HTML blocks may use into public/vendor
//     (blocks run in sandboxed iframes and load them by URL, offline);
//  2. rebuilds the Rust crates (handwriting engine, photo analysis) to
//     WebAssembly when their sources changed.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force-wasm');

const vendor = {
  'rough.js': 'node_modules/roughjs/bundled/rough.js',
  'chart.umd.min.js': 'node_modules/chart.js/dist/chart.umd.min.js',
};
const vendorDir = join(root, 'public', 'vendor');
mkdirSync(vendorDir, { recursive: true });
for (const [name, src] of Object.entries(vendor)) {
  copyFileSync(join(root, src), join(vendorDir, name));
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

// The handwriting engine and the photo analysis of «На столе (фото)».
for (const name of ['glyph-core', 'desk-core']) {
  const crate = join(root, 'crates', name);
  const wasm = join(crate, 'pkg', `${name.replace('-', '_')}_bg.wasm`);
  const sourcesChanged =
    !existsSync(wasm) ||
    Math.max(newestMtime(join(crate, 'src')), statSync(join(crate, 'Cargo.toml')).mtimeMs) > statSync(wasm).mtimeMs;
  if (!force && !sourcesChanged) continue;
  console.log(`[prepare] building ${name} -> WebAssembly …`);
  const cargoBin = join(homedir(), '.cargo', 'bin');
  const sep = process.platform === 'win32' ? ';' : ':';
  const env = { ...process.env, PATH: `${cargoBin}${sep}${process.env.PATH ?? process.env.Path ?? ''}` };
  const res = spawnSync('wasm-pack', ['build', `crates/${name}`, '--target', 'web', '--release', '--out-dir', 'pkg', '--no-pack'], {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    console.error('[prepare] wasm-pack failed. Install Rust (rustup) and wasm-pack: cargo install wasm-pack');
    process.exit(res.status ?? 1);
  }
}
