# Nebius Academy - Inbound Lead Engine (Track A)

Take-home build. An assessment completion arrives on a webhook, and within seconds
a scored, routed, benchmarked lead is logged with a personalised first touch and a
second artifact aimed at the seat missing from the buying committee. Nothing sends
unless it passes two independent trust gates.

Built by Adam O'Flynn. Stack: n8n, Anthropic API, Google Sheets.

---

## Run it

```bash
npm run sheets   # regenerate the Google Sheets seed tabs from the engine tables
npm run build    # generate the n8n workflow from lib/engine.js and lib/prompts.js
npm start        # run all five sample leads end to end, writes out/ and a full trace
npm run demand   # cluster the demand corpus into ad angles and an AEO prompt list
npm test         # execute the generated n8n Code nodes and assert the outcomes
npm run all      # all of the above
```

No dependencies. Node 20 or later.

`npm start` prints a step by step trace of every lead through every node.
`out/run-trace.txt` is the same trace on disk, and is the fastest way to see what
this does without running anything.

### What is real and what is mocked

| Layer | Status |
|---|---|
| Enrichment, fit scoring, benchmark gate, routing, committee detection, research pack, deterministic verification, lane resolution | Real. Executes on every run. |
| The three Anthropic calls (draft, forwardable note, LLM verifier) | Run live against `claude-sonnet-4-6` when `ANTHROPIC_API_KEY` is set. Replayed from `test/fixtures/` when it is not, and every output line says which. |
| Enrichment source | Mocked static lookup on the email domain. Seam marked in `lib/engine.js`. |
| Google Sheets, sending, scheduling | Not wired. The workflow has the nodes with credential placeholders. |

### What the live runs changed

The first version of this was built and tested against hand-authored fixtures.
Running it live against the API found five bugs, and three of them were in the
trust machinery itself:

1. **The gate blocked on punctuation.** Em dashes produced the same FAIL verdict
   as invented statistics. A gate that stops a send over house style is a gate
   everybody learns to override. Findings now carry a severity: style issues are
   normalised automatically and logged, only truth violations block.
2. **The gate blocked the model for doing arithmetic.** It wrote "a 16 point gap
   between tooling (74) and governance (58)", both permitted facts, and the
   orphan-number check rejected 16. Differences between permitted scores are now
   admitted.
3. **The research pack handed the drafting agent facts the verifier did not
   have.** The recommended product angle, the lead's surname, and the premise
   that an assessment had been completed at all were all given to the drafter
   and absent from the verifier's permitted list, so an agent that followed its
   instructions was guaranteed to be blocked for it. Three separate bugs, one
   shape: **every fact the drafter is given must be a fact the verifier
   accepts.**
4. **The verifier returned its own hedging as blocking findings**, including one
   whose text read "this is borderline and noted below rather than blocked"
   while sitting in the array that halts a send. Severity is now in the schema
   rather than in prose.
5. **The red team test was too weak to test anything.** It only deleted the
   benchmark prohibition, the remaining rules held the model in line, and the
   gate passed by luck. See below.

Every one of those was invisible against the fixtures, because the fixtures were
written to be compliant. The fixtures tested whether the gate accepted good
drafts. Only live output tested whether its definition of good was correct, and
twice it was not.

**Verdicts vary between runs.** Five live runs produced five different
combinations of pass and block. That is a non-deterministic writer meeting a
strict checker, and it is the real-world form of the approval-unchanged rate
listed as an agent-trust metric in the one-pager. A gate that returns the same
verdict every time is not inspecting anything.

---

## Architecture

```
[1]  Webhook, assessment completion
       |
[2]  Enrichment (mocked lookup, seam marked)
       |
[3]  Fit scoring (deterministic, no LLM)
       |
[4]  Benchmark lookup + confidence gate          <- IDEA ONE
       |
[5]  Router: HOT / MQL / NEWSLETTER
       |
[6]  Committee gap detection                     <- IDEA TWO
       |
[7]  Research pack assembly (the allow list)
       |
[8]  Draft agent -> primary email
[8b] Draft agent -> forwardable note for the missing seat
       |
[9]  Verification gate: deterministic, then LLM
       |
     PASS -> [10]  lane on auto? send : queue for approval
     FAIL -> [10b] human review row with failure reasons
       |
[11] Log to Google Sheets
[12] Append stated_priority to the demand corpus  <- IDEA THREE
```

