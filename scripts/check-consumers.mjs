#!/usr/bin/env node
/**
 * Run the kit's conformance check against every consuming application present
 * on this machine.
 *
 * The apps deliberately live in separate repositories, and no machine is
 * expected to hold all of them — so a missing checkout is a skip, never a
 * failure. What this catches is the case that actually hurt: a change made
 * here that quietly invalidates an application sitting right next door.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { consumers, syncConsumer } from './kit-sync.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS = path.join(ROOT, '..');
const VERIFY = path.join(ROOT, 'kit', 'js', 'verify.mjs');

let checked = 0;
let failed = 0;
const skipped = [];

for (const [slug, consumer] of Object.entries(consumers())) {
  const appRoot = path.join(PROJECTS, consumer.repo);
  if (!fs.existsSync(appRoot)) {
    skipped.push(consumer.repo);
    continue;
  }
  checked += 1;
  const drift = syncConsumer(slug, { check: true });
  const stale = drift.kit.length > 0 || drift.contract?.fixtureStale;
  try {
    /* capture both streams: the child reports in its own format, and this
       script reports in one line per app */
    execFileSync('node', [VERIFY, '--app-root', appRoot], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`  ok   ${consumer.repo.padEnd(16)} conforms${stale ? ' — but its vendored kit is behind; run kit-sync' : ''}`);
    if (stale) failed += 1;
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${consumer.repo}`);
    const detail = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    for (const line of detail.split('\n').filter((line) => line.includes('FAIL'))) {
      console.log(`       ${line.trim()}`);
    }
  }
}

if (skipped.length) console.log(`  skip ${skipped.join(', ')} — not checked out here`);
if (checked === 0) {
  console.log('\nNo consuming applications on this machine; nothing to check.');
} else if (failed > 0) {
  console.error(`\n${failed} of ${checked} consumer(s) need attention.`);
  process.exit(1);
} else {
  console.log(`\nAll ${checked} consumer(s) present on this machine conform.`);
}
