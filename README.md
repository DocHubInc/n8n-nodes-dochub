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

Use Node.js 24 or newer (`nvm use` reads `.nvmrc`). Install dependencies once:

```bash
npm install
```

DocHub only accepts a public HTTPS URL for webhooks, so a local `http://localhost:5678` address cannot receive events. Use [ngrok](https://ngrok.com/) to give this machine a public HTTPS address. The editor stays on localhost. API calls still go to `https://dochub.com`.

Start ngrok in one terminal and leave it running. If it asks for an authtoken, add one from the ngrok dashboard with `ngrok config add-authtoken <token>` and run it again.

```bash
ngrok http 5678
```

In another terminal, read the live `https://` URL from ngrok and pass it to n8n. A free tunnel URL changes every time ngrok starts, so this reads the current one instead of a pasted host. It also allows the **Read/Write Files from Disk** node to write under `~/.n8n-files` and this package directory.

```bash
nvm use
WEBHOOK_URL="$(curl -sf http://127.0.0.1:4040/api/tunnels | grep -oE '"public_url":"https://[^"]+"' | head -1 | cut -d'"' -f4)"
echo "WEBHOOK_URL=$WEBHOOK_URL"
N8N_RESTRICT_FILE_ACCESS_TO="$HOME/.n8n-files;$(pwd)" WEBHOOK_URL="$WEBHOOK_URL" npm run dev
```

After the editor opens at <http://localhost:5678>:

1. Create a **DocHub API** credential with an API key from the DocHub account that will emit the events, and confirm it with **Test**.
2. Add **DocHub Trigger** and leave the events you want selected. Turn the workflow **Active**. n8n creates the webhook in DocHub for the printed `WEBHOOK_URL`. Turning the workflow off deletes that webhook. `webhook.ping` returns HTTP 200 and does not start a run.
3. Add **DocHub**, operation **Download**. Set **Document ID** to `{{ $json.data.document.id }}`. **File Name** is optional. Leave it empty to use the name DocHub sends, or set it to an expression such as `{{ $json.data.document.title }}`.

The workflow keeps listening only while ngrok, `npm run dev`, and the Active toggle all stay on. After you restart ngrok, run the `WEBHOOK_URL=...` command again, then turn the workflow off and back on so DocHub stores the new address.

The signing secret is stored in the workflow's static data when DocHub creates the webhook. It is not part of the credential. Importing the workflow on another n8n instance requires activating it again so a new webhook is created.

## Resources

- [DocHub webhooks](https://dev.dochub.com/docs/webhooks)
- [DocHub events](https://dev.dochub.com/docs/webhooks/events)
- [DocHub API key authentication](https://dev.dochub.com/docs/authentication/api-key)
- [n8n community nodes](https://docs.n8n.io/integrations/community-nodes/build-community-nodes/)
