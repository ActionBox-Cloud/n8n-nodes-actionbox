const { spawnSync } = require('node:child_process');
const { version } = require('../package.json');
const args = ['workflow', 'run', 'publish.yml', '--repo', 'ActionBox-Cloud/n8n-nodes-actionbox', '--ref', `v${version}`];
console.log(`Dispatching publication for the existing public tag v${version}.`);
const result = spawnSync('gh', args, { stdio: 'inherit', shell: false });
if (result.error) console.error('Install and authenticate GitHub CLI to dispatch publication.');
process.exit(result.status ?? 1);
