# One page: how I measure it, how I would scale it, and what I traded away

Everything in the first section is measured, not proposed. `npm run eval` runs
every sample lead N times plus an adversarially prompted draft, and writes
`out/eval-report.md`. Figures below are from a live 3-run pass against
`claude-sonnet-4-6`.

## How I measure impact

**Speed to first touch.** Their stated baseline is "someone eventually looks at
them". Measured p50 for a qualified lead, end to end, is **17 to 21 seconds**:
8.4s to draft both artifacts, 12.4s to verify both. The entire deterministic
spine, enrichment, fit scoring, benchmark gate, routing, committee detection and
allow-list assembly, runs in **0ms p50**. All the latency and all the cost sit in
four model calls; none of the logic costs anything. Target for HOT is under five
minutes, so there is two orders of magnitude of headroom before this is the
constraint.

**Coverage.** Percentage of completions receiving a personalised first touch
within the hour. Target 100 percent of HOT and MQL. Speed and coverage together
are what "fix the funnel with systems, not headcount" means in numbers.

**Quality.** MQL to SQL conversion by band, to validate the fit definition
rather than assume it. If HOT and MQL convert alike, the thresholds are wrong.
Given what the sample run showed about score clustering, I expect to be
recalibrating inside the first quarter.

**Committee formation.** Percentage of assessed accounts with two or more
contacts engaged within fourteen days. This is the metric the forwardable note
exists to move, it is a leading indicator of enterprise deal formation, and it is
almost certainly not measured today.

**Agent trust, which is now three real numbers.**

| Measured | Current | What it decides |
|---|---|---|
| Gate pass rate | **66.7%** | Whether drafts are good enough for a lane to graduate |
| Red team catch rate | **100%** | Whether the gate can be trusted at all |
| Pipeline error rate | **0%** of 18 | Whether a lane can run unattended |

Read together, not separately. A prompt change that raises the pass rate while
lowering the red team catch rate has made the system worse: the model has become
more persuasive, not more truthful. That trade is invisible without measuring
both, and it is the trade most teams make by accident.

Worked example from this build. The report showed "benchmark peer group widened"
blocking three ordinary leads: the model was dropping the qualifier "that have
completed this assessment" and quietly widening the comparison group. One added
prompt rule took the pass rate from **50% to 66.7%** while the red team catch
rate held at **100%**. Measured, diagnosed, changed, re-measured.

**Cost.** **$0.032 per qualified lead, $32 per thousand.** Three model calls per
lead. NEWSLETTER leads cost nothing, because routing happens before any spend.

**Asset growth.** Number of segments crossing the n=30 confidence threshold per
month. The direct measure of the benchmark compounding, and the cleanest way to
show that paid spend buys an appreciating asset rather than a cost per lead.

## How I would scale it

What breaks at 10x, in the order it breaks:

1. **The approval queue, and the eval report says so.** Pass rate is 66.7%, so a
   third of drafts need a human. At 10x that is the bottleneck. The honest fix is
   not more reviewers, it is raising the pass rate with the loop above until
   lanes graduate. `HOT_LD` is already at 83.3%.
2. **Latency per lead is 17 to 21 seconds, and 12.4s of it is verification.**
   The verifier is a classification task and does not need the drafting model's
   tier. Moving it to a smaller model is the obvious cut. Batch the non-urgent
   lanes and cache research packs by company domain.
3. **Enrichment quality degrades on long tail domains.** Add per-field
   confidence scoring and route low confidence records to a cheaper lane rather
   than scoring guessed firmographics. A wrong industry corrupts the benchmark
   segment as well as the score.
4. **Duplicate people, across repeat submissions and multiple company domains.**
   Needs entity resolution on contact and account before scoring. Without it the
   same person is contacted three times and the benchmark double counts them,
   which poisons the asset the whole thesis rests on.
5. **Sheets fails on concurrency.** Lane state and the benchmark table move to a
   database. The sheet stays as the human interface, which is what it is good at.

Error rate is 0% across 18 observations, but that is 18, not 1,800. The harness
records malformed responses rather than dying on them precisely so that number
means something at volume.

## What I would build next, in order

1. **Reply triage.** Classify responses into interested, objection, wrong
   person, unsubscribe. Wrong person is the highest value class: a free referral
   to the correct seat on the committee, feeding the committee logic directly.
2. **Closed-won and closed-lost written back into the fit definition**, so
   scoring improves rather than staying static. This is what fixes the
   calibration problem rather than guessing at new thresholds.
3. **The eval harness in CI**, gating prompt changes on the red team catch rate.
   Right now it is a command someone runs. It should be a check that blocks a
   merge.

## One tradeoff I made

Enrichment is a mocked static lookup rather than live Apollo, and lane state is
pinned rather than written back to the sheet. Both are known, solved problems:
wiring an enrichment API and moving a counter to a database is work I can scope,
not work I need to think about.

I spent the time instead on the benchmark confidence gate, the committee logic
and the evaluation harness, because those change what the system is allowed to
say, who it can reach, and whether anyone can tell if it is working. Enrichment
plumbing makes the same system slightly better informed.

The harness earned that choice on its first run. It found that the gate was
blocking the model for doing arithmetic on the recipient's own scores, and that
the research pack was handing the drafting agent facts the verifier had never
been given, so an agent following its instructions was guaranteed to be blocked
for it. Neither was visible against my own fixtures, because I had written those
fixtures to pass.
