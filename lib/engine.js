/**
 * Nebius Academy - Inbound Lead Engine
 * Deterministic engine. Single source of truth.
 *
 * This file is imported directly by the local test harness and inlined verbatim
 * into every n8n Code node by build/build-workflow.mjs. There is no second copy
 * of the scoring rules anywhere, which is the point: when a rep asks why a lead
 * scored 82, one file answers.
 *
 * No LLM is used anywhere in this file. Everything here is auditable.
 */

/* ------------------------------------------------------------------ *
 * 1. MOCK ENRICHMENT TABLE
 * SEAM: production replaces this with Apollo or Clearbit, keyed on the
 * email domain, with a confidence score attached to every field. Records
 * below a confidence floor should route to a cheaper lane rather than be
 * scored on guessed firmographics.
 * ------------------------------------------------------------------ */
export const ENRICHMENT_TABLE = {
  'bancoexample.cl': { company_size: 4200, industry: 'financial_services', revenue_band: '1B+', hq_region: 'LATAM' },
  'playlinegames.se': { company_size: 620, industry: 'gaming', revenue_band: '100M-500M', hq_region: 'EMEA' },
  'northline.ie': { company_size: 18, industry: 'professional_services', revenue_band: '<10M', hq_region: 'EMEA' },
  'corvuslogistics.nl': { company_size: 2800, industry: 'logistics', revenue_band: '500M-1B', hq_region: 'EMEA' },
  'vantagepartners.ie': { company_size: 180, industry: 'professional_services', revenue_band: '10M-100M', hq_region: 'EMEA' },
};

export const INDUSTRY_LABELS = {
  financial_services: 'Financial Services',
  software: 'Software and Technology',
  gaming: 'Gaming',
  telecommunications: 'Telecommunications',
  professional_services: 'Professional Services',
  logistics: 'Logistics',
  other: 'Other',
};

/* Priority industries for Nebius Academy B2B, taken from their named
 * customers: Banco de Chile, inDrive, Playrix, Vention, Exness, NaranjaX. */
export const PRIORITY_INDUSTRIES = [
  'financial_services', 'software', 'gaming',
  'telecommunications', 'professional_services', 'logistics',
];

/* ------------------------------------------------------------------ *
 * 2. BENCHMARK DISTRIBUTION TABLE  (IDEA ONE)
 * Pre-seeded percentile distribution per segment. In production this is a
 * materialised view over completed assessments, recomputed nightly, and n
 * grows on its own. That growth is the whole asset.
 * ------------------------------------------------------------------ */
export const BENCHMARK_TABLE = {
  // exact segments: industry x size band
  financial_services_1000plus: { n: 47, strategy: [30, 46, 62], skills: [28, 44, 61], tooling: [34, 50, 66], governance: [25, 39, 55] },
  software_1000plus:           { n: 63, strategy: [42, 58, 73], skills: [40, 57, 72], tooling: [46, 62, 77], governance: [33, 48, 64] },
  gaming_250_999:              { n: 12, strategy: [33, 50, 66], skills: [35, 52, 68], tooling: [41, 57, 71], governance: [30, 46, 60] },
  logistics_1000plus:          { n: 8,  strategy: [24, 40, 57], skills: [22, 38, 55], tooling: [28, 44, 60], governance: [20, 34, 49] },
  professional_services_50_249:{ n: 15, strategy: [36, 52, 68], skills: [34, 51, 67], tooling: [39, 55, 70], governance: [28, 43, 58] },
  // widened segments: industry only
  financial_services_all:      { n: 96, strategy: [29, 45, 61], skills: [27, 43, 60], tooling: [33, 49, 65], governance: [24, 38, 54] },
  software_all:                { n: 121, strategy: [41, 57, 72], skills: [39, 56, 71], tooling: [45, 61, 76], governance: [32, 47, 63] },
  gaming_all:                  { n: 38, strategy: [34, 51, 67], skills: [36, 53, 69], tooling: [42, 58, 72], governance: [31, 47, 61] },
  logistics_all:               { n: 19, strategy: [25, 41, 58], skills: [23, 39, 56], tooling: [29, 45, 61], governance: [21, 35, 50] },
  professional_services_all:   { n: 41, strategy: [37, 53, 69], skills: [35, 52, 68], tooling: [40, 56, 71], governance: [29, 44, 59] },
};

