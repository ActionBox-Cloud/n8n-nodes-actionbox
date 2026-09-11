const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { ActionBox } = require('../dist/nodes/ActionBox/ActionBox.node');
const { ActionBoxApi } = require('../dist/credentials/ActionBoxApi.credentials');
const { decision, verifyEvent, resumeUrl, publicAction, snapshotFromResult } = require('../dist/nodes/ActionBox/protocol');
const { request, retryDelay } = require('../dist/nodes/ActionBox/api');
const fingerprint = 'sha256:' + 'a'.repeat(64);
const secret = 'fixture-signing-secret';
const action = (extra = {}) => ({ id: 'act-fixture', status: 'open', title: 'Review', action_version: 1, fingerprint, callback_url: 'https://example.com/secret', source: { token: 'do-not-return' }, ...extra });
function execution(parameters = {}, handler = async () => ({ data: action() })) {
  const params = { operation: 'requestApproval', title: 'Review', description: '', priority: 'normal', timeoutMinutes: 1440, reviewerEmails: '', approveLabel: 'Approve', rejectLabel: 'Reject', ...parameters };
  const items = [{ json: { businessId: 'order-1', approved: true } }];
  const context = {}; const calls = [];
  const ctx = { items, context, calls, getInputData: () => items, getNodeParameter: (name) => params[name], getNode: () => ({ id: 'approval-node', name: 'ActionBox', type: 'n8n-nodes-actionbox.actionBox', typeVersion: 1 }), getCredentials: async () => ({ apiKey: 'fixture-key', webhookSecret: secret }), getWorkflow: () => ({ id: 'workflow-1' }), getExecutionId: () => 'exec-1', getContext: () => context, evaluateExpression: (value) => value.includes('runIndex') ? 0 : 'https://automation.example.com/webhook-waiting/exec-1?signature=fixture-resume-token', putExecutionToWait: async (date) => { ctx.waitTill = date; }, continueOnFail: () => false, helpers: { httpRequestWithAuthentication: async function (type, options) { calls.push(structuredClone(options)); return { statusCode: 200, headers: {}, body: await handler(options) }; } } };
  return ctx;
}
function callback(saved, eventData = {}, handler = async () => ({ data: action({ status: 'resolved', resolution_option_id: 'approve' }) }), options = {}) {
  const event = { id: 'event-fixture', type: 'action.resolved', data: { action_id: 'act-fixture' }, ...eventData };
  const rawBody = Buffer.from(JSON.stringify(event)); const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = 'v1=' + createHmac('sha256', secret).update(timestamp + '.').update(rawBody).digest('hex');
  const ctx = execution({}, handler);
  ctx.getRequestObject = () => ({ rawBody });
  ctx.getHeaderData = () => ({ 'x-actionbox-timestamp': timestamp, 'x-actionbox-signature': signature, ...options.headers });
  ctx.evaluateExpression = () => saved;
  ctx.getResponseObject = () => ({ status(code) { ctx.responseStatus = code; return this; }, json(body) { ctx.responseBody = body; return this; } });
  return ctx;
}
async function waiting() { const ctx = execution(); await new ActionBox().execute.call(ctx); return ctx; }