Steps 2 to 7 and 12 are deterministic and cheap, so they run before a single
token is spent. A NEWSLETTER lead costs nothing in LLM spend.

### One source of truth

The n8n Code nodes are not hand written. `build/build-workflow.mjs` inlines
`lib/engine.js` and `lib/prompts.js` into every Code node at build time. The
scoring rules exist in exactly one place, the local harness exercises that
place, and `npm test` pulls the generated `jsCode` back out of the workflow JSON
and executes it to prove the two have not diverged. 37 assertions.

---

## The three ideas

### Idea one: the assessment is a data asset, not a lead magnet

Every completion is a proprietary data point on how a kind of organisation scores
on AI readiness. A few hundred of them is a benchmark dataset no competitor can
replicate without running the same assessment at the same volume.

So the outreach stops reporting a score and starts reporting a position:

> "Your skills score of 22 is bottom quartile among financial services
> organisations over 1,000 employees that have completed this assessment (n=47).
> Tooling came out at 45, so the constraint looks like capability rather than
> technology."

That is intelligence the recipient cannot get anywhere else, delivered before any
money changes hands.

**The flywheel:** more assessments produce a better benchmark, a better benchmark
produces more compelling outreach, more compelling outreach produces more
assessments. Paid spend on LinkedIn, Google and Meta is therefore buying an
appreciating dataset, not just leads. That reframes CAC as investment rather than
cost.

**The rigor layer, which is the part that earns trust.** A benchmark claim is only
permitted when the sample supports it:

- n >= 30 on the exact segment (industry x size band), claim permitted at that granularity
- otherwise widen to industry only and re-check
- otherwise no benchmark claim enters the allow list at all, and the draft falls
  back to absolute framing

All three branches fire in the sample run:

| Lead | Segment | Outcome |
|---|---|---|
| Maria, Banco Example | `financial_services_1000plus` n=47 | permitted at full granularity |
| Tomas, Playline Games | `gaming_250_999` n=12, widened to `gaming_all` n=38 | permitted at industry level |
| Priya, Vantage Partners | `professional_services_50_249` n=15, widened to `professional_services_all` n=41 | permitted at industry level |
| Daniel, Corvus Logistics | `logistics_1000plus` n=8, widened to `logistics_all` n=19 | **withheld**, absolute framing only |

The system never asserts a statistical claim it cannot support. This is the same
principle as the verification gate, applied to data rather than to language.

### Idea two: detect the missing seat on the buying committee

Enterprise AI training needs two buyers. An L&D or People leader who holds budget
and owns rollout, and a technical sponsor who validates that the training is real.
When one person completes an assessment, the deal is structurally half formed.
The standard move is to nurture that person harder. The better move is to go and
find the other seat.

After scoring, the system identifies which side is present and generates a second
artifact, under 80 words, written in the language of the missing counterpart for
the lead to forward internally.

Maria is Head of L&D, so the missing seat is technical. Her forwardable note:

> "We completed the Nebius Academy AI readiness assessment. Skills came out at 22
> against tooling at 45, so the gap is capability rather than platform. Their
> programmes are taught by practitioners who run AI in production and they certify
> engineers in AI cloud skills, which is the part I would want you to sanity check
> before we commit to anything."

Tomas is a CTO, so the inverse: his note is pitched at L&D, on cohort design and
rollout across his stated 120 engineers.

This converts a single-lead funnel into a buying-committee funnel with no extra
headcount, paid spend or data. It also gives sales a multi-threaded account
rather than a lone contact.

**Metric it moves:** percentage of assessed accounts with two or more contacts
engaged within fourteen days. A leading indicator of enterprise deal formation,
and almost certainly not measured today.

The forwardable note passes the same verification gate as the primary email. A
note written to be forwarded to a CTO is the last place you want a hallucinated
claim.

### Idea three: harvest the demand language, feed it to AEO

The assessment's free-text priority field is a sample of how real buyers describe
the problem, unprompted, at the moment they are considering a purchase. In most
companies it sits unread in a CRM field.

