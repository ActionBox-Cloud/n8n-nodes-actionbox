const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const testHome = mkdtempSync(join(tmpdir(), 'actionbox-engine-'));
process.env.N8N_USER_FOLDER = testHome;
process.env.N8N_ENCRYPTION_KEY = 'fixture-encryption-key';
process.on('exit', () => rmSync(testHome, { recursive: true, force: true }));
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Workflow, createRunExecutionData } = require('n8n-workflow');
const { WorkflowExecute } = require('n8n-core');
const { ExecuteContext, WebhookContext } = require('n8n-core/dist/execution-engine/node-execution-context');
const { ActionBox } = require('../dist/nodes/ActionBox/ActionBox.node');
const { createHmac } = require('node:crypto');
const fixture = { id: 'fixture-action', status: 'open', action_version: 1, fingerprint: 'sha256:' + 'a'.repeat(64) };
const nodeType = new ActionBox();
const node = { id: 'approve-node', name: 'ActionBox', type: 'n8n-nodes-actionbox.actionBox', typeVersion: 1, position: [0,0], parameters: Object.fromEntries(nodeType.description.properties.map(p => [p.name,p.default])) };
node.parameters.title = 'Approve fixture';
const types = { getByNameAndVersion: () => nodeType, getKnownTypes: () => ({}) };
function workflow(n = node) { return new Workflow({ id: 'fixture-workflow', nodes: [n], connections: {}, active: false, nodeTypes: types, settings: { executionOrder: 'v1' } }); }
const extra = { executionId: '12', currentNodeExecutionIndex: 0, restApiUrl: 'https://n8n.example.com/rest', webhookWaitingBaseUrl: 'https://n8n.example.com/webhook-waiting', formWaitingBaseUrl: 'https://n8n.example.com/form-waiting', instanceBaseUrl: 'https://n8n.example.com', timezone: 'UTC', hooks: { runHook: async () => {} }, logNodeOutput: () => {}, credentialsHelper: { getDecrypted: async () => ({ apiKey: 'fixture', webhookSecret: 'fixture-secret' }) } };
async function suspend() {
  const wf = workflow();
  const input = [{ json: { approved: true, businessId: 'fixture-order' } }];
  const entry = { node: structuredClone(node), data: { main: [input] }, source: null };
  const run = createRunExecutionData({ executionData: { nodeExecutionStack: [entry] }, resumeToken: 'fixture-resume-token' });
  const ctx = new ExecuteContext(wf, entry.node, extra, 'manual', run, 0, input, entry.data, entry, []);
  // The external service is stubbed; n8n expression, state and waiting APIs are real.
  ctx.getCredentials = async () => ({ apiKey: 'fixture', webhookSecret: 'fixture-secret' });
  ctx.helpers.httpRequestWithAuthentication = async () => ({ statusCode: 200, body: { data: fixture } });
  const output = await nodeType.execute.call(ctx);
  run.resultData.lastNodeExecuted = node.name;
  run.resultData.runData[node.name] = [{ startTime: Date.now(), executionTime: 0, source: [], executionStatus: 'waiting', data: { main: output } }];
  return run;
}
test('real n8n execution state survives serialization and timeout bypasses node with non-approval', async () => {
  const saved = await suspend();
  const reloaded = JSON.parse(JSON.stringify(saved)); // storage/process boundary
  assert.equal(reloaded.executionData.nodeExecutionStack[0].data.main[0][0].json.actionbox.approved, false);
  assert.ok(reloaded.waitTill);
  const engine = new WorkflowExecute(extra, 'manual', reloaded);
  engine.handleWaitingState(workflow());
  const entry = reloaded.executionData.nodeExecutionStack[0];
  assert.equal(entry.node.disabled, true);
  const resumed = await engine.runNode(workflow(entry.node), entry, reloaded, 0, extra, 'manual');
  assert.equal(resumed.data[0][0].json.actionbox.decision_status, 'timed_out');
  assert.equal(resumed.data[0][0].json.actionbox.approved, false);
});
test('real n8n webhook context reads persisted input, verifies callback and returns matching decision', async () => {
  const reloaded = JSON.parse(JSON.stringify(await suspend()));
  const timestamp = String(Math.floor(Date.now()/1000));
  const rawBody = Buffer.from(JSON.stringify({ id: 'fixture-event', type: 'action.resolved', data: { action_id: fixture.id } }));
  const headers = { 'x-actionbox-timestamp': timestamp, 'x-actionbox-signature': 'v1=' + createHmac('sha256', 'fixture-secret').update(timestamp+'.').update(rawBody).digest('hex') };
  const wf = workflow();
  const ctx = new WebhookContext(wf, node, { ...extra, httpRequest: { rawBody, headers }, httpResponse: { status() { return this; }, json() { return this; } } }, 'webhook', { webhookDescription: nodeType.description.webhooks[0] }, [], reloaded);
  ctx.getCredentials = async () => ({ apiKey: 'fixture', webhookSecret: 'fixture-secret' });
  ctx.helpers.httpRequestWithAuthentication = async () => ({ statusCode: 200, body: { data: { ...fixture, status: 'resolved', resolution_option_id: 'approve' } } });
  const output = await nodeType.webhook.call(ctx);
  assert.equal(output.workflowData[0][0].json.actionbox.approved, true);
  assert.equal(output.workflowData[0][0].json.input.businessId, 'fixture-order');
});
