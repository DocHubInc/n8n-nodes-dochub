# n8n-nodes-dochub

n8n community nodes for [DocHub](https://dochub.com). A trigger starts a workflow when DocHub sends a webhook, and a second node downloads the document PDF with an API key.

[n8n](https://n8n.io/) is a workflow automation platform.

## Nodes

- **DocHub Trigger** subscribes to every DocHub webhook event: `document.created`, `document.shared`, `document.status_changed`, `sign_request.created`, `sign_request.voided`, `signer.finalized`, and `signer.rejected`. Activating the workflow creates the webhook in DocHub. Turning it off deletes that webhook. Each delivery is checked with the DocHub HMAC signature before the workflow starts.
- **DocHub** downloads the compiled PDF for a document id. After the trigger, that id is usually `{{ $json.data.document.id }}`.

`webhook.ping` is answered with HTTP 200 and does not start a workflow. It is DocHub's connectivity test, not a business event.

## Credentials

Create an API key in DocHub and store it in the **DocHub API** credential. Requests send it as `X-API-Token`.

The key needs:

- webhook create, read, delete, and secret rotation, or the `all` permission, plus admin access on the account
- permission to download the document PDF

DocHub only allows webhook creation on paid plans.

## Test locally

This package runs in a local n8n before it is published. It does not appear in the node search on app.n8n.cloud until n8n verifies it.

Use Node.js 24 or newer (`nvm use` reads `.nvmrc`).

```bash
npm install
npm test
npm run dev
```

`npm run dev` opens n8n at <http://localhost:5678> with these nodes loaded.

DocHub rejects localhost webhook URLs. To receive a real event:

1. Start a public HTTPS tunnel to port 5678.
2. Set `WEBHOOK_URL` to the tunnel origin, including `https://` and with no path, then start n8n again. For example: `WEBHOOK_URL=https://your-host.example npm run dev`
3. Add the DocHub API credential and confirm it with **Test**.
4. Add **DocHub Trigger**, leave the events you want selected, and activate the workflow (or listen for a test event). n8n registers the webhook in DocHub.
5. Add **DocHub**, operation **Download**, and set Document ID to `{{ $json.data.document.id }}`.

The signing secret is stored in the workflow's static data when DocHub creates the webhook. It is not part of the credential. Importing the workflow on another n8n instance requires activating it again so a new webhook is created.

## Resources

- [DocHub webhooks](https://dev.dochub.com/docs/webhooks)
- [DocHub events](https://dev.dochub.com/docs/webhooks/events)
- [DocHub API key authentication](https://dev.dochub.com/docs/authentication/api-key)
- [n8n community nodes](https://docs.n8n.io/integrations/community-nodes/build-community-nodes/)
