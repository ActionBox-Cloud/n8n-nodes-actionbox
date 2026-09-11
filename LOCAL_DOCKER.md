# Local Docker evaluation

Docker and Docker Compose are required. This starts n8n with the real ActionBox
connector and a persistent local data volume. The ActionBox service remains
hosted at `https://api.actionbox.cloud`.

```sh
docker compose up --build -d
```

Open `http://localhost:5688`, create the local n8n owner account, and save your
ActionBox credentials in n8n. This development configuration binds only to the
local machine. Keep n8n's data volume: it contains credentials and waiting
executions. `docker compose down` preserves it; do not use `down -v` unless you
intend to erase the local evaluation data.

## Test without credentials

From the source checkout, run `npm ci` and `npm test`, then:

```sh
npm run test:runtime
```

This is independent of your evaluation instance. It starts a disposable container
with a test-only simulated ActionBox transport. It exercises real n8n storage,
HTTP callback admission, restart and timer behavior. No live account is needed.

## Test with hosted ActionBox

ActionBox must be able to deliver an HTTPS callback to n8n. Use a public HTTPS
tunnel forwarding to your local n8n instance, or another reachable HTTPS address.
Configure that address before creating an approval:

```sh
ACTIONBOX_N8N_WEBHOOK_URL=https://your-n8n-tunnel.example/ docker compose up -d
```

Keep this address stable until every pending approval finishes. The node preserves
n8n's signed resume URL, checks the ActionBox callback signature, and reads the
Action from the hosted API before approving. Complete the local owner setup before
exposing your instance through a tunnel.

The custom-node installation method uses n8n's `CUSTOM` namespace. Create a local
copy of the example before importing it:

```sh
python3 -c 'import json; p=json.load(open("examples/approval.json")); [(n.update(type="CUSTOM.actionBox")) for n in p["nodes"] if n["type"] == "n8n-nodes-actionbox.actionBox"]; print(json.dumps(p, indent=2))' > /tmp/actionbox-approval-local.json
```

Import that file, select your ActionBox credentials on both nodes, and run the
workflow. Review the request in ActionBox. Only the approved branch reaches the
demo operation and outcome report. Rejection and timeout reach **Not Approved**.
The example is deliberately a no-op, so replace the demo step only after testing.

For a restart check, create another request, wait until n8n shows it as waiting,
run `docker compose restart`, then decide the request in ActionBox. Check that one
continuation appears. Separately test rejection, cancellation, and a one-minute
wait without responding.

The image pins n8n 2.38.7 by digest. Rebuild only after compatibility tests pass,
and drain waiting executions before changing node versions. Retain the previous
image if you need to roll back. Do not replace persisted credentials or encryption
configuration while approvals are outstanding.
