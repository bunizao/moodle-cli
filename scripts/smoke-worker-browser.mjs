import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = process.env.MOODLE_REVIEW_ROOT ?? process.cwd();
const outputDirectory = process.env.MOODLE_REVIEW_OUTPUT_DIRECTORY ?? tmpdir();
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const mode = process.env.POLICY_MODE ?? 'baseline';
if (!['baseline','referrer-only','fixed'].includes(mode)) throw new Error('Invalid POLICY_MODE');
const repoRequire = createRequire(`${root}/package.json`);
const runtimeRequire = process.env.MOODLE_REVIEW_PLAYWRIGHT_PACKAGE
  ? createRequire(process.env.MOODLE_REVIEW_PLAYWRIGHT_PACKAGE)
  : repoRequire;
const { Miniflare, convertV4MiniflareOptions } = repoRequire('miniflare');
const { chromium } = runtimeRequire('playwright');
const digest = value => createHash('sha256').update(value).digest('hex');
const sync = randomBytes(32).toString('base64url');
const received = [];
const callback = createServer((req, res) => {
  received.push({ path: new URL(req.url, 'http://localhost').pathname, hasCode: new URL(req.url, 'http://localhost').searchParams.has('code') });
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><h1>Synthetic OAuth callback reached</h1></html>');
});
await new Promise(resolve => callback.listen(0, '127.0.0.1', resolve));
const callbackUrl = `http://127.0.0.1:${callback.address().port}/callback`;
const mf = new Miniflare(convertV4MiniflareOptions({
  name: 'moodle-csp-browser-review', https: true, modules: true, scriptPath: `${root}/dist/worker/worker.js`,
  compatibilityDate: '2026-08-08',
  bindings: { MOODLE_ORIGIN: 'https://synthetic.invalid', MCP_ACCESS_TOKEN_DIGEST: digest(randomBytes(32).toString('base64url')), SESSION_SYNC_TOKEN_DIGEST: digest(sync), SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64url') },
  durableObjects: { SESSION_BROKER: { className: 'SessionBroker', useSQLite: true }, AUTH_BROKER: { className: 'AuthBroker', useSQLite: true } },
}));
let browser;
const evidence = { revision, server: 'Actual bundled Worker in Miniflare/workerd; synthetic credentials and loopback callback only', mode, instrumentation:mode==='baseline'?'None: original application response policies':mode==='referrer-only'?'Only approval GET Referrer-Policy changed; CSP unchanged; source unchanged':'Positive control only: Referrer-Policy and exact callback-origin form-action changed; source unchanged', console: [], pageErrors: [], requestFailures: [], callbackRequests: received };
const safe = value => String(value).replace(/([?&](?:code|pairing_code|state|token)=)[^&\s"']+/g, '$1<redacted>');
try {
 const origin = (await mf.ready).origin;
 const register = await mf.dispatchFetch(`${origin}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({client_name: 'Synthetic Chromium CSP Client',redirect_uris:[callbackUrl]}) });
 const clientId = (await register.json()).client_id;
 const pair = await mf.dispatchFetch(`${origin}/pair`, { method:'POST',headers:{ authorization:`Bearer ${sync}` }});
 const pairingCode = (await pair.json()).code;
 const verifier = 'synthetic-browser-verifier-123456789012345678901234567890';
 const url = new URL(`${origin}/oauth/authorize`);
 url.search = new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:callbackUrl,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url'),resource:`${origin}/mcp`,state:'synthetic-browser-state'}).toString();
 browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
 evidence.browserVersion = browser.version();
 const context=await browser.newContext({ignoreHTTPSErrors:true});
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if (!['127.0.0.1','localhost','[::1]'].includes(u.hostname)) return route.abort();
  if(mode!=='baseline' && route.request().method()==='GET' && u.pathname==='/oauth/authorize'){ const upstream=await route.fetch(); const headers={...upstream.headers(),'referrer-policy':'strict-origin-when-cross-origin','content-security-policy':mode==='fixed'?upstream.headers()['content-security-policy'].replace("form-action 'self'","form-action 'self' "+new URL(callbackUrl).origin):upstream.headers()['content-security-policy']}; return route.fulfill({response:upstream,headers}); }
  return route.continue();
 });
 const page=await context.newPage();
 page.on('request', req=>{ if(req.method()==='POST' && new URL(req.url()).pathname==='/oauth/authorize') evidence.formRequest={origin:req.headers().origin??null,refererPresent:Boolean(req.headers().referer),url:req.url()}; });
 page.on('console',msg=>evidence.console.push({type:msg.type(),text:safe(msg.text())}));
 page.on('pageerror',err=>evidence.pageErrors.push(safe(err.message)));
 page.on('requestfailed',req=>evidence.requestFailures.push({url:safe(req.url()),failure:req.failure()?.errorText}));
 page.on('response',res=>{
  if(res.request().method()==='POST' && new URL(res.url()).pathname==='/oauth/authorize') evidence.authorizeResponse={status:res.status(),location:safe(res.headers().location??''),csp:res.headers()['content-security-policy']??null};
 });
 const approval=await page.goto(url.toString());
 await page.waitForLoadState('networkidle');
 evidence.approval={status:approval.status(),csp:approval.headers()['content-security-policy'],referrerPolicy:approval.headers()['referrer-policy'],buttons:await page.getByRole('button').allTextContents(),inputName:await page.getByLabel('Pairing code').getAttribute('name')};
 await page.getByLabel('Pairing code').fill(pairingCode);
 try { await page.getByRole('button',{name:'Approve access',exact:true}).click({timeout:8000}); } catch(e){evidence.clickError=safe(e.message);}
 await page.waitForTimeout(1200);
 evidence.finalUrl=safe(page.url());
 evidence.callbackReached=received.some(r=>r.path==='/callback' && r.hasCode);
 assert.equal(evidence.callbackReached, true, 'Browser approval must reach the validated callback');
 evidence.bodyText=(await page.locator('body').innerText()).slice(0,800);
 await page.screenshot({path:join(outputDirectory, `moodle-mcp-review-browser-${mode}.png`),fullPage:true});
 await writeFile(join(outputDirectory, `moodle-mcp-review-browser-${mode}.json`),JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify(evidence,null,2));
} finally {
 if(browser) await browser.close();
 await mf.dispose();
 await new Promise(resolve=>callback.close(resolve));
}
