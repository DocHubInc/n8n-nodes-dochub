#!/usr/bin/env bash
# Start ngrok for local n8n, read the public HTTPS URL, and run the editor.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if ! command -v ngrok >/dev/null 2>&1; then
	echo "ngrok is not installed. Install it from https://ngrok.com/download" >&2
	exit 1
fi

if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
	# shellcheck disable=SC1091
	. "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
	nvm use
fi

ngrok_pid=""
started_ngrok=0
ngrok_log="/tmp/n8n-nodes-dochub-ngrok.log"

cleanup() {
	if [[ "$started_ngrok" -eq 1 && -n "$ngrok_pid" ]]; then
		kill "$ngrok_pid" 2>/dev/null || true
		wait "$ngrok_pid" 2>/dev/null || true
	fi
}
trap cleanup EXIT INT TERM

tunnel_url() {
	local body
	body="$(curl -sf http://127.0.0.1:4040/api/tunnels || true)"
	[[ "$body" == *":5678"* ]] || return 0
	printf '%s\n' "$body" | grep -oE '"public_url":"https://[^"]+"' | head -1 | cut -d'"' -f4
}

if curl -sf http://127.0.0.1:4040/api/tunnels >/dev/null; then
	echo "Using the ngrok agent already running."
else
	echo "Starting ngrok for http://localhost:5678"
	ngrok http 5678 --log stdout >"$ngrok_log" 2>&1 &
	ngrok_pid=$!
	started_ngrok=1
fi

url=""
for _ in $(seq 1 40); do
	url="$(tunnel_url || true)"
	if [[ -n "$url" ]]; then
		break
	fi
	if [[ "$started_ngrok" -eq 1 ]] && ! kill -0 "$ngrok_pid" 2>/dev/null; then
		echo "ngrok stopped before a tunnel was ready. Log:" >&2
		cat "$ngrok_log" >&2
		exit 1
	fi
	sleep 0.5
done

if [[ -z "$url" ]]; then
	echo "No https tunnel for port 5678 was found at http://127.0.0.1:4040/api/tunnels." >&2
	echo "Stop any other ngrok agent, then run this script again." >&2
	exit 1
fi

export WEBHOOK_URL="$url"
if [[ -z "${N8N_RESTRICT_FILE_ACCESS_TO:-}" ]]; then
	export N8N_RESTRICT_FILE_ACCESS_TO="$HOME/.n8n-files;$root"
fi

echo "WEBHOOK_URL=$WEBHOOK_URL"
echo "N8N_RESTRICT_FILE_ACCESS_TO=$N8N_RESTRICT_FILE_ACCESS_TO"
echo "Editor: http://localhost:5678"
echo "After the editor opens, turn the workflow off and on so DocHub stores this webhook URL."

npm run dev
