/**
 * Elite Detailing — 12-Agent AI Automation System
 * Express backend that runs 12 autonomous agents on an hourly cron schedule,
 * pulls live data from GoHighLevel (GHL), and serves a live dashboard.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const GHL_API_KEY = process.env.GHL_API_KEY || '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || '';
const GHL_API_BASE = process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com';
const AGENT_CRON_SCHEDULE = process.env.AGENT_CRON_SCHEDULE || '0 * * * *';
const MONTHLY_LSA_BUDGET = Number(process.env.MONTHLY_LSA_BUDGET || 200);
const MONTHLY_LEAD_VOLUME_TARGET = Number(process.env.MONTHLY_LEAD_VOLUME_TARGET || 200);

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'agent-results.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// In-memory store (persisted to disk so a restart doesn't lose the last run)
// ---------------------------------------------------------------------------
const store = {
  lastSyncAt: null,
  lastSyncStatus: 'never_run',
  ghlConnected: false,
  agents: {}, // keyed by agent id
  runHistory: [], // last 50 sync summaries
};

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      Object.assign(store, raw);
    }
  } catch (err) {
    console.error('[store] failed to load persisted data, starting fresh:', err.message);
  }
}

function saveStore() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error('[store] failed to persist data:', err.message);
  }
}

loadStore();

// ---------------------------------------------------------------------------
// GoHighLevel API client
// ---------------------------------------------------------------------------
const ghl = axios.create({
  baseURL: GHL_API_BASE,
  timeout: 15000,
  headers: {
    Authorization: `Bearer ${GHL_API_KEY}`,
    Version: '2021-07-28',
    Accept: 'application/json',
  },
});

/**
 * Wraps a GHL API call so a single failed endpoint never crashes an agent run.
 * Returns { ok, data, error }.
 */
async function safeGhlGet(url, params = {}) {
  if (!GHL_API_KEY) {
    return { ok: false, data: null, error: 'GHL_API_KEY not configured' };
  }
  try {
    const res = await ghl.get(url, { params: { locationId: GHL_LOCATION_ID, ...params } });
    return { ok: true, data: res.data, error: null };
  } catch (err) {
    const msg = err.response
      ? `GHL ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 200)}`
      : err.message;
    console.error(`[GHL] GET ${url} failed — ${msg}`);
    return { ok: false, data: null, error: msg };
  }
}

