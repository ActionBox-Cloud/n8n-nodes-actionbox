// Test-only adapter: real node + real n8n; only ActionBox HTTP and credentials are fixtures.
// Copied into the test image, never into the npm package or pilot image.
const { ActionBox } = require('/opt/actionbox/nodes/ActionBox/ActionBox.node.js');
const { createHash, createHmac } = require('crypto');
function adapter(context) {
  context.getCredentials = async () => ({ apiKey: 'fixture-only', webhookSecret: 'fixture-signing-secret' });
  context.helpers.httpRequestWithAuthentication = async (_, options) => {
    const id = 'fixture-' + context.getExecutionId();
    const data = { id, title: 'Fixture', status: options.method === 'GET' ? 'resolved' : 'open', resolution_option_id: options.method === 'GET' ? 'approve' : null, action_version: 1, fingerprint: 'sha256:' + createHash('sha256').update(id).digest('hex') };
    if (options.method === 'POST' && options.body?.callback_url) {
      const url = new URL(options.body.callback_url);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const raw = JSON.stringify({ id: 'early-fixture', type: 'action.resolved', data: { action_id: id } });
      const signature = 'v1=' + createHmac('sha256', 'fixture-signing-secret').update(timestamp + '.').update(raw).digest('hex');
      const response = await fetch('http://127.0.0.1:5678' + url.pathname + url.search, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-actionbox-timestamp': timestamp, 'x-actionbox-signature': signature } });
      if (response.status !== 409) throw new Error('Expected n8n to reject callback before wait persistence');
      console.log('Fixture: early callback rejected before wait persistence');
    }
    return { statusCode: 200, body: { data } };
  };
}
class ActionBoxFixture extends ActionBox {
  constructor() { super(); this.description = { ...this.description, credentials: [], name: 'actionBoxFixture', displayName: 'ActionBox Fixture' }; }
  async execute() { adapter(this); return ActionBox.prototype.execute.call(this); }
  async webhook() { adapter(this); return ActionBox.prototype.webhook.call(this); }
}
exports.ActionBoxFixture = ActionBoxFixture;
