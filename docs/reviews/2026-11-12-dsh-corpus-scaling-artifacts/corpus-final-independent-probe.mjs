import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createSessionHandler as builtin } from '../dsh-corpus-scaling/integrations/dsh-session-adapter/index.js';
import { createSessionHandler as standalone } from '../dsh-plugin-corpus-scaling/src/index.js';

const token = 'synthetic-independent-review-token-123456789';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const req = () => Object.assign(Readable.from([]), { method: 'GET', url: '/oai/session-adapter/v1/sessions', headers: { authorization: `Bearer ${token}` } });
const res = () => Object.assign(new EventEmitter(), { writeHead(status) { this.statusCode = status; this.headersSent = true; }, end(body) { this.body = JSON.parse(body); this.writableEnded = true; } });
const records = Array.from({ length: 5 }, (_, index) => ({ header: { id: `synthetic-${index}`, createdAt: 1000 } }));
const results = [];
const unhandled = [];
process.on('unhandledRejection', (error) => unhandled.push(String(error)));

for (const [name, create] of [['内置桥', builtin], ['独立桥', standalone]]) {
  let active = 0, maximum = 0, acquired = 0, disposed = 0, started = 0, pending = 0, maxPending = 0;
  let gateResolve;
  let gate = new Promise((resolve) => { gateResolve = resolve; });
  const query = {
    async listSessions(signal) { signal.throwIfAborted(); return records; },
    async readSurface() { throw new Error('不应进入旧查询'); },
    async observeSession(id) {
      started++; pending++; maxPending = Math.max(maxPending, pending);
      await gate;
      pending--;
      acquired++; active++; maximum = Math.max(maximum, active);
      return { header: { id, createdAt: 1000 }, events: [], inheritedEventCount: 0,
        [Symbol.dispose]() { disposed++; active--; } };
    },
  };
  const ctx = { get: (key) => ({ sessionQuery: query, sessions: { prepare() { return { surface: { nodes: [] } }; } } })[key] };
  const handler = create(ctx, {}, token);
  const firstRequest = req(), firstResponse = res();
  const work = handler(firstRequest, firstResponse);
  await tick();
  assert.equal(started, 2);
  firstResponse.destroyed = true;
  firstResponse.emit('close');
  await work;
  assert.equal(firstResponse.body, undefined);
  gateResolve();
  await tick(); await tick();
  assert.equal(acquired, 2); assert.equal(disposed, 2); assert.equal(active, 0); assert.equal(started, 2);
  const recovered = res();
  await handler(req(), recovered);
  assert.equal(recovered.body.sessions.length, 5);
  assert.equal(disposed, acquired); assert.equal(active, 0); assert.equal(pending, 0); assert.ok(maxPending <= 2);
  results.push({ name: `${name}：断开后迟到租约全部释放且后续请求恢复`, passed: true, acquired, disposed, maximum, maxPending });

  gate = new Promise((resolve) => { gateResolve = resolve; });
  const responses = Array.from({ length: 18 }, res);
  const requests = Array.from({ length: 18 }, req);
  const works = requests.map((request, index) => handler(request, responses[index]));
  await tick();
  responses.forEach((response, index) => { if (index % 3 !== 0) { response.destroyed = true; response.emit('close'); } });
  gateResolve();
  await Promise.all(works);
  assert.equal(responses.filter((response) => response.body?.sessions.length === 5).length, 6);
  assert.equal(disposed, acquired); assert.equal(active, 0); assert.equal(pending, 0); assert.ok(maxPending <= 2);
  const finalResponse = res();
  await handler(req(), finalResponse);
  assert.equal(finalResponse.body.sessions.length, 5);
  results.push({ name: `${name}：18请求交错取消共享读取上限且没有遗留名额`, passed: true, acquired, disposed, maximum, maxPending });

  gate = new Promise((resolve) => { gateResolve = resolve; });
  const timeoutHandler = create(ctx, { promptTimeoutMs: 8 }, token);
  const timeoutResponse = res();
  await timeoutHandler(req(), timeoutResponse);
  assert.equal(timeoutResponse.statusCode, 504); assert.equal(timeoutResponse.body.code, 'AGENT_QUERY_TIMEOUT');
  const beforeLate = disposed;
  gateResolve(); await tick(); await tick();
  assert.equal(disposed - beforeLate, 2); assert.equal(disposed, acquired); assert.equal(active, 0);
  results.push({ name: `${name}：超时后迟到租约全部释放`, passed: true, acquired, disposed });
}
await tick();
assert.deepEqual(unhandled, []);
console.log(JSON.stringify({ syntheticOnly: true, checks: results, unhandled, allPassed: true }, null, 2));