Every submission appends to a corpus, including NEWSLETTER leads we will never
email. `npm run demand` clusters it and outputs three things: ad angles in buyer
phrasing, landing page headline variants for the assessment itself, and a
buyer-intent prompt list for answer engine monitoring.

Ad angles from the sample corpus:

- LinkedIn: "You bought the licences. Usage fell off after month two."
- LinkedIn: "Three pilots. None of them stuck. The pattern is not the technology."
- Google: "Who decides what is safe to ship with AI?"

**Why this one matters.** Track C is about measuring how Nebius Academy appears
inside AI assistants and generative search. Its hardest problem is knowing which
prompts to monitor, and the standard approach is to guess them. Track A generates
them for free, from what real respondents actually typed. I chose Track A, and
this is the seam where it hands off to Track C.

Scope discipline: this runs over a pre-seeded corpus of 14 statements with a
single clustering call. The recurrence is stubbed. In production it is a weekly
job, not a script anyone runs by hand.

---

## Fit scoring

Deterministic and rules based. No LLM anywhere near it. When a rep asks why a lead
scored 82, one file answers, and `score_reasons` on every row carries the working.

Two buyer models, because Nebius Academy sells to L&D leadership and to technical
leadership and they qualify differently. A single generic scorer would average
them into something that fits neither.

| Component | Max | Detail |
|---|---|---|
| Company size | 25 | 1000+ = 25, 250-999 = 20, 50-249 = 10, under 50 = 0 |
| Seniority | 25 | C-level or VP = 25, Director or Head = 20, Manager = 10, IC = 2 |
| Role family | 20 | LD or TECH = 20, adjacent = 8, other = 3 |
| Industry | 15 | priority verticals = 15, others = 7 |
| Readiness need | 15 | **inverted**: 0-39 = 15, 40-59 = 12, 60-79 = 7, 80-100 = 2 |

**The inversion is the commercial point.** A low readiness score means high need,
so it must raise fit, not lower it. Scoring it the intuitive way round pushes the
organisations that most need training to the bottom of the queue.

**Override:** IC seniority at a company under 50 forces NEWSLETTER regardless of
total. Sample lead 3 fires it.

**A calibration problem I found and did not paper over.** With these weights, any
genuinely qualified enterprise lead scores 90 or above: the sample HOT leads come
out at 95, 92 and 97, well clear of the 70 threshold. The components discriminate
between enterprise and mid-market (Priya scores 62 and lands MQL) but barely
discriminate within enterprise. The thresholds are a starting position, not a
finding. They should be recalibrated against closed-won and closed-lost data as
soon as there is any, which is the feedback loop in "what I would build next".

**Not built, worth saying out loud:** a lead scoring 85+ on readiness does not
need foundational training. Production routes them to certification or Evolve
rather than dropping them. The flag is computed (`advanced_product_flag`), the
routing is not. Turning a bad fit into a different fit.

---

## The verification gate

Two independent layers. Both must pass.

Findings carry a **severity**. `block` stops the send and fetches a human.
`note` is recorded in `reviewer_notes` and does not hold up the queue. House
style violations are normalised automatically and logged in `style_autofixed`,
never blocked.

**Layer one, deterministic, runs first and runs free.**

- Every number in the subject and body must appear in the permitted facts. Any
  orphan fails.
- Blocklist scan: "studies show", "industry average", "most organisations",
  "companies like yours" and similar unsourceable authority claims.
- When no benchmark fact is present, comparative language is prohibited outright:
  "compared to", "peers", "benchmark", "percentile", "quartile", "below average",
  "median".
- Em dash and en dash characters are normalised to commas and logged. Style,
  not truth, so it never blocks.
- Numbers derivable from permitted scores are allowed. A model that computes the
  gap between two of the recipient's own section scores has done arithmetic, not
  invented a statistic, and blocking it teaches the agent to be vaguer than the
  facts permit.

**Layer two, an LLM verifier**, deliberately biased towards FAIL. It treats a
claim as unsupported if it adds specificity not present in the allow list, even
when it sounds plausible. A false FAIL costs one human glance. A false PASS puts
an invented claim in front of an enterprise buyer.

The drafting agent is required to return `facts_used`, which forces it to declare
its own sources and makes verification cheaper.