test('creates one request with stable options, restricted reviewers and safe persisted input', async () => {
  const ctx = execution({ reviewerEmails: 'one@example.com, one@example.com' });
  const output = await new ActionBox().execute.call(ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].url, 'https://api.actionbox.cloud/v1/actions');
  assert.deepEqual(ctx.calls[0].body.options.map(o => o.id), ['approve', 'reject']);
  assert.deepEqual(ctx.calls[0].body.reviewer_emails, ['one@example.com']);
  assert.equal(ctx.calls[0].body.visibility, 'restricted');
  assert.deepEqual(ctx.calls[0].body.on_expire, { type: 'return_expired' });
  assert.equal(new URL(ctx.calls[0].body.callback_url).searchParams.get('signature'), 'fixture-resume-token');
  assert.equal(output[0][0].json.actionbox.approved, false);
  assert.equal(ctx.items[0].json.actionbox.decision_status, 'timed_out');
  assert.equal(ctx.items[0].json.input.approved, true); // original data is namespaced
  assert.ok(ctx.waitTill instanceof Date);
  assert.ok(!JSON.stringify(output).includes('fixture-resume-token'));
  assert.ok(!JSON.stringify(output).includes('fixture-signing-secret'));
});
test('rejects batches and invalid timeout before any writes', async () => {
  const batch = execution(); batch.items.push({ json: {} });
  await assert.rejects(new ActionBox().execute.call(batch), /exactly one/); assert.equal(batch.calls.length, 0);
  for (const timeoutMinutes of [0, -1, NaN, Infinity, 43201]) {
    const ctx = execution({ timeoutMinutes }); await assert.rejects(new ActionBox().execute.call(ctx), /Timeout/); assert.equal(ctx.calls.length, 0);
  }
});
test('a failed create retains exact request through Retry On Fail', async () => {
  const ctx = execution(); let fail = true;
  ctx.helpers.httpRequestWithAuthentication = async (_, options) => { ctx.calls.push(structuredClone(options)); return { statusCode: fail ? 429 : 200, headers: { 'retry-after': '10' }, body: { data: action() } }; };
  await assert.rejects(new ActionBox().execute.call(ctx)); fail = false;
  await new ActionBox().execute.call(ctx);
  assert.deepEqual(ctx.calls[0], ctx.calls[1]);
});
test('callback checks current API decision, not claimed callback approval', async () => {
  const saved = (await waiting()).items[0].json;
  for (const [status, choice, expected] of [['resolved','approve','approved'], ['resolved','reject','rejected'], ['expired',null,'expired'], ['cancelled',null,'cancelled'], ['resolved','unexpected','invalid_response']]) {
    const ctx = callback(saved, {}, async () => ({ data: action({ status, resolution_option_id: choice }) }));
    const response = await new ActionBox().webhook.call(ctx);
    assert.equal(response.workflowData[0][0].json.actionbox.decision_status, expected);
    assert.equal(response.workflowData[0][0].json.actionbox.approved, expected === 'approved');
    assert.equal(ctx.calls[0].url, 'https://api.actionbox.cloud/v1/source/actions/act-fixture');
    assert.ok(!JSON.stringify(response).includes('https://example.com/secret'));
  }
});
test('changed snapshot, malformed response and elapsed deadline cannot approve', async () => {
  const saved = (await waiting()).items[0].json;
  const changed = callback(saved, {}, async () => ({ data: action({ status: 'resolved', resolution_option_id: 'approve', action_version: 2 }) }));
  assert.equal((await new ActionBox().webhook.call(changed)).workflowData[0][0].json.actionbox.decision_status, 'snapshot_changed');
  const expired = structuredClone(saved); expired.actionbox.deadline = Date.now() - 1;
  const late = callback(expired);
  assert.equal((await new ActionBox().webhook.call(late)).workflowData[0][0].json.actionbox.decision_status, 'timed_out');
  const malformed = callback(saved, {}, async () => ({ data: { status: 'resolved' } }));
  assert.equal((await new ActionBox().webhook.call(malformed)).workflowData, undefined); assert.equal(malformed.responseStatus, 503);
});
test('nonterminal events and an open authoritative action keep waiting', async () => {
  const saved = (await waiting()).items[0].json;
  for (const type of ['action.context_requested', 'action.approval_recorded', 'action.updated']) {
    const ctx = callback(saved, { type }); const result = await new ActionBox().webhook.call(ctx);
    assert.equal(result.workflowData, undefined); assert.equal(ctx.responseStatus, 200); assert.equal(ctx.calls.length, 0);
  }
  const ctx = callback(saved, {}, async () => ({ data: action() }));
  assert.equal((await new ActionBox().webhook.call(ctx)).workflowData, undefined);
});
test('forged, stale, oversized and unrelated callbacks never resume', async () => {
  const saved = (await waiting()).items[0].json;
  const cases = [ callback(saved, {}, undefined, { headers: { 'x-actionbox-signature': 'v1=' + '0'.repeat(64) } }), callback(saved, {}, undefined, { headers: { 'x-actionbox-timestamp': '1' } }), callback(saved, { data: { action_id: 'other' } }) ];
  const large = callback(saved); large.getRequestObject = () => ({ rawBody: Buffer.alloc(262145) }); cases.push(large);
  const noState = callback({}); cases.push(noState);
  for (const ctx of cases) { assert.equal((await new ActionBox().webhook.call(ctx)).workflowData, undefined); assert.ok(ctx.responseStatus >= 400); assert.equal(ctx.calls.length, 0); }
});
test('GET strips callback URL and Source information; errors do not expose request secrets', async () => {
  const ctx = execution({ operation: 'get', actionId: 'act-fixture' });
  const out = await new ActionBox().execute.call(ctx);
  assert.equal(out[0][0].json.actionbox.id, 'act-fixture'); assert.equal(out[0][0].json.actionbox.callback_url, undefined); assert.equal(out[0][0].json.actionbox.source, undefined);
  ctx.helpers.httpRequestWithAuthentication = async () => { throw new Error('Authorization: fixture-key callback_url=fixture-resume-token'); };
  await assert.rejects(request(ctx, 'GET', '/v1/source/actions/fixture'), error => !JSON.stringify(error).includes('fixture-key') && !error.message.includes('fixture-resume-token'));
});
test('outcomes preserve exact approved version and fingerprint', async () => {
  const ctx = execution({ operation: 'reportOutcome', actionId: 'act-fixture', actionVersion: 3, fingerprint, outcomeStatus: 'failed' }, async () => ({ data: { status: 'failed' } }));
  await new ActionBox().execute.call(ctx);
  assert.deepEqual(ctx.calls[0].body, { status: 'failed', action_version: 3, fingerprint });
});
test('cancel, continue-on-error and credential configuration', async () => {
  const ctx = execution({ operation: 'cancel', actionId: 'act-fixture', reason: 'No longer needed' });
  await new ActionBox().execute.call(ctx); assert.deepEqual(ctx.calls[0].body, { reason: 'No longer needed' });
  ctx.getNodeParameter = () => ''; ctx.continueOnFail = () => true;
  assert.equal((await new ActionBox().execute.call(ctx))[0][0].json.actionbox.approved, false);
  const credential = new ActionBoxApi();
  for (const name of ['apiKey', 'webhookSecret']) assert.equal(credential.properties.find(p => p.name === name).typeOptions.password, true);
  assert.ok(credential.test.request.url.includes('/v1/source/actions/'));
});
test('retry policy respects rate limit delays and does not retry auth/conflict', async () => {
  for (const status of [401,403,404,409,422]) {
    const ctx = execution(); let count = 0; ctx.helpers.httpRequestWithAuthentication = async () => { count++; return { statusCode: status }; };
    await assert.rejects(request(ctx, 'POST', '/v1/actions', {}, 'stable')); assert.equal(count, 1);
  }
  assert.equal(retryDelay({ 'retry-after': '120' }, 0), 120000);
  assert.equal(retryDelay({ 'retry-after': new Date(10000).toUTCString() }, 0, 1000), 9000);
  const ctx = execution(); let count = 0;
  ctx.helpers.httpRequestWithAuthentication = async () => { if (++count === 1) throw new Error('lost reply'); return { statusCode: 200, body: { data: action() } }; };
  assert.ok(await request(ctx, 'POST', '/v1/actions', {}, 'stable')); assert.equal(count, 2);
});
test('resume URL preserves signature and never accepts credential-bearing or insecure URLs', () => {
  assert.equal(resumeUrl('https://n8n.example.com/wait/1?signature=a', 'node'), 'https://n8n.example.com/wait/1/node?signature=a');
  assert.throws(() => resumeUrl('http://n8n.example.com/wait/1', 'node'));
  assert.throws(() => resumeUrl('https://user:pass@n8n.example.com/wait/1', 'node'));
});
module.exports = { execution, callback, waiting, action, fingerprint, secret };
