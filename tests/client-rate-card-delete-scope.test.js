'use strict';
/*
 * A per-client route may never delete from a SHARED CATALOG.
 *
 * WHAT HAPPENED. DELETE /admin/clients/rate-cards/:id ran
 * `DELETE FROM tbl_client_rate_card WHERE crc_id = ?` using the id the Rate
 * Cards grid held. That table has no client_id — it is a 6,097-row catalog, and
 * five of its rows are referenced by more than one client (the worst by 151).
 * So "Remove rate card" on client A deleted a template clients B..Z were using
 * and blanked the name on all of them, because listForClient LEFT JOINs it.
 *
 * It also did not do what it said: the client's own tbl_client_service row
 * survived, so the row came back on the next refetch under a success toast.
 *
 * Two properties keep that from returning, and the second is the one that
 * generalises — this router has 7 delete routes and only the shape of the
 * guard tells you whether a row can be reached across clients.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ROUTES = fs.readFileSync(path.join(ROOT, 'routes/admin/clients.js'), 'utf8');
const SVC_DIR = path.join(ROOT, 'services');

/** Strip block and line comments so prose about the bug is not mistaken for it. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('NOTHING may delete from the shared rate-card catalog', () => {
  const offenders = [];
  for (const f of fs.readdirSync(SVC_DIR).filter((n) => n.endsWith('.js'))) {
    const body = code(fs.readFileSync(path.join(SVC_DIR, f), 'utf8'));
    if (/DELETE\s+FROM\s+`?tbl_client_rate_card`?/i.test(body)) offenders.push(`services/${f}`);
  }
  if (/DELETE\s+FROM\s+`?tbl_client_rate_card`?/i.test(code(ROUTES))) offenders.push('routes/admin/clients.js');
  assert.deepEqual(offenders, [],
    'tbl_client_rate_card is a catalog shared across clients — deleting a row on '
    + "one client's behalf silently blanks that rate card for every other client "
    + 'pointing at it. Remove the CLIENT\'s tbl_client_service row instead.');
});

test('the rate-card delete resolves the owning client and soft-deletes that row', () => {
  const m = /router\.delete\(\s*'\/rate-cards\/:[^']*'[\s\S]*?\n\);/.exec(ROUTES);
  assert.ok(m, 'the rate-card delete route must exist');
  const body = code(m[0]);
  assert.match(body, /guardRowByClientId\(/,
    'without it, any operator holding isClientEdit reaches any row by guessing an integer');
  assert.match(body, /getServiceClientId\(/, 'the owning client must be resolved from the row');
  assert.match(body, /clientServicesSvc\.softDelete\(/,
    "removing a client's rate card is a soft-delete of ITS OWN tbl_client_service row");
  assert.doesNotMatch(body, /rateCardsSvc\.\w*[Dd]elete/, 'never through the catalog service');
});

test('EVERY delete route on this router guards ownership — derived, not listed', () => {
  /*
   * The general property. A delete that resolves a row by a bare id and never
   * establishes which client owns it is reachable across the whole book; the
   * only reason the rate-card one was found is that someone read it. This
   * enumerates them instead.
   */
  const lines = ROUTES.split('\n');
  const starts = [];
  lines.forEach((l, i) => {
    const m = /^router\.(get|post|put|patch|delete)\(\s*$|^router\.(get|post|put|patch|delete)\(\s*'([^']*)'/.exec(l);
    if (m) starts.push({ i, method: (m[1] || m[2]), path: m[3] || null });
  });
  // A route declared as `router.delete(\n  '/path',` carries its path on the next line.
  starts.forEach((s) => { if (s.path == null) { const nx = /'([^']*)'/.exec(lines[s.i + 1] || ''); s.path = nx ? nx[1] : '?'; } });

  const bare = [];
  starts.forEach((s, idx) => {
    if (s.method !== 'delete') return;
    const end = idx + 1 < starts.length ? starts[idx + 1].i : lines.length;
    const body = code(lines.slice(s.i, end).join('\n'));
    // A path that carries :clientId is guarded by loadAndGuardClient upstream.
    if (/:clientId/.test(s.path)) return;
    if (/guardRowByClientId\(|loadAndGuardClient\(/.test(body)) return;
    bare.push(`DELETE ${s.path}`);
  });

  assert.deepEqual(bare, [],
    'a delete that takes a bare row id without resolving its owning client lets '
    + "any operator with isClientEdit remove another client's row by guessing an integer");
});

test('the guard is not vacuous — it can see this router’s delete routes', () => {
  const n = (ROUTES.match(/router\.delete\(/g) || []).length;
  assert.ok(n >= 5, `only ${n} delete routes detected — the matcher has stopped seeing them`);
});