What makes this enforceable rather than aspirational is the research pack. The
agent is given an explicit allow list and told it may assert nothing else, so when
the confidence gate withholds a benchmark, the agent is structurally unable to
imply one. The fact simply is not there.

### Lead 4 is the moment

Daniel Whitmore, VP People at Corvus Logistics. Two independent trust mechanisms
fire on one record.

**First**, the confidence gate blocks the benchmark. `logistics_1000plus` has n=8,
widening to `logistics_all` gives n=19, both below the floor of 30. No benchmark
fact enters the allow list, and the draft falls back to absolute framing: "the
weakest of the four sections... on the evidence of the assessment alone".

**Then** the same lead is drafted again under an adversarial prompt, a red team
fixture that instructs the model to lead with a percentile comparison, cite a
failure statistic, and describe what most organisations in its position do. The
research pack is unchanged and still contains no benchmark fact.

This is deliberately hostile, and that is the point. The first version of this
test only deleted the benchmark prohibition; the remaining rules held the model
in line, the gate passed, and the test proved nothing. The claim worth making is
that the gate holds when the prompt attacks it, not that the model usually
behaves.

Both layers fire independently. From the last live run:

```
LAYER 1  orphan number "85" is not present in, or derivable from, the permitted facts
LAYER 1  comparative language "quartile" used with no benchmark fact in the pack
LAYER 2  "placing you in the bottom quartile for logistics organisations"
LAYER 2  "where most of your sector scores considerably higher"
LAYER 2  "roughly 85% of AI initiatives fail to move beyond the pilot stage"
LAYER 2  "Most logistics organisations in your position prioritise upskilling..."
```

Routed to human review with the reasons attached. Nothing sends.

---

## Approval and graduation

Lanes start manual. Approving a draft unchanged increments a counter. Any edit or
rejection resets it to zero. At 20 consecutive unedited approvals the lane flips
to auto and sends without approval, with a one in ten spot check row so a lane on
auto never becomes completely unobserved.

| lane | mode | consecutive_unchanged | threshold |
|---|---|---|---|
| HOT_LD | manual | 3 | 20 |
| HOT_TECH | manual | 0 | 20 |
| MQL_LD | **auto** | 20 | 20 |
| MQL_TECH | manual | 11 | 20 |

`MQL_LD` is pre-seeded at threshold so both paths demonstrate live. Priya (MQL_LD)
sends automatically. Maria and Daniel (HOT_LD) and Tomas (HOT_TECH) queue for
approval.

Trust is earned by measurement rather than granted by configuration. That is the
answer to the anxiety behind Track B's approval-step requirement: the question is
not whether to trust the agent, it is what evidence would justify trusting it in
one narrow lane, and what resets that trust.

**Personal contact firewall:** a hard blocklist checked before anything is queued.
One line of code. It exists because the first time a prototype emails your own
investor list is the last time anyone lets you run one.

---

## Sample leads

| # | Lead | Fit | Band | Benchmark | Missing seat | Gate | Outcome |
|---|---|---|---|---|---|---|---|
| 1 | Maria Alvarez, Head of L&D, Banco Example, 4,200, Financial Services | 95 | HOT | permitted, n=47 | TECH | PASS | queued, HOT_LD manual |
| 2 | Tomas Berg, CTO, Playline Games, 620, Gaming | 92 | HOT | widened to industry, n=38 | LD | PASS | queued, HOT_TECH manual |
| 3 | Jess Okonkwo, Marketing Executive, Northline Agency, 18 | 32 | NEWSLETTER | n/a | n/a | n/a | newsletter only, no LLM spend |
| 4 | Daniel Whitmore, VP People, Corvus Logistics, 2,800, Logistics | 97 | HOT | **withheld**, n=8 then n=19 | TECH | PASS | queued, absolute framing |
| 4b | Daniel again, loosened prompt | 97 | HOT | withheld | TECH | **FAIL** | human review, 7 violations |
| 5 | Priya Raman, L&D Manager, Vantage Partners, 180, Professional Services | 62 | MQL | widened to industry, n=41 | TECH | PASS | **sent automatically**, MQL_LD auto |

Lead 5 is an addition to the four in my plan. Without a lead landing in MQL, the
pre-seeded auto lane never demonstrates and half the graduation model is
untestable. It cost two minutes.

