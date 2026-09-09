/*
 * The two per-user auth caches must stay reconciled.
 *
 * A single authenticated request passes through BOTH: requireAuth resolves the
 * user row (services/auth.service.js), then a guard resolves that user's
 * effective permissions (services/role.service.js). The staleness a person
 * actually experiences after an access change is therefore the MAX of the two,
 * never either one — so the two numbers drifting apart is not a tidiness issue,
 * it silently makes the smaller one a lie. Reconciled 2026-09-08 onto one knob,
 * AUTH_USER_CACHE_TTL_MS.
 *
 * WHY THESE TESTS SPAWN CHILD PROCESSES. Both modules read the env var and
 * compute their TTL at MODULE LOAD. Mutating process.env inside a test cannot
 * change a constant that was already evaluated, so an in-process test would
 * assert against whatever the first import happened to see and pass no matter
 * what the code does. Each case gets its own process with its own env.
 *
 * WHY THE ASSERTIONS ARE ON QUERY COUNTS. A cache produces byte-identical
 * results whether it is on, off, or stale — nothing about a returned value can
 * witness a TTL. The observable difference is how many times the pool was hit.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/*
 * Run `body` in a fresh process with `env` applied and ../db stubbed by a
 * counting fake. `body` is source text; it must console.log a single JSON line.
 */
function probe(env, body) {
  const src = `
    const ROOT = ${JSON.stringify(ROOT)};
    const path = require('path');
    const counts = {};
    const dbPath = require.resolve(path.join(ROOT, 'db.js'));
    require.cache[dbPath] = {
      id: dbPath, filename: dbPath, loaded: true,
      exports: {
        pool: {
          async query(sql) {
            const k = /FROM\\s+tbl_user/i.test(sql) ? 'tbl_user'
                    : /role_menu_action/i.test(sql) ? 'role_actions'
                    : /FROM\\s+tbl_role/i.test(sql) ? 'tbl_role'
                    : 'other';
            counts[k] = (counts[k] || 0) + 1;
            if (k === 'tbl_user')     return [[{ user_id: 7, user_role: 2, user_status: 1, user_type_id: 5 }], []];
            if (k === 'tbl_role')     return [[{ role_id: 2, role_name: 'Admin', role_status: 1, menu_ids: '[]' }], []];
            if (k === 'role_actions') return [[{ action_name: 'a' }], []];
            return [[], []];
          },
        },
        getPoolStats: () => ({}), poolSaturation: () => ({ status: 'ok' }),
        testConnection: async () => true, closePool: async () => {},
      },
    };
    (async () => {
      ${body}
      console.log('__RESULT__' + JSON.stringify(counts));
      process.exit(0);
    })().catch((e) => { console.log('__RESULT__' + JSON.stringify({ error: e.message })); process.exit(0); });
  `;
  const out = execFileSync(process.execPath, ['-e', src], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 60_000,
  });
  const line = out.split('\n').find((l) => l.startsWith('__RESULT__'));
  assert.ok(line, `probe produced no result line. Output was:\n${out}`);
  return JSON.parse(line.slice('__RESULT__'.length));
}

const AUTH_TWICE = `
  const auth = require(path.join(ROOT, 'services/auth.service'));
  await auth.findUserById(7);
  await auth.findUserById(7);
`;
const PERMS_TWICE = `
  const role = require(path.join(ROOT, 'services/role.service'));
  await role.getEffectivePermissions(7);
  await role.getEffectivePermissions(7);
`;

test('control: the probe can observe caching at all', () => {
  // If a cached run and an uncached run looked the same, every assertion below
  // would be vacuous. Establish the two are distinguishable first.
  const cached = probe({ AUTH_USER_CACHE_TTL_MS: '15000' }, AUTH_TWICE);
  const off = probe({ AUTH_USER_CACHE_TTL_MS: '0' }, AUTH_TWICE);
  assert.equal(cached.tbl_user, 1, 'two cached reads must issue one query');
  assert.equal(off.tbl_user, 2, 'with the cache off, two reads must issue two queries');
});