/** Minimum sample size before the system is allowed to make a comparative claim. */
export const BENCHMARK_MIN_N = 30;

/* ------------------------------------------------------------------ *
 * 3. GUARDRAIL LISTS
 * ------------------------------------------------------------------ */

/** Hard block. Nothing addressed to these ever leaves the system. */
export const PERSONAL_CONTACT_BLOCKLIST = [
  'adam@ofmm.ie',
  'adam@getdatatruth.com',
  'laure.faretti@nebius.com',
];

export const FREE_EMAIL_DOMAINS = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me'];

/** Unsourceable authority claims. Any hit fails the draft outright. */
export const CLAIM_BLOCKLIST = [
  'studies show', 'research indicates', 'research shows', 'data shows',
  '% of companies', '% of organisations', '% of organizations',
  'industry average', 'leading companies', 'most organisations',
  'most organizations', 'most companies', 'companies like yours',
  'our clients typically', 'on average, companies',
];

/** Comparative language, permitted only when a benchmark fact is in the pack. */
export const COMPARATIVE_TERMS = [
  'compared to', 'compared with', 'versus your peers', 'peers', 'peer group',
  'similar companies', 'similar organisations', 'similar organizations',
  'benchmark', 'percentile', 'quartile', 'above average', 'below average',
  'above the median', 'below the median', 'median', 'ahead of', 'behind other',
  'relative to other', 'outperform', 'lag behind',
];

/* ------------------------------------------------------------------ *
 * 4. ENRICHMENT
 * ------------------------------------------------------------------ */

export function emailDomain(email) {
  return String(email || '').split('@')[1]?.toLowerCase() ?? '';
}

/**
 * Seniority from job title.
 * Note the deliberate care around "Executive". In Ireland and the UK a
 * "Marketing Executive" is an individual contributor, not a C-level officer.
 * A naive keyword match on "executive" scores sample lead 3 as C-level and
 * routes an 18 person agency into the HOT lane. This is the kind of bug that
 * makes a sales team stop trusting the score.
 */
export function inferSeniority(jobTitle) {
  const t = String(jobTitle || '').toLowerCase().trim();
  if (/\bchief\b/.test(t) || /^c[teiofmr]{1,2}o\b/.test(t) || /\b(cto|cio|ciso|cmo|ceo|cfo|coo|cdo)\b/.test(t)) return 'C_LEVEL';
  if (/\b(vp|svp|evp|vice president)\b/.test(t)) return 'VP';
  if (/\b(director|head of|head)\b/.test(t)) return 'DIRECTOR';
  if (/\b(manager|lead|principal)\b/.test(t)) return 'MANAGER';
  return 'IC';
}

/**
 * Buyer model. Nebius Academy sells to two different committees and they
 * qualify differently, so they must not share one generic scorer.
 */
export function inferRoleFamily(jobTitle) {
  const t = String(jobTitle || '').toLowerCase();
  if (/\b(learning|l&d|development|talent|people|hr|human resources|enablement|training|academy|capability)\b/.test(t)) return 'LD';
  if (/\b(cto|cio|ciso|engineering|technology|technical|data|ai|ml|platform|architect|devops|infrastructure|software)\b/.test(t)) return 'TECH';
  if (/\b(marketing|operations|ops|strategy|transformation|digital|innovation)\b/.test(t)) return 'ADJACENT';
  return 'OTHER';
}

export function buyerModelFor(roleFamily) {
  if (roleFamily === 'LD') return 'LD';
  if (roleFamily === 'TECH') return 'TECH';
  return 'OTHER';
}

export function sizeBandKey(size) {
  if (size >= 1000) return '1000plus';
  if (size >= 250) return '250_999';
  if (size >= 50) return '50_249';
  return 'under50';
}

