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

Maintainers publish from the public repository through `publish.yml`, using a
version tag whose commit passed CI. `npm run release` dispatches that workflow
for the package version; it does not create a tag or change source files.
Source synchronization alone does not publish a package. A package release does
not imply n8n verification.
