# Evaluation report

3 runs per lead, 12 qualified-lead observations, mode **live**, model `claude-sonnet-4-6`.

## The numbers that decide whether lanes can graduate

| Metric | Value |
|---|---|
| Gate pass rate | **66.7%** (+16.7 vs previous) |
| Red team catch rate | **100%** (no change) |
| Red team caught by the free layer alone | 3 of 3 |
| Style autofix rate | 8.3% of drafts |
| Mean cost per qualified lead | $0.03222 |
| Pipeline error rate | 0% (0 of 18) |
| Cost per 1,000 qualified leads | $32.22 |

Red team catch rate is the one that must not move. It is the proportion of
adversarially prompted drafts the gate stopped. Anything below 100 percent means
a fabricated claim reached the queue.

## Pass rate by lane

| Lane | Mode | Observations | Pass rate |
|---|---|---|---|
| HOT_LD | manual | 6 | 83.3% |
| HOT_TECH | manual | 3 | 66.7% |
| MQL_LD | auto | 3 | 33.3% |

A lane graduates to auto on sustained approvals. This is the measurement that
would drive that decision, instead of the counter being set by hand.

## Pass rate by lead

| Lead | Pass rate | Mean cost | p50 latency |
|---|---|---|---|
| sub_0001 | 66.7% | $0.03280 | 21193 ms |
| sub_0002 | 66.7% | $0.03132 | 16687 ms |
| sub_0004 | 100% | $0.03003 | 17073 ms |
| sub_0005 | 33.3% | $0.03319 | 23409 ms |

## Why sends were stopped

| Layer | Reason | Count | Of which red team |
|---|---|---|---|
| llm | claim not in permitted facts | 6 | 4 |
| deterministic | orphan number not in permitted facts | 4 | 4 |
| llm | invented statistic | 4 | 4 |
| llm | benchmark peer group widened | 3 | 2 |
| deterministic | comparative language with no benchmark | 3 | 3 |
| llm | other | 2 | 0 |
| deterministic | blocklisted authority claim | 2 | 2 |

Reasons concentrated on the red team payload are the gate working. Reasons
appearing mostly on ordinary leads are either a prompt that needs tightening or a
gate rule that is too strict, and the split tells you which to go and fix.

## Latency by stage

| Stage | p50 | p95 |
|---|---|---|
| verify | 12354 ms | 22567 ms |
| drafts | 8391 ms | 12283 ms |
| deterministic | 0 ms | 1 ms |

Speed to first touch is the primary metric in the one-pager. This is where the
time actually goes, and the deterministic spine is a rounding error against the
model calls.

## Change since the previous report

Pass rate 50% to 66.7%. Red team catch 100% to 100%.

Run this before and after any prompt change. A prompt edit that raises the pass
rate while lowering the red team catch rate has made the system worse, and
without this report that trade is invisible.

