#!/usr/bin/env node
/**
 * Generate the profile contributions chart (light + dark SVG variants).
 *
 * Self-hosted replacement for third-party README stat widgets (which 503 /
 * rate-limit): this script queries the GitHub GraphQL contribution calendar
 * and renders a clean weekly bar chart. A scheduled GitHub Action re-runs it
 * daily and commits the SVGs, so the chart never goes stale and never 404s.
 *
 * Counts follow the profile's "include private contributions" setting, so
 * private work shows up anonymized — volume only, never repo names or code.
 *
 * Usage: GITHUB_TOKEN=<token> node scripts/generate-contributions.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOGIN = 'alexjustino';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('GITHUB_TOKEN is required');
  process.exit(1);
}

// ---------------------------------------------------------------- data fetch

const QUERY = `
  query ($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays { date contributionCount }
          }
        }
      }
    }
  }
`;

const res = await fetch('https://api.github.com/graphql', {
  method: 'POST',
  headers: {
    authorization: `bearer ${TOKEN}`,
    'content-type': 'application/json',
    'user-agent': `${LOGIN}-profile-chart`,
  },
  body: JSON.stringify({ query: QUERY, variables: { login: LOGIN } }),
});
if (!res.ok) {
  console.error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const payload = await res.json();
if (payload.errors) {
  console.error('GraphQL errors:', JSON.stringify(payload.errors));
  process.exit(1);
}

const calendar = payload.data.user.contributionsCollection.contributionCalendar;
const days = calendar.weeks.flatMap((w) => w.contributionDays);
const weeks = calendar.weeks.map((w) => ({
  start: w.contributionDays[0].date,
  total: w.contributionDays.reduce((s, d) => s + d.contributionCount, 0),
}));

// ---------------------------------------------------------------- statistics

const total = calendar.totalContributions;
const bestDay = days.reduce((a, b) => (b.contributionCount > a.contributionCount ? b : a));
const dailyAvg = (total / days.length).toFixed(1);

let longestStreak = 0;
let run = 0;
for (const d of days) {
  run = d.contributionCount > 0 ? run + 1 : 0;
  if (run > longestStreak) longestStreak = run;
}

const maxWeek = weeks.reduce((a, b) => (b.total > a.total ? b : a));
const updated = days[days.length - 1].date; // data date, not wall-clock (stable output)

// ---------------------------------------------------------------- rendering

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Bar with a flat baseline and rounded top corners only (data-end rounding). */
function barPath(x, yTop, w, h, r) {
  if (h <= r) return `M${x},${yTop + h} v${-h + 0.01} h${w} v${h - 0.01} Z`;
  return [
    `M${x},${yTop + h}`,
    `v${-(h - r)}`,
    `q0,${-r} ${r},${-r}`,
    `h${w - 2 * r}`,
    `q${r},0 ${r},${r}`,
    `v${h - r}`,
    'Z',
  ].join(' ');
}

const THEMES = {
  light: {
    // bar color validated on #ffffff (chroma, lightness band, contrast >= 3:1)
    bar: '#0891B2',
    barMuted: 'rgba(8,145,178,0.45)',
    inkPrimary: '#1F2328',
    inkSecondary: '#59636E',
    inkMuted: '#818B98',
    grid: 'rgba(31,35,40,0.14)',
  },
  dark: {
    // bar color validated on #0d1117
    bar: '#0AA2C0',
    barMuted: 'rgba(10,162,192,0.45)',
    inkPrimary: '#E6EDF3',
    inkSecondary: '#9198A1',
    inkMuted: '#6E7681',
    grid: 'rgba(230,237,243,0.14)',
  },
};

