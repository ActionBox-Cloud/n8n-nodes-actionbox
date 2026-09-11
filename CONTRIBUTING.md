# Contributing

This repository receives maintained source snapshots. File an issue or pull
request here; maintainers incorporate accepted changes into the canonical source
before synchronizing them back, preserving attribution.

Use Node.js 24. Run `npm ci`, `npm run lint`, `npm run typecheck`, and `npm test`.
Run `npm run test:runtime` with Docker and Python 3 for the complete waiting
lifecycle test. Test fixture adapters must never be shipped as runtime nodes.

The node uses n8n's request and waiting APIs. Do not add external runtime
dependencies, environment-variable access, filesystem access, or telemetry to
node code. Tests may use isolated fixtures. Keep credential and callback data out
of ordinary outputs, logs, and examples.

npm publishing is disabled during evaluation. Source synchronization does not
publish packages or imply n8n verification.