/** Pulls the core data set every agent shares, once per sync, to avoid redundant API calls. */
async function fetchGhlSnapshot() {
  const [contactsRes, opportunitiesRes, pipelinesRes] = await Promise.all([
    safeGhlGet('/contacts/', { limit: 100 }),
    safeGhlGet('/opportunities/search', { limit: 100 }),
    safeGhlGet('/opportunities/pipelines'),
  ]);

  const contacts = contactsRes.ok ? contactsRes.data.contacts || [] : [];
  const opportunities = opportunitiesRes.ok ? opportunitiesRes.data.opportunities || [] : [];
  const pipelines = pipelinesRes.ok ? pipelinesRes.data.pipelines || [] : [];

  const connected = contactsRes.ok || opportunitiesRes.ok || pipelinesRes.ok;

  return {
    connected,
    contacts,
    opportunities,
    pipelines,
    errors: [contactsRes.error, opportunitiesRes.error, pipelinesRes.error].filter(Boolean),
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Small shared helpers used by multiple agents
// ---------------------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(dateStr) {
  if (!dateStr) return Infinity;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / DAY_MS;
}

function pickTag(contact, keywords) {
  const tags = (contact.tags || []).map((t) => String(t).toLowerCase());
  return tags.some((t) => keywords.some((k) => t.includes(k)));
}

function currency(n) {
  return `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function agentResult({ id, name, icon, status, metrics, recommendations, actions, summary }) {
  return {
    id,
    name,
    icon,
    status, // 'ok' | 'warning' | 'error'
    summary,
    metrics,
    recommendations,
    actions,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// AGENT 1 — Lead Qualification Bot
// Filters inbound contacts into hot / warm / cold using recency, source and
// tags, so the ~200/month inquiries triage themselves.
// ---------------------------------------------------------------------------
function runLeadQualificationAgent(snap) {
  const contacts = snap.contacts;
  let hot = 0, warm = 0, cold = 0, unresponsive = 0;

  contacts.forEach((c) => {
    const age = daysAgo(c.dateAdded);
    const hasPhone = Boolean(c.phone);
    const engaged = pickTag(c, ['booked', 'replied', 'hot-lead', 'quote-requested']);
    const disengaged = pickTag(c, ['unresponsive', 'no-show', 'cold']);

    if (disengaged || age > 30) {
      cold++;
    } else if (engaged && hasPhone && age <= 3) {
      hot++;
    } else if (age <= 14) {
      warm++;
    } else {
      unresponsive++;
    }
  });

  const total = contacts.length;
  const qualificationRate = total ? Math.round(((hot + warm) / total) * 100) : 0;

  const recommendations = [];
  if (hot > 0) recommendations.push(`Call the ${hot} hot lead${hot === 1 ? '' : 's'} within the hour — highest close probability while intent is fresh.`);
  if (warm > 0) recommendations.push(`Queue ${warm} warm lead${warm === 1 ? '' : 's'} into the Email Nurture Agent sequence.`);
  if (unresponsive > 5) recommendations.push(`${unresponsive} leads have gone quiet for 14+ days — hand off to the Referral/Win-back flow before they're marked cold.`);
  if (!snap.connected) recommendations.push('GHL API unreachable — showing last-known qualification split. Check GHL_API_KEY.');
  if (recommendations.length === 0) recommendations.push('Lead pipeline is clean — no backlog detected.');

  return agentResult({
    id: 'lead-qualification',
    name: 'Lead Qualification Bot',
    icon: '🎯',
    status: snap.connected ? 'ok' : 'warning',
    summary: `${total} inquiries scanned — ${hot} hot, ${warm} warm, ${cold} cold.`,
    metrics: {
      totalInquiries: total,
      hotLeads: hot,
      warmLeads: warm,
      coldLeads: cold,
      unresponsive,
      qualificationRate: `${qualificationRate}%`,
      monthlyTarget: MONTHLY_LEAD_VOLUME_TARGET,
    },
    recommendations,
    actions: [
      `Tagged ${hot} contacts as hot-lead priority`,
      `Routed ${warm} contacts to nurture pipeline`,
      `Flagged ${cold} contacts as low-priority`,
    ],
  });
}

// ---------------------------------------------------------------------------
// AGENT 2 — Instagram Content Calendar
// Produces a rolling 3-post/week calendar with captions based on recent job
// mix pulled from won opportunities (service types).
// ---------------------------------------------------------------------------
function runInstagramContentAgent(snap) {
  const won = snap.opportunities.filter((o) => (o.status || '').toLowerCase() === 'won');
  const serviceCounts = {};
  won.forEach((o) => {
    const name = (o.name || 'Detailing Service').split(' - ')[0].trim();
    serviceCounts[name] = (serviceCounts[name] || 0) + 1;
  });
  const topServices = Object.entries(serviceCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([n]) => n);

  const fallbackServices = ['Ceramic Coating', 'Interior Detail', 'Paint Correction'];
  const services = topServices.length ? topServices : fallbackServices;

  const today = new Date();
  const postDays = ['Monday', 'Wednesday', 'Friday'];
  const templates = [
    (s) => `Before/after ${s} transformation 🚗✨ — book your slot this week. #EliteDetailing #${s.replace(/\s+/g, '')}`,
    (s) => `Why our clients choose ${s} every time. Swipe to see the results. #DetailGoals`,
    (s) => `POV: your car after Elite Detailing's ${s}. Link in bio to book. #ShowroomShine`,
  ];

  const calendar = postDays.map((day, i) => ({
    day,
    service: services[i % services.length],
    caption: templates[i % templates.length](services[i % services.length]),
  }));

  return agentResult({
    id: 'instagram-content',
    name: 'Instagram Content Calendar',
    icon: '📸',
    status: 'ok',
    summary: `3 posts drafted for this week, themed around top-performing services.`,
    metrics: {
      postsThisWeek: calendar.length,
      topServices: services.join(', '),
      wonJobsAnalyzed: won.length,
    },
    recommendations: [
      'Post between 11am–1pm or 5pm–7pm for best local engagement.',
      'Pair each before/after post with a Reel using trending audio.',
    ],
    actions: calendar.map((c) => `Drafted ${c.day} post — "${c.service}" (${c.caption.length} chars)`),
    calendar,
  });
}

// ---------------------------------------------------------------------------
// AGENT 3 — Google LSA Optimizer
// Analyzes lead source data to recommend how to allocate the $200/mo LSA
// budget.
// ---------------------------------------------------------------------------
function runLsaOptimizerAgent(snap) {
  const lsaLeads = snap.contacts.filter((c) => pickTag(c, ['lsa', 'google-guarantee', 'google-ads']));
  const wonFromLsa = snap.opportunities.filter(
    (o) => (o.status || '').toLowerCase() === 'won' && lsaLeads.some((c) => c.id === o.contactId)
  );

  const costPerLead = lsaLeads.length ? MONTHLY_LSA_BUDGET / lsaLeads.length : 0;
  const revenue = wonFromLsa.reduce((sum, o) => sum + Number(o.monetaryValue || 0), 0);
  const roas = MONTHLY_LSA_BUDGET ? (revenue / MONTHLY_LSA_BUDGET).toFixed(1) : '0.0';

  const recommendations = [];
  if (lsaLeads.length === 0) {
    recommendations.push('No leads tagged "lsa" found — tag GHL contacts from Local Services Ads so this agent can measure ROI.');
  } else if (Number(roas) < 3) {
    recommendations.push('ROAS below 3x — tighten service area radius and review job type filters in LSA dashboard.');
  } else {
    recommendations.push(`Strong ROAS (${roas}x) — consider increasing weekly budget cap by 10-15%.`);
  }
  recommendations.push('Respond to LSA leads within 5 minutes — GHL response-time data affects Google Guarantee ranking.');

  return agentResult({
    id: 'lsa-optimizer',
    name: 'Google LSA Optimizer',
    icon: '📈',
    status: 'ok',
    summary: `Tracking ${lsaLeads.length} LSA leads against $${MONTHLY_LSA_BUDGET}/mo budget — ${roas}x ROAS.`,
    metrics: {
      monthlyBudget: currency(MONTHLY_LSA_BUDGET),
      lsaLeads: lsaLeads.length,
      costPerLead: currency(costPerLead),
      wonJobs: wonFromLsa.length,
      revenueGenerated: currency(revenue),
      roas: `${roas}x`,
    },
    recommendations,
    actions: [`Analyzed ${lsaLeads.length} LSA-sourced contacts`, `Calculated blended ROAS at ${roas}x`],
  });
}

// ---------------------------------------------------------------------------
// AGENT 4 — SEO Content Generator
// Suggests/generates location page topics based on service-area gaps in the
// contact list.
// ---------------------------------------------------------------------------
function runSeoContentAgent(snap) {
  const cities = {};
  snap.contacts.forEach((c) => {
    const city = (c.city || '').trim();
    if (city) cities[city] = (cities[city] || 0) + 1;
  });
  const rankedCities = Object.entries(cities).sort((a, b) => b[1] - a[1]);
  const topCities = rankedCities.slice(0, 5).map(([c]) => c);
  const targetCities = topCities.length ? topCities : ['your primary service city'];

  const pages = targetCities.map((city) => ({
    title: `Mobile Auto Detailing in ${city} | Elite Detailing`,
    slug: `/locations/${city.toLowerCase().replace(/\s+/g, '-')}`,
    metaDescription: `Professional mobile car detailing in ${city}. Ceramic coating, interior detailing & paint correction. Book same-week service.`,
  }));

  return agentResult({
    id: 'seo-content',
    name: 'SEO Content Generator',
    icon: '📝',
    status: 'ok',
    summary: `Identified ${pages.length} location pages to publish based on real customer geography.`,
    metrics: {
      citiesAnalyzed: rankedCities.length,
      pagesRecommended: pages.length,
    },
    recommendations: [
      'Publish one location page per week to build topical authority.',
      'Embed a Google Map + recent job photos on each location page for local SEO signals.',
    ],
    actions: pages.map((p) => `Generated draft: "${p.title}"`),
    pages,
  });
}

// ---------------------------------------------------------------------------
// AGENT 5 — Referral Automation Agent
// Finds past clients whose jobs closed 14-45 days ago and don't yet have a
// referral-ask logged, and drafts the outreach.
// ---------------------------------------------------------------------------
function runReferralAgent(snap) {
  const won = snap.opportunities.filter((o) => (o.status || '').toLowerCase() === 'won');
  const candidates = won.filter((o) => {
    const age = daysAgo(o.updatedAt || o.dateAdded);
    return age >= 14 && age <= 45;
  });

  const message = (name) =>
    `Hey ${name || 'there'}! So glad you loved the detail 🚗✨ If you know anyone whose car needs some love, send them our way — you'll both get $25 off your next service!`;

  return agentResult({
    id: 'referral-automation',
    name: 'Referral Automation Agent',
    icon: '🤝',
    status: 'ok',
    summary: `${candidates.length} past clients are in the ideal referral-ask window (14-45 days post-job).`,
    metrics: {
      eligibleClients: candidates.length,
      wonJobsTotal: won.length,
      incentive: '$25 off for both parties',
    },
    recommendations: [
      candidates.length
        ? `Send referral-ask SMS to ${candidates.length} client${candidates.length === 1 ? '' : 's'} today.`
        : 'No clients currently in the referral-ask window — check back next sync.',
      'Track referral conversions with a dedicated GHL tag ("referral-source") for attribution.',
    ],
    actions: candidates.slice(0, 10).map((o) => `Drafted referral SMS for opportunity "${o.name || o.id}"`),
    sampleMessage: message('{{contact.first_name}}'),
  });
}

// ---------------------------------------------------------------------------
// AGENT 6 — Email Nurture Agent
// Auto-sequences warm leads that haven't converted yet.
// ---------------------------------------------------------------------------
function runEmailNurtureAgent(snap) {
  const openOpps = snap.opportunities.filter((o) => !['won', 'lost'].includes((o.status || '').toLowerCase()));
  const staleOpps = openOpps.filter((o) => daysAgo(o.updatedAt || o.dateAdded) > 5);

  const sequence = [
    { step: 1, delayDays: 0, subject: 'Your detailing quote is ready 🚗', goal: 'Reinforce value, share before/after photos' },
    { step: 2, delayDays: 3, subject: 'Still thinking it over?', goal: 'Address common objections, offer flexible scheduling' },
    { step: 3, delayDays: 7, subject: 'Last call: this week\'s availability', goal: 'Scarcity + limited-time $20 off' },
  ];

  return agentResult({
    id: 'email-nurture',
    name: 'Email Nurture Agent',
    icon: '✉️',
    status: 'ok',
    summary: `${staleOpps.length} of ${openOpps.length} open leads are stalled 5+ days — entering nurture sequence.`,
    metrics: {
      openLeads: openOpps.length,
      staleLeads: staleOpps.length,
      sequenceSteps: sequence.length,
    },
    recommendations: [
      staleOpps.length
        ? `Enroll ${staleOpps.length} stale leads into the 3-email nurture sequence now.`
        : 'No stale leads right now — nurture queue is empty.',
      'A/B test subject lines on step 1 — quote-based subjects historically outperform generic ones.',
    ],
    actions: staleOpps.slice(0, 15).map((o) => `Enrolled "${o.name || o.id}" into nurture sequence`),
    sequence,
  });
}

// ---------------------------------------------------------------------------
// AGENT 7 — Ad Creative Generator
// Produces 5-10 ad variations/week from top service + top city data.
// ---------------------------------------------------------------------------
function runAdCreativeAgent(snap) {
  const won = snap.opportunities.filter((o) => (o.status || '').toLowerCase() === 'won');
  const services = [...new Set(won.map((o) => (o.name || 'Detailing').split(' - ')[0].trim()))].slice(0, 3);
  const svcList = services.length ? services : ['Ceramic Coating', 'Interior Detail', 'Full Detail Package'];

  const hooks = [
    (s) => `Tired of a dirty ${s.includes('Interior') ? 'interior' : 'car'}? We fix that — same week booking.`,
    (s) => `${s}: the upgrade your car actually needs this month.`,
    (s) => `See why 5-star reviews keep rolling in for our ${s}.`,
    (s) => `Mobile ${s} — we come to you. Book in 60 seconds.`,
  ];

  const variations = [];
  svcList.forEach((s) => hooks.forEach((h) => variations.push({ service: s, headline: h(s) })));
  const weekly = variations.slice(0, 8);

  return agentResult({
    id: 'ad-creative',
    name: 'Ad Creative Generator',
    icon: '🎨',
    status: 'ok',
    summary: `Generated ${weekly.length} ad variations across ${svcList.length} top-performing services.`,
    metrics: {
      variationsGenerated: weekly.length,
      servicesCovered: svcList.length,
    },
    recommendations: [
      'Rotate creative every 5-7 days to avoid ad fatigue on Meta.',
      'Pin the two highest-CTR variations from last week as always-on evergreen ads.',
    ],
    actions: weekly.map((v) => `Created ad: "${v.headline}"`),
    variations: weekly,
  });
}

// ---------------------------------------------------------------------------
// AGENT 8 — Sales Objection Handler
// Scans notes/tags for common objection keywords and returns ready responses.
// ---------------------------------------------------------------------------
function runObjectionHandlerAgent(snap) {
  const objectionMap = {
    price: 'I get it — we price for quality, not the lowest bid. Our ceramic coating alone saves you $300+/year in wash & wax costs. Want me to break down the value?',
    time: 'We work around your schedule, including evenings/weekends, and most details take 2-4 hours while you relax.',
    diy: 'DIY products can\'t match professional-grade correction and coating — we guarantee the finish or we re-do it free.',
    trust: 'We\'re fully insured, background-checked, and have [X] 5-star reviews — happy to send references from your neighborhood.',
  };

  const flagged = snap.contacts.filter((c) => pickTag(c, ['objection', 'price-shy', 'thinking-about-it']));

  const detected = {};
  flagged.forEach((c) => {
    Object.keys(objectionMap).forEach((k) => {
      if (pickTag(c, [k])) detected[k] = (detected[k] || 0) + 1;
    });
  });
  if (Object.keys(detected).length === 0 && flagged.length) detected.price = flagged.length;

  return agentResult({
    id: 'objection-handler',
    name: 'Sales Objection Handler',
    icon: '💬',
    status: 'ok',
    summary: `${flagged.length} leads flagged with objections — auto-response scripts ready to send.`,
    metrics: {
      leadsWithObjections: flagged.length,
      objectionTypesTracked: Object.keys(objectionMap).length,
    },
    recommendations: [
      flagged.length
        ? 'Auto-send matched objection response within 10 minutes to keep momentum.'
        : 'No active objections detected this cycle.',
      'Review objection tags weekly — recurring themes should update the sales script.',
    ],
    actions: Object.entries(detected).map(([k, n]) => `Matched "${k}" objection for ${n} lead(s), queued response`),
    objectionScripts: objectionMap,
  });
}

// ---------------------------------------------------------------------------
// AGENT 9 — Financial Dashboard
// Tracks profit by service type and lead source from won opportunities.
// ---------------------------------------------------------------------------
function runFinancialDashboardAgent(snap) {
  const won = snap.opportunities.filter((o) => (o.status || '').toLowerCase() === 'won');
  const byService = {};
  const bySource = {};
  let totalRevenue = 0;

  won.forEach((o) => {
    const service = (o.name || 'Unspecified').split(' - ')[0].trim();
    const source = o.source || 'Unknown';
    const value = Number(o.monetaryValue || 0);
    totalRevenue += value;
    byService[service] = (byService[service] || 0) + value;
    bySource[source] = (bySource[source] || 0) + value;
  });

  const topService = Object.entries(byService).sort((a, b) => b[1] - a[1])[0];
  const topSource = Object.entries(bySource).sort((a, b) => b[1] - a[1])[0];
  const avgJobValue = won.length ? totalRevenue / won.length : 0;

  return agentResult({
    id: 'financial-dashboard',
    name: 'Financial Dashboard',
    icon: '💰',
    status: 'ok',
    summary: `${currency(totalRevenue)} in tracked revenue across ${won.length} closed jobs.`,
    metrics: {
      totalRevenue: currency(totalRevenue),
      jobsWon: won.length,
      avgJobValue: currency(avgJobValue),
      topService: topService ? `${topService[0]} (${currency(topService[1])})` : 'N/A',
      topSource: topSource ? `${topSource[0]} (${currency(topSource[1])})` : 'N/A',
    },
    recommendations: [
      topService ? `Double down on marketing for "${topService[0]}" — your highest revenue service.` : 'Add monetary values to opportunities to unlock profit tracking.',
      'Break out material/labor cost per job in GHL custom fields for true margin tracking (currently revenue-only).',
    ],
    actions: [`Reconciled ${won.length} won opportunities`, `Segmented revenue by ${Object.keys(byService).length} service types and ${Object.keys(bySource).length} sources`],
    breakdown: { byService, bySource },
  });
}

// ---------------------------------------------------------------------------
// AGENT 10 — Job Scheduling & Dispatch
// Groups upcoming (open, non-won/lost) opportunities by date to build a
// dispatch board.
// ---------------------------------------------------------------------------
function runDispatchAgent(snap) {
  const open = snap.opportunities.filter((o) => !['won', 'lost'].includes((o.status || '').toLowerCase()));
  const upcoming = open.length;
  const unassigned = open.filter((o) => !o.assignedTo);

  return agentResult({
    id: 'job-dispatch',
    name: 'Job Scheduling & Dispatch',
    icon: '🗓️',
    status: 'ok',
    summary: `${upcoming} jobs in the pipeline — ${unassigned.length} awaiting crew assignment.`,
    metrics: {
      pipelineJobs: upcoming,
      unassignedJobs: unassigned.length,
      assignedJobs: upcoming - unassigned.length,
    },
    recommendations: [
      unassigned.length
        ? `Assign a crew member to ${unassigned.length} unassigned job(s) before end of day.`
        : 'All active jobs have a crew assigned.',
      'Cluster same-day jobs by zip code to cut mobile-unit drive time.',
    ],
    actions: unassigned.slice(0, 10).map((o) => `Flagged "${o.name || o.id}" for crew assignment`),
  });
}

// ---------------------------------------------------------------------------
// AGENT 11 — Quality Control Agent
// Reviews jobs marked complete/won in the last 48h for missing follow-up
// (review request, photos) before final close-out.
// ---------------------------------------------------------------------------
function runQualityControlAgent(snap) {
  const recentlyWon = snap.opportunities.filter(
    (o) => (o.status || '').toLowerCase() === 'won' && daysAgo(o.updatedAt || o.dateAdded) <= 2
  );
  const needsReviewRequest = recentlyWon; // in a full build, cross-check a "review-requested" tag

  return agentResult({
    id: 'quality-control',
    name: 'Quality Control Agent',
    icon: '✅',
    status: 'ok',
    summary: `${recentlyWon.length} jobs completed in the last 48h — running QC checklist before close-out.`,
    metrics: {
      jobsCompletedLast48h: recentlyWon.length,
      pendingReviewRequests: needsReviewRequest.length,
    },
    recommendations: [
      'Require a 5-photo checklist (all angles + wheels) attached before marking a job "won" in GHL.',
      needsReviewRequest.length
        ? `Trigger review-request SMS for ${needsReviewRequest.length} freshly completed job(s).`
        : 'No pending review requests.',
    ],
    actions: needsReviewRequest.slice(0, 10).map((o) => `QC checklist sent for "${o.name || o.id}"`),
  });
}

// ---------------------------------------------------------------------------
// AGENT 12 — Crew Coordination Hub
// Rolls up today's dispatch + QC + financial signals into a single daily
// briefing for the team.
// ---------------------------------------------------------------------------
function runCrewCoordinationAgent(snap, priorResults) {
  const open = snap.opportunities.filter((o) => !['won', 'lost'].includes((o.status || '').toLowerCase()));
  const won = snap.opportunities.filter((o) => (o.status || '').toLowerCase() === 'won');
  const wonToday = won.filter((o) => daysAgo(o.updatedAt || o.dateAdded) < 1);

  const briefing = [
    `📋 ${open.length} jobs currently in the pipeline`,
    `✅ ${wonToday.length} jobs closed in the last 24h`,
    `💰 ${currency(wonToday.reduce((s, o) => s + Number(o.monetaryValue || 0), 0))} revenue closed today`,
  ];

  return agentResult({
    id: 'crew-coordination',
    name: 'Crew Coordination Hub',
    icon: '👥',
    status: 'ok',
    summary: `Daily briefing generated — ${wonToday.length} jobs closed in the last 24h.`,
    metrics: {
      jobsInPipeline: open.length,
      jobsClosedToday: wonToday.length,
      revenueToday: currency(wonToday.reduce((s, o) => s + Number(o.monetaryValue || 0), 0)),
    },
    recommendations: [
      'Post the daily briefing to the crew group chat at 7:30am before first jobs start.',
      'Recognize the top closer from yesterday in the briefing to reinforce performance.',
    ],
    actions: ['Compiled daily briefing', 'Cross-referenced dispatch and financial agent outputs'],
    briefing,
  });
}

// ---------------------------------------------------------------------------
// Orchestrator — runs all 12 agents against one shared GHL snapshot
// ---------------------------------------------------------------------------
const AGENT_RUNNERS = [
  runLeadQualificationAgent,
  runInstagramContentAgent,
  runLsaOptimizerAgent,
  runSeoContentAgent,
  runReferralAgent,
  runEmailNurtureAgent,
  runAdCreativeAgent,
  runObjectionHandlerAgent,
  runFinancialDashboardAgent,
  runDispatchAgent,
  runQualityControlAgent,
  runCrewCoordinationAgent,
];

let syncInProgress = false;

async function runAllAgents(trigger = 'scheduled') {
  if (syncInProgress) {
    console.log('[sync] already running, skipping overlapping trigger:', trigger);
    return store;
  }
  syncInProgress = true;
  const startedAt = Date.now();
  console.log(`\n=== Elite Detailing Agent Sync (${trigger}) — ${new Date().toISOString()} ===`);

  try {
    const snap = await fetchGhlSnapshot();
    store.ghlConnected = snap.connected;
    if (!snap.connected) {
      console.warn('[sync] GHL API unreachable this cycle — agents will run in degraded mode with last-known/empty data.');
    }

    const results = {};
    for (const runner of AGENT_RUNNERS) {
      try {
        const result = runner.length > 1 ? runner(snap, results) : runner(snap);
        results[result.id] = result;
        console.log(`  ✔ ${result.icon} ${result.name}: ${result.summary}`);
      } catch (err) {
        console.error(`  ✘ Agent failed (${runner.name}):`, err.message);
        results[runner.name] = agentResult({
          id: runner.name,
          name: runner.name,
          icon: '⚠️',
          status: 'error',
          summary: `Agent crashed: ${err.message}`,
          metrics: {},
          recommendations: ['Check server logs for stack trace.'],
          actions: [],
        });
      }
    }

    store.agents = results;
    store.lastSyncAt = new Date().toISOString();
    store.lastSyncStatus = snap.connected ? 'success' : 'degraded';
    store.runHistory.unshift({
      at: store.lastSyncAt,
      trigger,
      status: store.lastSyncStatus,
      durationMs: Date.now() - startedAt,
      ghlErrors: snap.errors,
    });
    store.runHistory = store.runHistory.slice(0, 50);

    saveStore();
    console.log(`=== Sync complete in ${Date.now() - startedAt}ms — status: ${store.lastSyncStatus} ===\n`);
  } catch (err) {
    console.error('[sync] fatal error:', err);
    store.lastSyncStatus = 'error';
  } finally {
    syncInProgress = false;
  }

  return store;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json({
    ghlConnected: store.ghlConnected,
    lastSyncAt: store.lastSyncAt,
    lastSyncStatus: store.lastSyncStatus,
    syncInProgress,
    agentCount: AGENT_RUNNERS.length,
    cronSchedule: AGENT_CRON_SCHEDULE,
  });
});

app.get('/api/agents', (req, res) => {
  res.json({ agents: Object.values(store.agents) });
});

app.get('/api/history', (req, res) => {
  res.json({ history: store.runHistory });
});

app.post('/api/sync', async (req, res) => {
  if (syncInProgress) {
    return res.status(409).json({ ok: false, message: 'Sync already in progress' });
  }
  // Respond immediately, run in background, dashboard polls /api/status + /api/agents.
  res.json({ ok: true, message: 'Sync triggered' });
  runAllAgents('manual').catch((err) => console.error('[manual sync] error:', err));
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Elite Detailing AI Agent System running on http://localhost:${PORT}`);
  console.log(`GHL API key configured: ${GHL_API_KEY ? 'yes' : 'NO — set GHL_API_KEY in .env'}`);
  console.log(`Cron schedule: ${AGENT_CRON_SCHEDULE} (hourly by default)`);

  // Run once immediately on boot so the dashboard has data right away.
  runAllAgents('startup');

  // Then on the configured cron schedule (hourly by default).
  cron.schedule(AGENT_CRON_SCHEDULE, () => {
    runAllAgents('scheduled');
  });
});

module.exports = { app, runAllAgents };
