/*
 * asyncMiddleware — make an async Express middleware's rejection survivable.
 *
 * ⚠ WHY THIS EXISTS. Express 4 does not attach a `.catch` to the promise an
 * async middleware returns. A rejection therefore reaches no error middleware,
 * sends no response, and becomes an unhandled rejection — which on Node >= 15
 * (this image runs Node 20) defaults to --unhandled-rejections=throw and
 * TERMINATES THE PROCESS.
 *
 * That is not theory. On 2026-09-08 at 11:06 IST the pool threw
 * "Queue limit reached." from `findUserById` inside `requireAuth`
 * (middleware/auth.js:87 — an await sitting outside the try that covers only
 * verifyToken). The container exited 1 and restarted, killing every in-flight
 * request. The identical shape was already diagnosed and reproduced once
 * before, at routes/admin/jobs.js:312 — but the fix was applied to that ONE
 * line, while five middlewares on the every-request path kept the defect.
 *
 * The failure is asymmetric in the worst direction: INSIDE a try, a transient
 * DB fault costs one request a 500. Outside it, the same fault costs every
 * concurrent request plus a cold start. So wrapping is not defensive
 * programming — it is the difference between an error and an outage.
 *
 * Use this on ANY middleware declared `async`. It preserves `fn.name` (route
 * -stack tests locate guards by `entry.name`) and copies own enumerable props
 * (`_openapi`, read by docs/openapi-autogen.js) so wrapping is invisible to
 * everything except the rejection path.
 */
function asyncMiddleware(fn) {
  const wrapped = (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  Object.defineProperty(wrapped, 'name', { value: fn.name, configurable: true });
  return Object.assign(wrapped, fn);
}

module.exports = { asyncMiddleware };