export function enrich(payload) {
  const domain = emailDomain(payload.work_email);
  const firmographics = ENRICHMENT_TABLE[domain] || {
    company_size: 0, industry: 'other', revenue_band: 'unknown', hq_region: 'unknown',
  };
  const matched = Boolean(ENRICHMENT_TABLE[domain]);
  const role_family = inferRoleFamily(payload.job_title);
  return {
    ...firmographics,
    email_domain: domain,
    enrichment_matched: matched,
    // SEAM: production attaches a confidence score here and routes low
    // confidence records to a cheaper lane instead of guessing.
    enrichment_confidence: matched ? 1 : 0,
    is_free_email: FREE_EMAIL_DOMAINS.includes(domain),
    seniority: inferSeniority(payload.job_title),
    role_family,
    buyer_model: buyerModelFor(role_family),
    size_band: sizeBandKey(firmographics.company_size),
    industry_label: INDUSTRY_LABELS[firmographics.industry] || 'Other',
  };
}

/* ------------------------------------------------------------------ *
 * 5. FIT SCORING - deterministic, rules based, no LLM
 * ------------------------------------------------------------------ */

const SENIORITY_POINTS = { C_LEVEL: 25, VP: 25, DIRECTOR: 20, MANAGER: 10, IC: 2 };
const ROLE_POINTS = { LD: 20, TECH: 20, ADJACENT: 8, OTHER: 3 };

export function scoreFit(payload, enrichment) {
  const reasons = [];
  const size = enrichment.company_size;
  const overall = payload.assessment.overall_score;

  let sizePts;
  if (size >= 1000) sizePts = 25;
  else if (size >= 250) sizePts = 20;
  else if (size >= 50) sizePts = 10;
  else sizePts = 0;
  reasons.push(`company_size ${size} -> ${sizePts}/25`);

  const seniorityPts = SENIORITY_POINTS[enrichment.seniority] ?? 2;
  reasons.push(`seniority ${enrichment.seniority} -> ${seniorityPts}/25`);

  const rolePts = ROLE_POINTS[enrichment.role_family] ?? 3;
  reasons.push(`role_family ${enrichment.role_family} -> ${rolePts}/20`);

  const industryPts = PRIORITY_INDUSTRIES.includes(enrichment.industry) ? 15 : 7;
  reasons.push(`industry ${enrichment.industry_label} -> ${industryPts}/15`);

  // The inversion. A low readiness score means high need, so it must RAISE
  // fit, not lower it. Scoring this the intuitive way round would push the
  // organisations that most need training to the bottom of the queue.
  let needPts;
  if (overall < 40) needPts = 15;
  else if (overall < 60) needPts = 12;
  else if (overall < 80) needPts = 7;
  else needPts = 2;
  reasons.push(`readiness ${overall} INVERTED (low readiness = high need) -> ${needPts}/15`);

  const components = {
    company_size: sizePts, seniority: seniorityPts, role_family: rolePts,
    industry: industryPts, readiness_need: needPts,
  };
  const fit_score = sizePts + seniorityPts + rolePts + industryPts + needPts;

  let band;
  if (fit_score >= 70) band = 'HOT';
  else if (fit_score >= 40) band = 'MQL';
  else band = 'NEWSLETTER';

  // Override: a junior contact at a tiny company is not a committee, whatever
  // the arithmetic says.
  let override_applied = null;
  if (enrichment.seniority === 'IC' && size < 50) {
    band = 'NEWSLETTER';
    override_applied = 'IC seniority at company under 50 employees, forced to NEWSLETTER';
    reasons.push(`OVERRIDE: ${override_applied}`);
  }

  // Not built, stated for the walkthrough: a lead scoring 85+ on readiness
  // does not need foundational training. Production routes them to
  // certification or Evolve rather than dropping them. Bad fit for one
  // product is a good fit for a different one.
  const advanced_product_flag = overall >= 85;

  return { fit_score, components, reasons, band, override_applied, advanced_product_flag };
}

/* ------------------------------------------------------------------ *
 * 6. SECTION ANALYSIS AND PRODUCT MATCH
 * ------------------------------------------------------------------ */

const PRODUCT_ANGLES = {
  skills:     'AI for Smart Work, capability building',
  governance: 'AI for Managers, decision frameworks and oversight',
  tooling:    'AI Agents and Automation',
  strategy:   'Evolve, executive framing',
};

/**
 * What each programme actually covers, phrased as an assertable fact.
 *
 * The research pack used to hand the drafting agent a recommended_angle while
 * leaving it out of the permitted facts, so an agent that followed its
 * instructions was immediately blocked by the verifier for describing a
 * programme it had been told to describe. Instructions and permissions have to
 * be the same list.
 */
