#!/usr/bin/env node
'use strict';

// Sends a synthetic fixture through an n8n TEST webhook with a genuine
// Netlify-style JWS. Never points at a production /webhook/ endpoint.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}

const secret = process.env.NETLIFY_JWS_SECRET;
const targetValue = process.env.N8N_WEBHOOK_TEST_URL;

if (!secret) fail('NETLIFY_JWS_SECRET is required.');
if (!targetValue) fail('N8N_WEBHOOK_TEST_URL is required.');

let target;
try {
  target = new URL(targetValue);
} catch {
  fail('N8N_WEBHOOK_TEST_URL must be a valid URL.');
}

const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
if (target.protocol !== 'https:' && !(target.protocol === 'http:' && isLocalHost)) {
  fail('Refusing non-HTTPS webhook URL (HTTP is allowed only for localhost).');
}
if (!target.pathname.includes('/webhook-test/')) {
  fail('Refusing non-test URL. The path must contain /webhook-test/.');
}
if (target.username || target.password || target.search || target.hash) {
  fail('Webhook URL must not contain user info, query parameters or fragments.');
}

const samplePath = path.join(__dirname, 'sample-netlify-payload.json');
const rawBody = fs.readFileSync(samplePath);
const header = Buffer.from(JSON.stringify({
  alg: 'HS256',
  typ: 'JWT'
})).toString('base64url');
const claims = Buffer.from(JSON.stringify({
  iss: 'netlify',
  sha256: crypto.createHash('sha256').update(rawBody).digest('hex')
})).toString('base64url');
const signingInput = header + '.' + claims;
const signature = crypto
  .createHmac('sha256', secret)
  .update(signingInput)
  .digest('base64url');
const jws = signingInput + '.' + signature;

async function main() {
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': jws
    },
    body: rawBody,
    signal: AbortSignal.timeout(15000)
  });

  const responseText = await response.text();
  let responseSummary;
  try {
    const parsed = JSON.parse(responseText);
    responseSummary = {
      ok: parsed.ok === true,
      duplicate: parsed.duplicate === true,
      error: typeof parsed.error === 'string' ? parsed.error : undefined
    };
  } catch {
    responseSummary = { response: 'non-json response' };
  }

  process.stdout.write(JSON.stringify({
    httpStatus: response.status,
    result: responseSummary
  }, null, 2) + '\n');

  if (!response.ok || responseSummary.ok !== true) process.exitCode = 1;
}

main().catch((error) => {
  // Do not print request headers, JWS, secret or payload contents.
  fail('Synthetic webhook request failed: ' + String(error && error.message || 'unknown error'));
});
