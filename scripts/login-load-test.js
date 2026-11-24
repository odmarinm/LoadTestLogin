// Load test for the FakeStore API login service.
// Run from the repository root:  k6 run scripts/login-load-test.js

import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';

// ---------------------------------------------------------------------------
// Configuration (overridable with -e KEY=value)
// ---------------------------------------------------------------------------
const BASE_URL = __ENV.BASE_URL || 'https://fakestoreapi.com';
const TARGET_TPS = Number(__ENV.TARGET_TPS || 20);       // requests per second to sustain
const HOLD_DURATION = __ENV.HOLD_DURATION || '2m';       // time at TARGET_TPS
const MAX_RESPONSE_MS = 1500;                            // max allowed response time
const MAX_ERROR_RATE = 0.03;                             // < 3% errors allowed

// ---------------------------------------------------------------------------
// Test data: credentials loaded once from CSV and shared across all VUs
// ---------------------------------------------------------------------------
const users = new SharedArray('users', () => {
  const lines = open('../data/users.csv')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const [header, ...rows] = lines;
  const cols = header.split(',');
  const userIdx = cols.indexOf('user');
  const passIdx = cols.indexOf('passwd');

  return rows.map((row) => {
    const values = row.split(',');
    return { username: values[userIdx], password: values[passIdx] };
  });
});

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------
const loginErrors = new Rate('login_errors');          // functional error rate
const loginDuration = new Trend('login_duration', true);

// ---------------------------------------------------------------------------
// Scenario + thresholds
// ---------------------------------------------------------------------------
export const options = {
  scenarios: {
    login_load: {
      // Open model: k6 starts iterations at a fixed rate regardless of
      // response time, so 1 iteration = 1 request = 1 transaction.
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: 30,
      maxVUs: 100,
      stages: [
        { target: TARGET_TPS, duration: '30s' },   // ramp-up
        { target: TARGET_TPS, duration: HOLD_DURATION }, // steady state
        { target: 0, duration: '15s' },            // ramp-down
      ],
    },
  },
  thresholds: {
    // Response time: no request may exceed 1.5 s (p95 also tracked for analysis)
    http_req_duration: [`max<${MAX_RESPONSE_MS}`, `p(95)<${MAX_RESPONSE_MS}`],
    // Error rate below 3% (HTTP level and functional level)
    http_req_failed: [`rate<${MAX_ERROR_RATE}`],
    login_errors: [`rate<${MAX_ERROR_RATE}`],
    // Checks must pass in more than 97% of requests
    checks: [`rate>${1 - MAX_ERROR_RATE}`],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// ---------------------------------------------------------------------------
// Virtual user logic
// ---------------------------------------------------------------------------
export default function () {
  // Round-robin over the CSV rows using the global iteration counter
  const user = users[exec.scenario.iterationInTest % users.length];

  const payload = JSON.stringify({ username: user.username, password: user.password });
  const params = {
    headers: { 'Content-Type': 'application/json' },
    timeout: '60s', // same as curl --max-time 60
    tags: { name: 'POST /auth/login' },
  };

  const res = http.post(`${BASE_URL}/auth/login`, payload, params);
  loginDuration.add(res.timings.duration);

  const ok = check(res, {
    'status is 200/201': (r) => r.status === 200 || r.status === 201,
    'response has token': (r) => {
      try {
        return typeof r.json('token') === 'string' && r.json('token').length > 0;
      } catch (e) {
        return false;
      }
    },
    [`response time <= ${MAX_RESPONSE_MS} ms`]: (r) => r.timings.duration <= MAX_RESPONSE_MS,
  });

  loginErrors.add(!ok);
}

// ---------------------------------------------------------------------------
// Reports: console summary + JSON + TXT files in results/
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  const text = textSummary(data, { indent: ' ', enableColors: false });
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    'results/summary.json': JSON.stringify(data, null, 2),
    'results/summary.txt': text,
  };
}
