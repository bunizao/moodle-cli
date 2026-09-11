import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.env.MOODLE_REVIEW_ROOT ?? process.cwd();
const outputPath = process.env.MOODLE_REVIEW_OUTPUT ?? join(tmpdir(), 'moodle-mcp-review-runtime.json');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const require = createRequire(`${root}/package.json`);
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const access = randomBytes(32).toString('base64url');
let sync = randomBytes(32).toString('base64url');
const encryption = randomBytes(32).toString('base64url');
const cookies = { a: 'SYNTHETIC_ACCOUNT_A_SESSION', b: 'SYNTHETIC_ACCOUNT_B_SESSION' };
const received = [];
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const receiver = createServer((req, res) => {
  received.push({ cookie: req.headers.cookie ?? null, url: req.url });
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><h1>External course resource</h1></html>');
});
const receiverPort = await listen(receiver);
const moodle = createServer(async (req, res) => {
  const accountB = req.headers.cookie?.includes(cookies.b);
  const userid = accountB ? 202 : 101;
  if (req.url.startsWith('/my/')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><script>M.cfg={"sesskey":"synthetic-sesskey-${userid}","userid":${userid}}</script></html>`);
  } else if (req.url.startsWith('/lib/ajax/service.php')) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const calls = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(calls.map((call, index) => ({ index, error: false, data:
      call.methodname === 'core_course_get_course_module' ? { cm: { modname: 'url', course: 1 } } :
      call.methodname === 'core_webservice_get_site_info' ? { userid, fullname: `Synthetic Account ${accountB ? 'B' : 'A'}`, username: `account-${userid}`, siteurl: 'https://synthetic.example', sitename: 'Synthetic Moodle' } :
      { timeremaining: 3600 }
    }))));
  } else if (req.url.startsWith('/mod/url/view.php')) {
    res.writeHead(302, { location: `http://localhost:${receiverPort}/external-resource` });
    res.end();
  } else {
    res.writeHead(404); res.end();
  }
});
const moodlePort = await listen(moodle);
let origin = 'http://127.0.0.1';
const bindings = {
  MOODLE_ORIGIN: `http://127.0.0.1:${moodlePort}`,
  MCP_ACCESS_TOKEN_DIGEST: digest(access), SESSION_SYNC_TOKEN_DIGEST: digest(sync),
  SESSION_ENCRYPTION_KEY: encryption,
};
const options = {
  name: 'moodle-review', modules: true, scriptPath: `${root}/dist/worker/worker.js`,
  compatibilityDate: '2026-08-08', bindings,
  durableObjects: { SESSION_BROKER: { className: 'SessionBroker', useSQLite: true }, AUTH_BROKER: { className: 'AuthBroker', useSQLite: true } },
};
const mf = new Miniflare(convertV4MiniflareOptions(options));
const evidence = { runtime: 'Miniflare/workerd', revision };
const call = (path, init = {}) => fetch(`${origin}${path}`, { ...init, redirect: 'manual' });
const form = (body) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
const register = () => call('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Synthetic Client', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }) });
const pair = async () => (await (await call('/pair', { method: 'POST', headers: { authorization: `Bearer ${sync}` } })).json()).code;
const verifier = 'synthetic-review-verifier-123456789012345678901234567890';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const authorize = (clientId, code) => call('/oauth/authorize', form({ response_type: 'code', client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge_method: 'S256', code_challenge: challenge, resource: `${origin}/mcp`, pairing_code: code }));
const exchange = (clientId, code) => call('/oauth/token', form({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code, code_verifier: verifier, resource: `${origin}/mcp` }));
const mcp = (token, name = 'get_user', args = {}) => call('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
const upload = (cookieValue, expectedRevision) => call('/session', { method: 'PUT', headers: { authorization: `Bearer ${sync}`, 'content-type': 'application/json' }, body: JSON.stringify({ moodleOrigin: bindings.MOODLE_ORIGIN, cookieName: 'MoodleSession', cookieValue, expectedRevision }) });
try {
  origin = (await mf.ready).origin;
  evidence.health = (await call('/healthz')).status;
  const firstUpload = await upload(cookies.a, null);
  if (firstUpload.status !== 201) console.log('Upload diagnostic', firstUpload.status, await firstUpload.text());
  assert.equal(firstUpload.status, 201);
  let clientId = (await (await register()).json()).client_id;
  const approval = await authorize(clientId, await pair());
  assert.equal(approval.status, 302);
  const code = new URL(approval.headers.get('location')).searchParams.get('code');
  const tokenResponse = await exchange(clientId, code);
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  const initial = await mcp(tokens.access_token);
  const initialBody = await initial.json();
  evidence.oauthFlow = { authorization: approval.status, token: tokenResponse.status, mcp: initial.status, accountBefore: initialBody.result?.structuredContent?.user?.userid };
  assert.equal(evidence.oauthFlow.accountBefore, 101);
  assert.equal((await upload(cookies.b, 1)).status, 409);
  const switched = await mcp(tokens.access_token);
  const switchedBody = await switched.json();
  evidence.accountSwitch = { status: switched.status, accountAfter: switchedBody.result?.structuredContent?.user?.userid, previousGrantCanReadNewAccount: switchedBody.result?.structuredContent?.user?.userid === 202 };
  assert.equal(evidence.accountSwitch.accountAfter, 101);
  await mcp(tokens.access_token, 'get_activity', { activityId: 999 });
  evidence.crossOriginRedirect = { requestsReceived: received.length, syntheticCookieForwarded: received.some((item) => item.cookie?.includes('MoodleSession=')) };
  assert.equal(evidence.crossOriginRedirect.requestsReceived, 1);
  assert.equal(evidence.crossOriginRedirect.syntheticCookieForwarded, false);
  const refreshResponse = await call('/oauth/token', form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token }));
  const refreshed = await refreshResponse.json();
  assert.equal(refreshResponse.status, 200);
  const replay = await call('/oauth/token', form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token }));
  evidence.refreshReplay = { replay: replay.status, descendantAccess: (await mcp(refreshed.access_token)).status };
  const rotatedAccess = randomBytes(32).toString('base64url');
  sync = randomBytes(32).toString('base64url');
  await mf.setOptions(convertV4MiniflareOptions({ ...options, port: Number(new URL(origin).port), bindings: { ...bindings, MCP_ACCESS_TOKEN_DIGEST: digest(rotatedAccess), SESSION_SYNC_TOKEN_DIGEST: digest(sync) } }));
  origin = (await mf.ready).origin;
  evidence.credentialRotation = { oldStaticAccess: (await mcp(access)).status, oldOAuthAccess: (await mcp(tokens.access_token)).status };
  assert.equal(evidence.credentialRotation.oldStaticAccess, 401);
  assert.equal(evidence.credentialRotation.oldOAuthAccess, 401);
  clientId = (await (await register()).json()).client_id;
  const raceCode = await pair();
  const raced = await Promise.all([authorize(clientId, raceCode), authorize(clientId, raceCode)]);
  evidence.concurrentPairing = raced.map((r) => r.status);
  assert.deepEqual(evidence.concurrentPairing.slice().sort(), [302, 403]);
  const statuses = [];
  for (let i = 0; i < 19; i++) statuses.push((await register()).status);
  const overflow = await register();
  evidence.registrationExhaustion = { anonymousAccepted: statuses.filter((s) => s === 201).length + 1, legitimateNextRegistration: overflow.status, registrationAccepted: overflow.status === 201 };
  assert.equal(overflow.status, 201);
  const bodyText = JSON.stringify(initialBody) + JSON.stringify(switchedBody);
  evidence.responseRedaction = { rawCookiePresent: Object.values(cookies).some((v) => bodyText.includes(v)), sesskeyPresent: bodyText.includes('synthetic-sesskey') };
  assert.equal(evidence.responseRedaction.rawCookiePresent, false);
  assert.equal(evidence.responseRedaction.sesskeyPresent, false);
  await writeFile(outputPath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await mf.dispose();
  await Promise.all([new Promise((resolve) => moodle.close(resolve)), new Promise((resolve) => receiver.close(resolve))]);
}
