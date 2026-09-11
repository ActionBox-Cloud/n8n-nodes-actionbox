const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { version } = require('../package.json');
const script = path.join(__dirname, '../scripts/check-publish.cjs');
const repository = 'ActionBox-Cloud/n8n-nodes-actionbox';
const ref = `refs/tags/v${version}`;
const valid = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repository, GITHUB_REF: ref, GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/publish.yml@${ref}` };
test('publication guard rejects local, private repository, branch and wrong-workflow invocations', () => {
  for (const env of [{}, { ...valid, GITHUB_REPOSITORY: 'private/source' }, { ...valid, GITHUB_REF: 'refs/heads/main' }, { ...valid, GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/ci.yml@${ref}` }]) {
    assert.equal(spawnSync(process.execPath, [script], { env, encoding: 'utf8' }).status, 1);
  }
});
test('publication guard accepts the matching public workflow and version tag', () => {
  assert.equal(spawnSync(process.execPath, [script], { env: valid, encoding: 'utf8' }).status, 0);
});
