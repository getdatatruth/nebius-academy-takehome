# Getting this live, for the Loom

Two routes. Pick one.

**Local, free, no account.** Already running via Docker. The workflow and the
Anthropic credential are imported. Nothing to sign up for and no trial clock.
The only thing it cannot do is Google Sheets, because self-hosted n8n needs your
own Google Cloud OAuth client. `npm run build:local` produces a variant where the
six Sheets nodes are replaced with pass-through nodes carrying the exact row, so
every node still executes and goes green. **This is the recommended route for
recording.**

```bash
docker start nebius-n8n          # if it is not already up
open http://localhost:5678       # workflow is already imported
```

**n8n Cloud, if you want the sheet filling live on camera.** Google Sheets
connects in one click there because n8n owns the OAuth app. Steps 1 to 6 below.

> **The bug that will stop you if you skip this.** n8n validates required
> parameters *before* it starts an execution. A Google Sheets node with no
> Document selected does not fail on its own, it stops the entire workflow from
> running with "Workflow execution cannot start". Either configure all six
> Sheets nodes, or use the `build:local` variant. There is no middle state.

---

Roughly 25 minutes end to end. Do steps 1 and 2 in parallel, they are both
waiting on someone else's signup form.

---

## 1. Anthropic API key

1. <https://console.anthropic.com> and sign up or sign in
2. Add credit. **5 EUR is far more than enough.** The whole demo, run a dozen
   times over, is a few cents: three calls per qualified lead on
   `claude-sonnet-4-6`, roughly 2,000 tokens each
3. API keys, Create key, copy it. It is shown once
4. Keep it in a password manager, not a note. It is a live spend credential

## 2. n8n Cloud trial

1. <https://n8n.io> and start the free trial, 14 days, no card
2. Note your instance URL, it looks like `https://yourname.app.n8n.cloud`

## 3. The Google Sheet

1. New Google Sheet. Name it "Nebius Academy inbound engine"
2. Create five tabs, named **exactly**:
   `benchmark`, `lane_state`, `demand_corpus`, `leads`, `approval_queue`
3. Open `data/sheets/PASTE-INTO-SHEETS.txt`. For each block: open that tab,
   click A1, paste. Sheets splits the tab-separated text into columns itself
4. Use the same Google account you will connect to n8n

The `benchmark` tab is the one to have visible during the Loom. Point at
`logistics_1000plus` with n=8 when you get to Daniel.

## 4. Import the workflow

1. `npm run build` locally, to be sure the JSON is current
2. In n8n: **Workflows, Import from File**, choose
   `workflows/nebius-inbound-engine.json`
3. 23 nodes appear. Nothing is wired to your accounts yet, which is expected

## 5. Connect the two credentials

**Anthropic.** Open any of the three HTTP Request nodes, the ones named
`[8] Draft agent`, `[8b] Forwardable note agent`, `[9] LLM verifier`. In the
Credential field choose **Create new**, paste your API key, save. The other two
nodes then pick the same credential from the dropdown.

**Google Sheets.** Open any of the six Google Sheets nodes. Credential, Create
new, **Sign in with Google**. On n8n Cloud this is one click, n8n owns the OAuth
app so there is no Google Cloud project to set up. Then in each of the six nodes
pick your spreadsheet from the Document dropdown. The tab name is already filled
in on each node, so only the document needs choosing.

Six nodes, all pointing at the same spreadsheet, different tabs.

## 6. First run

1. Open the `[1] Assessment completion` webhook node, copy the **Test URL**
2. Click **Listen for test event**
3. In your terminal:

```bash
./scripts/send-lead.sh 'PASTE_TEST_URL' data/sample-leads/lead-1-maria.json
```

The canvas animates node by node. Green ticks all the way through to the sheet.
Open your `leads` tab and Maria's row is there, with `score_reasons` carrying
the full working.

If a node goes red, click it. n8n shows the exact input and error.

---

## Recording the Loom

The canvas animating is the shot. Have three things open: the n8n canvas, the
Google Sheet, and `out/run-report.html` if you want the benchmark distributions
visible.

**Fire one lead at a time**, clicking "Listen for test event" before each. The
test webhook accepts one event per listen, which is exactly the pacing you want
on camera anyway.

| Beat | Send | What to point at |
|---|---|---|
| Enrich, score, route | `lead-1-maria.json` | `score_reasons` on the sheet row, and the readiness inversion adding 15 |
| The benchmark layer | same run | `benchmark_statement` on the row: bottom quartile, n=47 |
| Committee gap | same run | `forwardable_note` column, written for a CTO |
| Confidence gate | `lead-4-daniel.json` | `benchmark_available` is FALSE, `benchmark_segment` says n=8. Cut to the `benchmark` tab and show the row |
| **Verification gate** | `lead-4-daniel-LOOSENED.json` | Flows down the FAIL branch. `failure_reason` lists all seven violations |
| Graduation | `lead-5-priya.json` | `mode` is auto, `action_taken` is "sent automatically". Cut to `lane_state` and show MQL_LD at 20 of 20 |
| Newsletter | `lead-3-jess.json` | Router sends it out the third output. No draft, no LLM nodes touched |

### The loosened-prompt payload

`data/sample-leads/lead-4-daniel-LOOSENED.json` is Daniel's identical payload
with one extra field:

```json
"_demo_loosen_prompt": true
```

The `[8] Build draft request` node reads that flag and swaps rule 3 of the
drafting prompt, the benchmark prohibition, for an instruction to compare.
Nothing else changes. Say that out loud while it runs: the only difference
between the record that passed and the record that failed is one sentence of
prompt.

Open the node on camera if you want to show the switch. It is nine lines with a
comment explaining why it exists.

### To fire all six in a row

Activate the workflow (toggle, top right), swap the Test URL for the Production
URL, then:

```bash
./scripts/send-lead.sh 'PASTE_PRODUCTION_URL'
```

The canvas does not animate on production runs, but the sheet fills up and the
Executions tab shows all six. Good for a closing shot of the finished sheet.

---

## If something breaks mid-recording

**A node is red on the Anthropic call.** Almost always no credit on the key.
The error body says so. `console.anthropic.com`, Billing.

**The model returned unparseable JSON.** The parse helpers already strip
markdown fences and fall back to extracting the first JSON object, so this is
rare. If it happens, the node error shows the raw text. Re-run the lead.

**A Google Sheets node fails on the column mapping.** The tab is missing its
header row. Paste the header line from `PASTE-INTO-SHEETS.txt`.

**Webhook returns 404.** The test URL expired. Click "Listen for test event"
again, the URL is only live while it is listening.

**Everything fails at once.** Fall back to `npm start` locally, which needs
nothing but Node and produces the same trace. `npm run eval` still works too, and
the evaluation report is arguably the stronger artifact anyway. It is a worse shot but it is a
working prototype either way, which is what they said they wanted.

---

## What to say about the seams while it is running

Named out loud, in the order they will notice them:

- Enrichment is a static lookup on the email domain. Production wires Apollo
  with per-field confidence scoring
- Lane state is pinned in the code node rather than read back from the sheet,
  because a sheet is the wrong home for a counter that concurrent executions
  increment. Production holds it in a database
- Nothing actually sends. The workflow stops at the sheet, the ESP handoff is a
  node that does not exist
- No retry on gate failure. Production retries once with the failure reason fed
  back into the prompt, then escalates