const PRODUCT_ANGLE_FACTS = {
  skills:     'Nebius Academy runs AI for Smart Work, a programme focused on building practical AI capability in day to day work',
  governance: 'Nebius Academy runs AI for Managers, a programme focused on decision frameworks and oversight for managers',
  tooling:    'Nebius Academy runs AI Agents and Automation, a programme focused on applying agents and automation to real workflows',
  strategy:   'Nebius Academy runs Evolve, a programme aimed at executive level AI strategy',
};

export function analyseSections(sections) {
  const entries = Object.entries(sections);
  const sorted = [...entries].sort((a, b) => a[1] - b[1]);
  const [weakest_section, weakest_score] = sorted[0];
  const [strongest_section, strongest_score] = sorted[sorted.length - 1];
  return {
    weakest_section, weakest_score, strongest_section, strongest_score,
    recommended_angle: PRODUCT_ANGLES[weakest_section] || PRODUCT_ANGLES.skills,
    recommended_angle_fact: PRODUCT_ANGLE_FACTS[weakest_section] || PRODUCT_ANGLE_FACTS.skills,
  };
}

/* ------------------------------------------------------------------ *
 * 7. BENCHMARK LOOKUP + CONFIDENCE GATE  (IDEA ONE)
 * ------------------------------------------------------------------ */

/** Percentile position from a p25/p50/p75 distribution, piecewise linear. */
export function percentileFrom(value, [p25, p50, p75]) {
  if (value <= p25) return Math.max(1, Math.round((value / Math.max(p25, 1)) * 25));
  if (value <= p50) return Math.round(25 + ((value - p25) / Math.max(p50 - p25, 1)) * 25);
  if (value <= p75) return Math.round(50 + ((value - p50) / Math.max(p75 - p50, 1)) * 25);
  return Math.min(99, Math.round(75 + ((value - p75) / Math.max(100 - p75, 1)) * 25));
}

export function descriptorFor(percentile) {
  if (percentile <= 25) return 'bottom quartile';
  if (percentile < 50) return 'below the median';
  if (percentile < 75) return 'above the median';
  return 'top quartile';
}

/**
 * Confidence gate.
 *   n >= 30 on the exact segment          -> claim permitted at that granularity
 *   otherwise widen to industry, re-check -> claim permitted at industry level
 *   otherwise                             -> NO comparative claim enters the pack
 *
 * The third branch is the one that matters. The system declines to make a
 * statistical claim it cannot support, and the draft agent is then structurally
 * unable to imply one, because the fact is simply absent from its allow list.
 */
export function benchmarkLookup(sections, enrichment) {
  const trail = [];
  const exactKey = `${enrichment.industry}_${enrichment.size_band}`;
  const widenedKey = `${enrichment.industry}_all`;

  const candidates = [
    { key: exactKey, granularity: 'industry_and_size', row: BENCHMARK_TABLE[exactKey] },
    { key: widenedKey, granularity: 'industry_only', row: BENCHMARK_TABLE[widenedKey] },
  ];

  for (const candidate of candidates) {
    const n = candidate.row?.n ?? 0;
    if (!candidate.row) { trail.push(`${candidate.key}: no rows, widen`); continue; }
    if (n < BENCHMARK_MIN_N) { trail.push(`${candidate.key}: n=${n} below floor of ${BENCHMARK_MIN_N}, widen`); continue; }

    trail.push(`${candidate.key}: n=${n} meets floor of ${BENCHMARK_MIN_N}, claim permitted`);
    const positions = {};
    for (const [section, value] of Object.entries(sections)) {
      const dist = candidate.row[section];
      if (!dist) continue;
      const percentile = percentileFrom(value, dist);
      positions[section] = { value, percentile, descriptor: descriptorFor(percentile), p25: dist[0], p50: dist[1], p75: dist[2] };
    }
    const weakest = analyseSections(sections).weakest_section;
    const w = positions[weakest];
    const cohort = candidate.granularity === 'industry_and_size'
      ? `${enrichment.industry_label.toLowerCase()} organisations ${sizeBandPhrase(enrichment.size_band)}`
      : `${enrichment.industry_label.toLowerCase()} organisations`;

    return {
      benchmark_available: true,
      segment_key: candidate.key,
      granularity: candidate.granularity,
      n,
      positions,
      gate_trail: trail,
      statement: `${weakest} score of ${w.value} is ${w.descriptor} among ${cohort} that have completed this assessment (n=${n})`,
    };
  }

  trail.push('no segment meets the sample floor, benchmark claim withheld, draft falls back to absolute framing');
  return {
    benchmark_available: false,
    segment_key: exactKey,
    granularity: 'none',
    n: BENCHMARK_TABLE[exactKey]?.n ?? 0,
    positions: {},
    gate_trail: trail,
    statement: null,
  };
}

