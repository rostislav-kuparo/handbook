// Runs a command with Rust's cargo on PATH.
//
// rustup adds %USERPROFILE%\.cargo\bin to PATH, but terminals that were open
// before the install (or started from an app launched earlier) do not see it,
// and `tauri dev` then fails with "cargo metadata … program not found".
// Usage: node scripts/with-cargo.mjs <command> [args…]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('usage: node scripts/with-cargo.mjs <command> [args…]');
  process.exit(2);
}
const cargoBin = join(homedir(), '.cargo', 'bin');
if (!existsSync(join(cargoBin, process.platform === 'win32' ? 'cargo.exe' : 'cargo'))) {
  console.error(`[with-cargo] Rust не найден в ${cargoBin}. Установите его: https://rustup.rs`);
}
const sep = process.platform === 'win32' ? ';' : ':';
const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
const env = { ...process.env, [pathKey]: `${cargoBin}${sep}${process.env[pathKey] ?? ''}` };
const res = spawnSync(cmd, args, { env, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(res.status ?? 1);
