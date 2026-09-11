# ActionBox for n8n

Request a human decision in [ActionBox](https://actionbox.cloud), pause an n8n
workflow, and continue after a verified response.

Install [n8n-nodes-actionbox](https://www.npmjs.com/package/n8n-nodes-actionbox)
on an n8n instance you administer. The tested compatibility target is n8n
**2.38.7**. This node has not been verified for n8n Cloud.

## Installation

1. Sign in to n8n as an owner or admin.
2. Open **Settings → Community Nodes → Install**.
3. Enter `n8n-nodes-actionbox` (or append `@0.1.0` to install the first release).
4. Read n8n's community-node notice, then select **Install**.
5. Add an **ActionBox** node and configure the credentials below.

For a complete walkthrough, see the [ActionBox n8n guide](https://actionbox.cloud/docs/n8n).
For source installation, follow [LOCAL_DOCKER.md](LOCAL_DOCKER.md).

The connector is MIT licensed. ActionBox is proprietary hosted software; this
repository contains only the integration client. All service requests go to
`https://api.actionbox.cloud`.

## Operations

- **Request Approval and Wait:** creates an approve/reject Action and persists the
  workflow wait in n8n. One input item per invocation; use separate executions for
  concurrent requests.
- **Get Action:** reads an Action belonging to the credential's Source.
- **Cancel Action:** cancels an outstanding Action, with an optional reason.
- **Report Outcome:** records execution `success` or `failed` using the approved
  Action version and fingerprint.

## Credentials

Create a live Source in ActionBox. Enter its Source key and the same Source's
webhook signing secret in **ActionBox API** credentials in n8n. The signing secret
is required for waiting; it is different from the Source key. Credentials must
stay in n8n's credential store, not in node parameters or Action descriptions.

The connection test uses **Test Action ID**, an existing Action owned by the
Source. If you have none yet, save the credentials, create your first request,
and then supply its ID to test. The test checks Source authentication; it cannot
validate the signing secret. A successful signed callback tests that separately.

See [Source authentication](https://actionbox.cloud/docs/api-authentication) and
[callbacks](https://actionbox.cloud/docs/webhooks).

## Approval workflow

Import `examples/approval.json` into an n8n instance with the package loaded.
Select your credentials on both ActionBox nodes. The example performs a harmless
no-op after approval and reports that demo step's success. Replace that step with
your own integration, including a failure branch that reports a failed outcome.

Set a title, description, priority, and timeout (24 hours by default). Reviewer
emails restrict the Action to those reviewers; leave empty for workspace access.
Labels are customizable; the underlying option IDs remain `approve` and `reject`.

The waiting operation returns:

```json
{
  "input": { "orderId": "your-original-input" },
  "actionbox": {
    "action_id": "returned-action-id",
    "approved": false,
    "decision_status": "timed_out",
    "action_version": 1,
    "fingerprint": "returned-sha256-fingerprint",
    "deadline": 0,
    "response": null,
    "current_action": null
  }
}
```

Continue only when **`actionbox.approved === true`**. `decision_status` can be
`approved`, `rejected`, `expired`, `cancelled`, `timed_out`, `snapshot_changed`, or
`invalid_response`. A timeout means no usable decision was received before this
execution's deadline; it does not mean the person rejected the request. The
pending node's saved result is deliberately a safe timeout placeholder.

The node authenticates callbacks over their raw body, rejects stale signatures,
and reads authoritative Action state before approval. Changed versions or
fingerprints require a new review. Late callbacks cannot approve the execution.
The callback URL and Source details are excluded from normal outputs.

n8n persists waiting execution state. Configure its database persistence and
execution retention to outlive the requested wait. Each new execution creates a
new request. Automatic request retries reuse their exact payload and idempotency
key, but a restarted execution is not an exactly-once business operation. Protect
the downstream side effect with your own stable business idempotency key.

If delivery fails, the wait safely times out. A callback arriving before n8n has
persisted the wait can be rejected by n8n; this version uses the same safe timeout
and explicit reconciliation path for that rare race. Use **Get Action** for explicit
reconciliation; it returns state, not an automatic approval flag. Compare the
stored version/fingerprint before any manual recovery. Do not rerun a destructive
step just because a callback or an outcome report was retried.

## Development and local evaluation

Use Node.js 24 and npm. The compatibility target is n8n **2.38.7**.

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run dev
```

`npm test` includes the real n8n execution-context serialization/resume tests,
with only the external service transport stubbed. With Docker and Python 3:

```sh
npm run test:runtime
```

This starts a disposable pinned n8n container, tests callback admission, restart,
duplicate delivery and timeout handling, and removes the container afterward.
Its test adapter contains only synthetic credentials and is excluded from the
npm package. It never calls the hosted ActionBox API.

For a local instance using the real connector, see [LOCAL_DOCKER.md](LOCAL_DOCKER.md).
Hosted ActionBox callbacks need a public HTTPS address reaching that instance.
Local-only Docker tests do not establish live delivery or n8n Cloud availability.

## Compatibility and support

This version intentionally omits general triggers, typed forms, Watches, Agent
Runs, Source administration, and n8n AI Agent human-review tool registration.
The node relies on n8n's durable waiting and atomic resume behavior; test before
upgrading n8n. No telemetry or background polling is included.

Report bugs with reproduction steps and versions, without credentials or customer
payloads. Public source updates follow [CONTRIBUTING.md](CONTRIBUTING.md).