export function sizeBandPhrase(band) {
  return { '1000plus': 'over 1,000 employees', '250_999': 'of 250 to 999 employees', '50_249': 'of 50 to 249 employees', under50: 'under 50 employees' }[band] || '';
}

/* ------------------------------------------------------------------ *
 * 8. COMMITTEE GAP DETECTION  (IDEA TWO)
 * ------------------------------------------------------------------ */

export function committeeGap(buyerModel) {
  if (buyerModel === 'LD') {
    return {
      present_seat: 'LD', missing_seat: 'TECH',
      missing_seat_label: 'technical leadership, CTO or Head of Data',
      note_angle: 'practitioners who run AI in production teaching the material, engineering certification, moving pilots into production',
      assumption: null,
    };
  }
  if (buyerModel === 'TECH') {
    return {
      present_seat: 'TECH', missing_seat: 'LD',
      missing_seat_label: 'learning and development leadership',
      note_angle: 'cohort design, rollout across the stated team size, measurable capability uplift',
      assumption: null,
    };
  }
  return {
    present_seat: 'OTHER', missing_seat: 'LD',
    missing_seat_label: 'learning and development leadership',
    note_angle: 'cohort design, rollout across the stated team size, measurable capability uplift',
    assumption: 'Respondent is neither L&D nor technical leadership. Defaulting the missing seat to L&D because budget for training programmes usually sits there.',
  };
}

/* ------------------------------------------------------------------ *
 * 9. RESEARCH PACK - the allow list
 * The only facts the agent may assert. Everything else is prohibited.
 * This is what makes verification enforceable rather than aspirational.
 * ------------------------------------------------------------------ */

export const PRODUCT_FACTS = [
  'Nebius Academy is the education and research hub of Nebius, an AI cloud company',
  'Programs are taught by practitioners who run AI in production',
  'The offer combines tailored programs, data-driven pre-training assessments and expert-led instruction',
  'Nebius Academy runs role-based certification for engineers in AI cloud skills',
];

export function buildResearchPack(payload, enrichment, sectionAnalysis, benchmark, gap) {
  const a = payload.assessment;
  const allowed_facts = [
    `first_name: ${payload.first_name}`,
    `last_name: ${payload.last_name}`,
    `full_name: ${payload.first_name} ${payload.last_name}`,
    // The premise itself. Without this the verifier can object that nothing
    // establishes an assessment was ever completed, which is true of the list
    // as it stood even though every score on it came from one.
    `${payload.first_name} ${payload.last_name} completed the Nebius Academy AI readiness assessment on ${String(payload.submitted_at).slice(0, 10)}`,
    `company_name: ${payload.company_name}`,
    `job_title: ${payload.job_title}`,
    `industry: ${enrichment.industry_label}`,
    `company_size: ${enrichment.company_size}`,
    `hq_region: ${enrichment.hq_region}`,
    `overall_score: ${a.overall_score}`,
    `weakest_section: ${sectionAnalysis.weakest_section} (${sectionAnalysis.weakest_score})`,
    `strongest_section: ${sectionAnalysis.strongest_section} (${sectionAnalysis.strongest_score})`,
    `team_size_to_upskill: ${a.team_size_to_upskill}`,
    `stated_priority: ${a.stated_priority}`,
  ];
  // The benchmark line only exists when the confidence gate passed.
  if (benchmark.benchmark_available) allowed_facts.push(`benchmark: ${benchmark.statement}`);

  return {
    allowed_facts,
    // The recommended programme joins the permitted facts, because the agent
    // is instructed to lead with it.
    product_facts: [...PRODUCT_FACTS, sectionAnalysis.recommended_angle_fact],
    recommended_angle: sectionAnalysis.recommended_angle,
    benchmark_available: benchmark.benchmark_available,
    missing_seat: gap.missing_seat,
    missing_seat_label: gap.missing_seat_label,
    missing_seat_angle: gap.note_angle,
    // SEAM: production also pulls recent company news, tech stack signals and
    // prior touch history into this pack. Each addition widens what the agent
    // is allowed to say, which is the correct way to make outreach richer.
  };
}

