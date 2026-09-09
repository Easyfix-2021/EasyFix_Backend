---
name: api-scaffold
description: "Scaffolds a new EasyFix_Backend API route module — group choice, Joi validation, action-permission guard, modernOk/modernError, next(e). Use for 'new API', 'create endpoint', 'add route'."
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

Create a new API route module for **EasyFix_Backend** from $ARGUMENTS
(e.g. "manage tools", "client escalations").

> Every fact below was verified against this repository on 2026-09-08 with the
> command quoted beside it. A scoped skill outranks the general one, so a wrong
> claim here beats a right one elsewhere — run a command before adding a rule.

## 1. Pick the group first — it decides what you inherit

The file goes at `routes/<group>/<module>.js` — **two levels below the repo
root**, so every internal require is `../../` (`grep -rhoE "require\('\.\.[^']*db'\)"
routes/` → 67× `../../db`; the 4 `../db` hits are files directly in `routes/`).
Read the group's `index.js` first: these gates are already applied at the mount
and must NOT be repeated in your module.

| group | mount-time guards |
|---|---|
| `admin` | `requireAuth` + `role(['admin'])` + `maskMobile` + `rejectMaskedMobile` + per-request `req.scope` / `req.allowedStages` |
| `client` | `requireSpocAuth` (`middleware/client-auth.js`) |
| `mobile` | `requireTechAuth`, tech-lifecycle capability, idempotency |
| `shared` | `requireAuth` only — any admin/client/mobile JWT passes |
| `public` | none; truly unauthenticated, mounted from `server.js` — bring your own `rateLimit` |
| `integration`, `webhook` | none at group level; each sub-router brings its own (HTTP Basic / signed token) |

`/api/integration/v1/*` is a frozen external contract: it uses
`legacyOk`/`legacyError` (`status` is the STRING `"200"`), **not** `modernOk`.
See the NO-CLIENT-CHANGE RULE in the root `CLAUDE.md` before touching it.

## 2. The module

```javascript
const router = require('express').Router();
const Joi    = require('joi');

const validate      = require('../../middleware/validate');
const requireAction = require('../../middleware/require-action');
const { pool }      = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

const idParam   = Joi.object({ id: Joi.number().integer().positive().required() });
const listQuery = Joi.object({
  limit:  Joi.number().integer().min(1).max(1000).default(200),
  offset: Joi.number().integer().min(0).default(0),
});
const createBody = Joi.object({
  name: Joi.string().trim().min(2).max(200).required(),
});

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name FROM tbl_thing WHERE status = 1 ORDER BY name LIMIT ?, ?',
      [req.query.offset, req.query.limit],
    );
    modernOk(res, { items: rows });
  } catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT id, name FROM tbl_thing WHERE id = ?', [req.params.id]);
    if (!rows.length) return modernError(res, 404, 'Thing not found');
    modernOk(res, rows[0]);
  } catch (e) { next(e); }
});

router.post('/', requireAction('isThingAdd'), validate(createBody), async (req, res, next) => {
  try {
    logger.info('Create thing · name=' + req.body.name);
    const [r] = await pool.query('INSERT INTO tbl_thing (name, status) VALUES (?, 1)', [req.body.name]);
    res.status(201);
    modernOk(res, { id: r.insertId }, 'Thing added');
  } catch (e) { next(e); }
});

module.exports = router;
```

Why each line is that line:

- **`const { pool } = require('../../db')`** — `db.js` is at the repo ROOT and
  exports a *named* `pool`; all 67 `../../db` requires in `routes/` reach
  `.pool`, none treats the module as the pool. `require('../db')` from
  `routes/<group>/` is `MODULE_NOT_FOUND`, and nothing in CI catches that (§5).
- **`validate(schema, 'query' | 'params' | 'body')`** — `middleware/validate.js`,
  source defaults to `'body'`; 100 of 143 route files use it. It also tags the
  middleware `_openapi`, which is how a new route reaches `/api/docs` with no
  hand-written YAML. Schemas that outgrow the file go in `validators/`.
- **`modernOk` / `modernError`** from `utils/response.js` —
  `grep -rn "res.json({ success" routes/` → **0**. Never hand-roll the envelope;
  `modernError` also sets `res.locals.logHint` so the HTTP log says what failed.
- **`catch (e) { next(e); }`** → `middleware/error-handler.js`, which logs,
  redacts the URL and picks the modern/legacy shape from the path.
  `next(e` → 826 in `routes/`; `res.status(500)` → **0**. For a deliberate 4xx:
  `catch (e) { if (e.status) return modernError(res, e.status, e.message); next(e); }`.
- **Every `await` inside the handler's own `try`.** Express 4 attaches no
  `.catch` to a handler's promise, so an await outside the try reaches no error
  middleware and hangs the request — on 2026-09-08 it exited the production
  container. `node scripts/scan-unguarded-await.js --gate` enforces this in CI.
  An `async` middleware mounted with `.use()` must be wrapped with
  `asyncMiddleware` (`utils/async-middleware.js`).
- **`logger`** from `logger.js` — a custom human-readable logger, not Pino.
  `console.*` appears **0** times in `routes/` (root `CLAUDE.md` rule 6), and
  ESLint does not enforce it (`no-console` is deliberately off), so it is on you.
- **`LIMIT ?, ?` behind a Joi `.max()`** — pagination is server-side by rule, and
  the `.max()` is the only thing stopping one caller asking for everything.

## 3. Mount it

One line in `routes/<group>/index.js`:

```javascript
router.use('/things', require('./things'));
```

Put a comment above it saying what the module is and what gates it — those
mount-site comments *are* this repo's module documentation (104 comment lines
in `routes/admin/index.js`).

## 4. Seed the permission if you used `requireAction`

`requireAction('isThingAdd')` resolves against `menu_action` × `role_menu_action`;
an unseeded key returns `403 Missing permission: isThingAdd` for **every** user.
Add a pending migration `migrations/YYYY-MM-DD-<description>.sql` modelled on
`migrations/executed/2026-09-07-seed-job-customer-pin-resend-rbac.sql` — one
statement per line, `INSERT … WHERE NOT EXISTS`, then a verifying `SELECT`.
`migrations/` = pending, `migrations/executed/` = applied and frozen; never move
a file back. A new TABLE goes in the same folder — but `easyfix_core` is shared
with five legacy services, so **never alter an existing table** beyond adding an
index; a new EasyFix-owned table nothing legacy references is the one exception.

Guards that already exist, if `requireAction` is the wrong grain:
`roleByName(['Finance'])` (`middleware/role.js`), `requirePropertyAllowlist`
(`middleware/require-property-allowlist.js`), `requireStageForTransition`,
`requireQuickSight`.

## 5. Verify — and know what these do NOT check

```bash
npm run lint                                   # eslint . --max-warnings=0
npm run build                                  # node --check sweep — SYNTAX ONLY
node scripts/scan-unguarded-await.js --gate    # CI await gate
node -e "require('./routes/<group>/<module>')" # the one that catches a bad path
```

ESLint here is `no-undef` plus a few runtime-failure rules, and `npm run build`
is `node --check` per file — **neither resolves a `require()`**. A bad require
path passes all three gates and fails at server boot; the fourth line is not
optional.
