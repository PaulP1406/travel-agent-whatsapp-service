import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signPayload, verifySignature, bearerAuthMiddleware } from '../src/auth.js';

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('signPayload is deterministic for the same timestamp and body', () => {
  const a = signPayload('secret', 1000, '{"a":1}');
  const b = signPayload('secret', 1000, '{"a":1}');
  assert.equal(a, b);
});

test('verifySignature fails with the wrong secret', () => {
  const sig = signPayload('secret', 1000, 'body');
  assert.equal(verifySignature({ secret: 'other', timestamp: 1000, rawBody: 'body', signature: sig }), false);
});

test('verifySignature succeeds with the correct secret', () => {
  const sig = signPayload('secret', 1000, 'body');
  assert.equal(verifySignature({ secret: 'secret', timestamp: 1000, rawBody: 'body', signature: sig }), true);
});

test('verifySignature passes through when no secret is configured', () => {
  assert.equal(verifySignature({ secret: '', timestamp: 1000, rawBody: 'body', signature: '' }), true);
});

test('bearer middleware allows the correct token', () => {
  const mw = bearerAuthMiddleware('tok123');
  const req = { headers: { authorization: 'Bearer tok123' } };
  let nextCalled = false;
  mw(req, mockRes(), () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test('bearer middleware rejects the wrong token', () => {
  const mw = bearerAuthMiddleware('tok123');
  const req = { headers: { authorization: 'Bearer wrong' } };
  const res = mockRes();
  mw(req, res, () => {
    throw new Error('next should not be called');
  });
  assert.equal(res.statusCode, 401);
});

test('bearer middleware rejects a missing token', () => {
  const mw = bearerAuthMiddleware('tok123');
  const req = { headers: {} };
  const res = mockRes();
  mw(req, res, () => {
    throw new Error('next should not be called');
  });
  assert.equal(res.statusCode, 401);
});

test('an empty SERVICE_TOKEN allows all requests through', () => {
  const mw = bearerAuthMiddleware('');
  const req = { headers: {} };
  let nextCalled = false;
  mw(req, mockRes(), () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});