function render(theme) {
  const t = THEMES[theme];
  const W = 880;
  const H = 220;
  const PAD = 24;

  const chartTop = 100;
  const chartBottom = 182;
  const chartH = chartBottom - chartTop;
  const chartW = W - PAD * 2;
  const step = chartW / weeks.length;
  const barW = Math.floor(step) - 4; // >= 2px surface gap between bars

  const maxVal = Math.max(1, maxWeek.total);

  const bars = weeks
    .map((w, i) => {
      const h = w.total === 0 ? 0 : Math.max(3, (w.total / maxVal) * chartH);
      const x = PAD + i * step + (step - barW) / 2;
      return w.total === 0
        ? ''
        : `<path d="${barPath(x.toFixed(1), chartBottom - h, barW, h, 3)}" fill="${t.bar}"/>`;
    })
    .join('\n    ');

  // month ticks: label the first week of each new month
  let prevMonth = -1;
  const monthLabels = weeks
    .map((w, i) => {
      const m = new Date(`${w.start}T00:00:00Z`).getUTCMonth();
      if (m === prevMonth) return '';
      prevMonth = m;
      if (i === 0 || i > weeks.length - 3) return ''; // skip cramped edges
      const x = PAD + i * step;
      return `<text x="${x.toFixed(1)}" y="${chartBottom + 18}" class="muted">${MONTHS[m]}</text>`;
    })
    .join('\n    ');

  // selective direct label: peak week only
  const maxIdx = weeks.findIndex((w) => w.total === maxWeek.total);
  const maxX = PAD + maxIdx * step + step / 2;
  const maxH = Math.max(3, (maxWeek.total / maxVal) * chartH);
  const peakAnchor = maxIdx > weeks.length - 6 ? 'end' : maxIdx < 5 ? 'start' : 'middle';

  const stats = [
    { v: String(bestDay.contributionCount), l: 'best day' },
    { v: dailyAvg, l: 'daily avg' },
    { v: `${longestStreak}d`, l: 'longest streak' },
  ];
  const statBlocks = stats
    .map(
      (s, i) => `
    <g transform="translate(${W - PAD - (stats.length - i) * 118},34)">
      <text class="stat-v" text-anchor="end" x="98">${s.v}</text>
      <text class="stat-l" text-anchor="end" x="98" y="20">${s.l}</text>
    </g>`,
    )
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${total} contributions in the last year">
  <title>${total} contributions in the last year</title>
  <style>
    text { font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; }
    .hero  { font: 700 44px ui-monospace, 'SFMono-Regular', Consolas, monospace; fill: ${t.bar}; }
    .hero-l { font-size: 14px; fill: ${t.inkSecondary}; }
    .stat-v { font: 600 20px ui-monospace, 'SFMono-Regular', Consolas, monospace; fill: ${t.inkPrimary}; }
    .stat-l { font-size: 11px; fill: ${t.inkMuted}; }
    .muted { font-size: 10px; fill: ${t.inkMuted}; }
    .peak  { font: 600 11px ui-monospace, 'SFMono-Regular', Consolas, monospace; fill: ${t.inkPrimary}; }
  </style>
  <g>
    <animate attributeName="opacity" from="0" to="1" dur="0.6s" fill="freeze"/>
    <text class="hero" x="${PAD}" y="56">${total.toLocaleString('en-US')}</text>
    <text class="hero-l" x="${PAD}" y="78">contributions in the last year · public + anonymized private</text>
    ${statBlocks}
    <line x1="${PAD}" y1="${chartBottom}" x2="${W - PAD}" y2="${chartBottom}" stroke="${t.grid}" stroke-width="1"/>
    ${bars}
    <text class="peak" x="${maxX.toFixed(1)}" y="${chartBottom - maxH - 6}" text-anchor="${peakAnchor}">${maxWeek.total}</text>
    ${monthLabels}
    <text class="muted" x="${W - PAD}" y="78" text-anchor="end">weekly totals · auto-updated · ${updated}</text>
  </g>
</svg>
`;
}

// ---------------------------------------------------------------- write out

mkdirSync(join(ROOT, 'assets'), { recursive: true });
for (const theme of ['light', 'dark']) {
  const file = join(ROOT, 'assets', `contributions-${theme}.svg`);
  writeFileSync(file, render(theme), 'utf8');
  console.log(`wrote ${file}`);
}
console.log(`total=${total} bestDay=${bestDay.contributionCount} avg=${dailyAvg} streak=${longestStreak}`);
