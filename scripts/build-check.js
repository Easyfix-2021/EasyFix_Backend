#!/usr/bin/env node
/**
 * "Build" for a pure Node.js backend (no transpiler).
 * Walks every *.js file outside node_modules/uploads/logs and runs syntax check.
 * Exits non-zero if any file has a syntax error.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SKIP = new Set(['node_modules', '.git', 'uploads', 'logs', 'coverage', 'dist', 'build']);
const root = path.resolve(__dirname, '..');

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

const files = walk(root);
let failed = 0;
for (const f of files) {
  try {
    execFileSync('node', ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    console.error('✗', path.relative(root, f));
    console.error(e.stderr?.toString() || e.message);
    failed++;
  }
}
if (failed > 0) {
  console.error(`\n${failed} file(s) failed syntax check`);
  process.exit(1);
}
console.log(`✓ build OK — ${files.length} files syntax-checked`);