/* ------------------------------------------------------------------ *
 * 10. VERIFICATION GATE, LAYER ONE - deterministic backstop
 * Runs first and runs free. The LLM verifier is layer two.
 * ------------------------------------------------------------------ */

const NUMBER_RE = /\d[\d,]*(?:\.\d+)?%?/g;

function numericTokens(text) {
  return (String(text).match(NUMBER_RE) || []).map((t) => t.replace(/,/g, '').replace(/%$/, ''));
}

/**
 * House style normalisation.
 *
 * An em dash is a style violation, not a truth violation. Treating "used the
 * wrong punctuation" and "invented a statistic" as the same FAIL is a category
 * error: one is auto-fixable and costs nothing, the other must stop the send
 * and fetch a human. The gate separates them.
 */
export function normaliseStyle(text) {
  const fixes = [];
  let out = String(text);
  if (/[—–]/.test(out)) {
    fixes.push('em or en dash replaced with a comma');
    // ", — " and " — " both become a plain comma; a dash between words becomes a comma.
    out = out.replace(/\s*[—–]\s*/g, ', ').replace(/,\s*,/g, ',');
  }
  return { text: out, fixes };
}

/**
 * Numbers the draft is permitted to use.
 *
 * Beyond the literal figures in the allow list, a difference between two
 * permitted section scores is admitted. A model writing "a 16 point gap
 * between tooling at 74 and governance at 58" has done arithmetic on the
 * recipient's own results, not invented a statistic, and blocking it teaches
 * the drafting agent to be vaguer than the facts allow.
 */
export function permittedNumbers(pack) {
  const literal = numericTokens([...pack.allowed_facts, ...pack.product_facts].join(' '));
  const permitted = new Set(literal);
  // Small ordinals and durations are not factual claims about the company, and
  // 100 is the assessment scale. Writing "39/100" states the denominator, it
  // does not assert anything the allow list has to carry.
  ['1', '2', '3', '4', '5', '10', '15', '20', '30', '100'].forEach((n) => permitted.add(n));

  const scores = literal.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 100);
  for (const a of scores) {
    for (const b of scores) {
      const diff = Math.abs(a - b);
      if (diff > 0) permitted.add(String(diff));
    }
  }
  return permitted;
}

/**
 * Layer one of the gate. Returns two lists, deliberately.
 *
 *   blocking  - truth violations. The send stops and a human is fetched.
 *   style     - house style violations. Auto-fixed, logged, send continues.
 *
 * The severity split is the point. A gate that blocks on punctuation trains
 * everyone to override it, and a gate everyone overrides protects nothing.
 */
export function deterministicGate(draft, pack) {
  const blocking = [];
  const style = [];
  const text = `${draft.subject || ''}\n${draft.body || ''}`;
  const haystack = text.toLowerCase();
  const permitted = permittedNumbers(pack);

  for (const token of numericTokens(text)) {
    if (!permitted.has(token)) blocking.push(`orphan number "${token}" is not present in, or derivable from, the permitted facts`);
  }

  for (const phrase of CLAIM_BLOCKLIST) {
    if (haystack.includes(phrase)) blocking.push(`blocklisted authority claim: "${phrase}"`);
  }

  if (!pack.benchmark_available) {
    for (const term of COMPARATIVE_TERMS) {
      if (haystack.includes(term)) {
        blocking.push(`comparative language "${term}" used with no benchmark fact in the pack`);
      }
    }
  }

  if (/[—–]/.test(text)) style.push('em or en dash character present, house style prohibits both');

  return {
    layer: 'deterministic',
    verdict: blocking.length ? 'BLOCK' : 'PASS',
    blocking,
    style,
    // Kept so older callers and the sheet column keep working.
    failures: blocking,
  };
}

