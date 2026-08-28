#!/usr/bin/env bash
# Fire sample assessment completions at the n8n webhook.
#
#   ./scripts/send-lead.sh <webhook-url> [lead-file ...]
#
# With no lead files it sends all five in order, then the loosened-prompt
# rerun that the verification gate is supposed to block.
#
# To watch a run on the canvas: paste the TEST webhook URL from the n8n
# editor, click "Listen for test event", then send one lead.
set -euo pipefail

URL="${1:-}"
if [[ -z "$URL" ]]; then
  echo "usage: $0 <webhook-url> [lead-file ...]" >&2
  echo "example: $0 https://YOUR.app.n8n.cloud/webhook-test/nebius-academy/assessment-completed" >&2
  exit 1
fi
shift

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/data/sample-leads"
if [[ $# -gt 0 ]]; then
  FILES=("$@")
else
  FILES=(
    "$DIR/lead-1-maria.json"
    "$DIR/lead-2-tomas.json"
    "$DIR/lead-3-jess.json"
    "$DIR/lead-4-daniel.json"
    "$DIR/lead-5-priya.json"
    "$ROOT/data/demo/lead-4-daniel-LOOSENED.json"   # red team payload lives outside the sample glob
  )
fi

for f in "${FILES[@]}"; do
  name=$(basename "$f" .json)
  printf '\n--> %s\n' "$name"
  curl -sS -X POST "$URL" \
    -H 'content-type: application/json' \
    --data-binary "@$f" \
    -w '\n    HTTP %{http_code} in %{time_total}s\n' || echo "    send failed"
  # n8n test webhooks accept one event per listen, so pause between sends
  [[ ${#FILES[@]} -gt 1 ]] && sleep 2
done

printf '\nDone. Check the n8n Executions tab and your Google Sheet.\n'