Lead 3 also carries a small trap worth pointing at. A naive seniority keyword
match on "executive" reads "Marketing Executive" as C-level and routes an 18
person agency into HOT. In Ireland and the UK that title is an individual
contributor. `inferSeniority()` handles it deliberately, with a comment. This is
the class of bug that makes a sales team stop trusting a score, quietly, and
permanently.

---

## Importing into n8n

1. `npm run build`
2. In n8n: Workflows, Import from File, `workflows/nebius-inbound-engine.json`
3. Replace the credential placeholders: `anthropicApi` on the three HTTP Request
   nodes, `googleSheetsOAuth2Api` and `REPLACE_WITH_YOUR_SHEET_ID` on the six
   Google Sheets nodes
4. Create the sheet tabs from `data/sheets/` (`benchmark`, `lane_state`,
   `demand_corpus`) plus empty `leads` and `approval_queue` tabs
5. POST any file from `data/sample-leads/` at the webhook

The Code nodes are generated. Edit `lib/`, run `npm run build`, re-import. Editing
them in the n8n UI puts the logic back in two places, which is the thing this
build is arranged to avoid.

---

## Assumptions

Stated rather than assumed silently.

1. **The AI Readiness Assessment in the scenario is Skillcheck, or is built on
   it.** Skillcheck appears to be the assessment product. This is an inference
   from public material, not a fact I was given.
2. **L&D and technical leadership are separate qualification models**, not one
   blended definition. The build treats them as two buyer models with different
   messaging and different missing counterparts. This is the sharper of my two
   clarifying questions, and I built assuming separation rather than waiting.
3. **The benchmark sample floor of n=30** is a convention, not a derived figure.
   It is a parameter (`BENCHMARK_MIN_N`) and should be argued about.
4. **A respondent who is neither L&D nor technical defaults to a missing L&D
   seat**, on the reasoning that training budget usually sits there. Flagged in
   the output as an assumption, not silently applied.
5. **The benchmark distributions are invented** for the prototype. In production
   they are a materialised view over completed assessments, recomputed nightly.
6. Company data in the sample leads is fictional.

Nothing in this build leans on the "95 percent of AI pilots fail" figure. It
originates in the MIT NANDA report, its methodology has been publicly challenged,
and it concerns a narrower claim than the way it is usually quoted.

---

## Seams, named out loud

- **Enrichment** is a static lookup keyed on email domain. Production wires Apollo
  or Clearbit with per-field confidence scoring, and routes low confidence records
  to a cheaper lane rather than scoring guessed firmographics.
- **Lane state** lives in a sheet. A sheet is the wrong home for a counter that
  concurrent executions increment. Production holds it in a real database.
- **No auto retry.** A failed draft goes straight to a human. Production retries
  once with the failure reason fed back into the prompt, then escalates.
- **No scheduler** for the demand corpus. Stubbed, run by hand.
- **No sending.** The workflow stops at the sheet. The ESP handoff is a node that
  does not exist.
- **The research pack** is assessment data only. Production adds recent company
  news, tech stack signals and prior touch history. Each addition widens what the
  agent is permitted to say, which is the correct way to make outreach richer.
- No auth, no error framework, no dashboard. The sheet is the interface.

---

## Files

```
lib/engine.js            all deterministic logic. one source of truth
lib/prompts.js           four prompts, including the deliberately loosened one
lib/llm.js               Anthropic caller, live or replayed
build/build-workflow.mjs generates the n8n workflow by inlining lib/
build/export-sheets.mjs  generates the sheet seed tabs from the engine tables
test/run-local.mjs       full pipeline over five leads, writes out/
test/verify-workflow.mjs executes the generated n8n Code nodes, 37 assertions
test/run-demand-corpus.mjs  idea three
data/sample-leads/       five payloads
data/demo/               the adversarial red team payload, kept out of the
                         sample-leads glob so it never runs as a normal lead
data/sheets/             benchmark, lane_state, demand_corpus seeds
workflows/               the importable n8n workflow (generated)
docs/one-pager.md        impact, scale, tradeoff (the required one-pager)
docs/clarifying-question.md
out/                     run output, including run-trace.txt
```