/** Hard firewall. Checked before anything is queued for sending. */
export function personalContactFirewall(email) {
  const blocked = PERSONAL_CONTACT_BLOCKLIST.includes(String(email || '').toLowerCase());
  return { blocked, reason: blocked ? 'address is on the personal contacts blocklist' : null };
}

/* ------------------------------------------------------------------ *
 * 11. LANE STATE AND GRADUATION
 * Lanes start manual. Approving a draft unchanged increments a counter.
 * Any edit or rejection resets it to zero. At threshold the lane flips to
 * auto with a one in ten spot check. Trust is earned by measurement rather
 * than granted by configuration.
 * ------------------------------------------------------------------ */

export function laneKey(band, buyerModel) {
  return `${band}_${buyerModel === 'OTHER' ? 'LD' : buyerModel}`;
}

export function resolveLane(laneState, band, buyerModel) {
  const key = laneKey(band, buyerModel);
  const row = laneState[key] || { lane: key, mode: 'manual', consecutive_unchanged: 0, threshold: 20 };
  const spot_check = row.mode === 'auto';
  return {
    lane: key,
    mode: row.mode,
    consecutive_unchanged: row.consecutive_unchanged,
    threshold: row.threshold,
    action_taken: row.mode === 'auto' ? 'sent automatically' : 'queued for human approval',
    spot_check_eligible: spot_check,
  };
}

/* ------------------------------------------------------------------ *
 * 12. FULL DETERMINISTIC PIPELINE
 * Steps 1 to 7 and 12 of the architecture. The LLM legs sit between.
 * ------------------------------------------------------------------ */

export function runDeterministic(payload, laneState = {}) {
  const enrichment = enrich(payload);
  const fit = scoreFit(payload, enrichment);
  const sections = analyseSections(payload.assessment.sections);
  const benchmark = benchmarkLookup(payload.assessment.sections, enrichment);
  const firewall = personalContactFirewall(payload.work_email);

  // NEWSLETTER leads get no individual outreach, so no committee logic, no
  // research pack and no LLM spend. Cost control is a routing decision.
  const drafting_required = fit.band !== 'NEWSLETTER' && !firewall.blocked;
  const gap = drafting_required ? committeeGap(enrichment.buyer_model) : null;
  const pack = drafting_required ? buildResearchPack(payload, enrichment, sections, benchmark, gap) : null;
  const lane = drafting_required ? resolveLane(laneState, fit.band, enrichment.buyer_model) : null;

  return {
    submission_id: payload.submission_id,
    payload, enrichment, fit, sections, benchmark, firewall,
    drafting_required, gap, pack, lane,
    // IDEA THREE: every submission appends its stated priority to the corpus,
    // including NEWSLETTER leads. Demand language is worth capturing from
    // people we will never email.
    demand_corpus_row: {
      submission_id: payload.submission_id,
      timestamp: payload.submitted_at,
      industry: enrichment.industry_label,
      stated_priority: payload.assessment.stated_priority,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 13. MODEL RESPONSE PARSING
 * Lives here rather than in the caller because the n8n Code nodes need it
 * too, and a second copy is how one gets fixed and the other does not.
 * ------------------------------------------------------------------ */

/**
 * Return the first balanced JSON object in a string.
 *
 * Models are asked for bare JSON and mostly comply, but fences appear and
 * occasionally a sentence of preamble arrives first. Stripping a leading fence
 * then greedily matching first-brace-to-last-brace breaks when there is
 * trailing prose containing a brace, because the greedy match swallows the
 * fence markers. This walks the string tracking depth, respecting string
 * literals and escapes.
 */
export function extractJsonObject(text) {
  const raw = String(text);
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = raw.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { start = -1; }
      }
    }
  }
  return null;
}

/** Parse a model response that is supposed to be JSON. Throws with a code. */
export function parseModelJson(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(cleaned); } catch { /* structural scan below */ }
  const found = extractJsonObject(cleaned) ?? extractJsonObject(String(text));
  if (found) return found;
  const err = new Error(`model did not return parseable JSON: ${String(text).slice(0, 200)}`);
  err.code = 'MALFORMED_JSON';
  throw err;
}

/** Pull the text out of an Anthropic Messages API response body. */
export function anthropicText(body) {
  return (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}
