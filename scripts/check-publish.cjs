const { version } = require('../package.json');
const repository = 'ActionBox-Cloud/n8n-nodes-actionbox';
const ref = `refs/tags/v${version}`;
if (
  process.env.GITHUB_ACTIONS !== 'true' ||
  process.env.GITHUB_REPOSITORY !== repository ||
  process.env.GITHUB_REF !== ref ||
  process.env.GITHUB_WORKFLOW_REF !== `${repository}/.github/workflows/publish.yml@${ref}`
) {
  console.error('Publish through publish.yml on the matching version tag in the public ActionBox connector repository.');
  process.exit(1);
}