test('the kill switch disables BOTH caches, not just the auth one', () => {
  // The bug this guards: role.service originally used `|| 15_000`, which turns a
  // configured 0 back into 15s. The operator sets one documented knob to 0,
  // believes caching is off, and half of it is still on.
  const auth = probe({ AUTH_USER_CACHE_TTL_MS: '0' }, AUTH_TWICE);
  const perms = probe({ AUTH_USER_CACHE_TTL_MS: '0' }, PERMS_TWICE);

  assert.equal(auth.tbl_user, 2, 'auth user-row cache must be OFF at 0');
  assert.equal(
    perms.role_actions, 2,
    'the permissions cache is still serving from cache at AUTH_USER_CACHE_TTL_MS=0 — '
    + 'the documented kill switch only half-works, which is worse than not having one'
  );
});

test('both caches are ON by default, from the same knob', () => {
  const auth = probe({ AUTH_USER_CACHE_TTL_MS: '15000' }, AUTH_TWICE);
  const perms = probe({ AUTH_USER_CACHE_TTL_MS: '15000' }, PERMS_TWICE);
  assert.equal(auth.tbl_user, 1);
  assert.equal(perms.role_actions, 1, 'the second permissions read must be served from cache');
});

test('both caches read the SAME env var — neither has a private knob', () => {
  // Drift guard. If someone gives one of them its own variable, this goes red
  // rather than the two silently diverging again.
  const fs = require('fs');
  const authSrc = fs.readFileSync(path.join(ROOT, 'services/auth.service.js'), 'utf8');
  const roleSrc = fs.readFileSync(path.join(ROOT, 'services/role.service.js'), 'utf8');
  for (const [name, src] of [['auth.service', authSrc], ['role.service', roleSrc]]) {
    assert.ok(
      /AUTH_USER_CACHE_TTL_MS/.test(src),
      `${name} no longer reads AUTH_USER_CACHE_TTL_MS — the two per-user auth caches have `
      + 'drifted apart, and the effective staleness is the MAX of them'
    );
  }
});

test('invalidateUserCaches busts BOTH caches', () => {
  const both = probe({ AUTH_USER_CACHE_TTL_MS: '15000' }, `
    const auth = require(path.join(ROOT, 'services/auth.service'));
    const role = require(path.join(ROOT, 'services/role.service'));
    await auth.findUserById(7);
    await role.getEffectivePermissions(7);
    auth.invalidateUserCaches(7);
    await auth.findUserById(7);
    await role.getEffectivePermissions(7);
  `);
  assert.equal(both.tbl_user >= 2, true,
    `the user row was not re-read after invalidateUserCaches (tbl_user=${both.tbl_user})`);
  assert.equal(both.role_actions, 2,
    'permissions were NOT re-resolved after invalidateUserCaches — a deleted or demoted user '
    + 'keeps acting on cached permissions for the full TTL');
});

test('positive control: the single-cache function leaves the other stale', () => {
  // This is why invalidateUserCaches exists. Without this control, the test
  // above could pass against an invalidator that only ever busted permissions
  // by coincidence of ordering.
  const one = probe({ AUTH_USER_CACHE_TTL_MS: '15000' }, `
    const auth = require(path.join(ROOT, 'services/auth.service'));
    const role = require(path.join(ROOT, 'services/role.service'));
    await auth.findUserById(7);
    await role.getEffectivePermissions(7);
    auth.invalidateUserCache(7);          // the SINGLE-cache one, deliberately
    await auth.findUserById(7);
    await role.getEffectivePermissions(7);
  `);
  assert.equal(one.role_actions, 1,
    'invalidateUserCache (singular) should leave permissions cached — if it does not, this '
    + 'control cannot distinguish it from the combined one and the test above proves nothing');
});
