/* Opt-in integration check. Creates disposable users/workspaces. Never uses existing users.
 * Membership fixtures are inserted directly into the configured local database; the
 * public invitation redemption/email-delivery flow is deliberately not claimed tested.
 * Secrets remain in process memory. Output contains statuses and fixture IDs only.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Client } = require('pg');
require('dotenv').config({ quiet: true });
if (!process.argv.includes('--run')) throw new Error('Explicit --run required');
const run = `p2-${Date.now()}`;
const results = [], users = [], orgs = [];
let db;
async function call(label, method, path, body, actor, org, expected = 200, code) {
  const started = Date.now();
  const headers = { 'Content-Type': 'application/json' };
  if (actor) headers.Authorization = `Bearer ${actor.tokens.accessToken}`;
  if (org) headers['X-Organization-Id'] = org;
  try {
    const res = await fetch(`http://localhost:3000${path}`, { method, headers,
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000) });
    const json = await res.json();
    const pass = res.status === expected && (!code || json.error?.code === code);
    const row = { label, method, path, status: res.status, expected, code: json.error?.code,
      pass, ms: Date.now() - started, requestId: json.meta?.requestId };
    results.push(row); console.log(JSON.stringify(row));
    return { data: json.data, status: res.status, json };
  } catch (e) {
    results.push({ label, method, path, pass: false, transport: e.name });
    console.log(JSON.stringify({ label, pass: false, transport: e.name })); return {};
  }
}
function need(r, label) { if (!r.data) throw new Error(`Fixture failed: ${label}`); return r.data; }
function check(label, pass) { results.push({ label, pass: !!pass }); console.log(JSON.stringify({label,pass:!!pass})); }
const p = (id, suffix='') => `/api/v1/organizations/${id}${suffix}`;
async function main() {
  await call('liveness', 'GET', '/health/live');
  await call('readiness', 'GET', '/health/ready');
  for (let i=0;i<3;i++) {
    const password = `V9!${crypto.randomBytes(24).toString('base64url')}q@`;
    const email = `${run}-${i}@example.invalid`;
    const u = need(await call(`register fixture ${i}`, 'POST', '/api/v1/auth/register',
      {email,password,firstName:'PhaseTwo',lastName:`Fixture${i}`},null,null,201),'register');
    users.push(u);
  }
  const [owner, member, leaver] = users;
  const w = need(await call('create disposable workspace','POST','/api/v1/organizations',
    {name:`Phase 2 verification ${run}`,slug:run},owner,null,201),'workspace');
  orgs.push({id:w.id,actor:owner}); const id=w.id;
  const other = need(await call('create second tenant','POST','/api/v1/organizations',
    {name:`Isolation ${run}`,slug:`${run}-b`},leaver,null,201),'second tenant');
  orgs.push({id:other.id,actor:leaver});
  await call('API20 catalogue','GET','/api/v1/permissions',undefined,owner);
  await call('catalogue requires auth','GET','/api/v1/permissions',undefined,null,null,401);
  const roles = need(await call('API21 roles','GET',p(id,'/roles'),undefined,owner,id),'roles');
  const basic = roles.find(r=>r.slug==='member'), viewer=roles.find(r=>r.slug==='viewer');
  await call('API22 role detail','GET',p(id,`/roles/${basic.id}`),undefined,owner,id);
  db = new Client({host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
    user:process.env.DB_USERNAME||'postgres',password:process.env.DB_PASSWORD,
    database:process.env.DB_NAME||'ai_agent_platform',ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:process.env.DB_SSL_REJECT_UNAUTHORIZED!=='false',...(process.env.DB_SSL_CA?{ca:process.env.DB_SSL_CA}:{})}:false});
  await db.connect();
  const mids=[];
  for (const u of [member,leaver]) {
    const mid=crypto.randomUUID();
    await db.query('INSERT INTO organization_members (id,organization_id,user_id,status,joined_at) VALUES ($1,$2,$3,$4,NOW())',[mid,id,u.user.id,'ACTIVE']);
    await db.query('INSERT INTO member_roles (member_id,role_id) VALUES ($1,$2)',[mid,basic.id]); mids.push(mid);
  }
  await call('API26 recompute fixture memberships','POST',p(id,'/roles/recompute'),{},owner,id);
  const [mid,lid]=mids;
  await call('API01 workspace patch','PATCH',p(id),{description:'Disposable live verification',settings:{defaultChunkSize:512,defaultChunkOverlap:64}},owner,id);
  await call('invalid overlap','PATCH',p(id),{settings:{defaultChunkOverlap:512}},owner,id,422,'VALIDATION_FAILED');
  await call('unknown workspace field','PATCH',p(id),{inventedField:true},owner,id,422);
  await call('member cannot update workspace','PATCH',p(id),{description:'denied'},member,id,403);
  await call('API08 members','GET',p(id,'/members?page=1&limit=2'),undefined,owner,id);
  await call('API09 member detail','GET',p(id,`/members/${mid}`),undefined,owner,id);
  await call('API11 member profile','PATCH',p(id,`/members/${mid}`),{displayName:'Live fixture',title:'Tester'},owner,id);
  await call('self profile','PATCH',p(id,`/members/${mid}`),{displayName:''},member,id);
  const custom=need(await call('API23 create role','POST',p(id,'/roles'),{name:`Reviewer ${run}`,priority:30,permissionKeys:['document:read'],color:'#2563EB'},owner,id,201),'custom role');
  await call('API24 edit role','PATCH',p(id,`/roles/${custom.id}`),{description:'Verified live'},owner,id);
  await call('system role immutable','PATCH',p(id,`/roles/${basic.id}`),{description:'denied'},owner,id,403,'ROLE_IMMUTABLE');
  await call('API10 replace roles','PUT',p(id,`/members/${mid}/roles`),{roleIds:[custom.id]},owner,id);
  await call('role in use','DELETE',p(id,`/roles/${custom.id}`),undefined,owner,id,409,'ROLE_IN_USE');
  await call('restore member role','PUT',p(id,`/members/${mid}/roles`),{roleIds:[basic.id]},owner,id);
  await call('API25 delete role','DELETE',p(id,`/roles/${custom.id}`),undefined,owner,id);
  await call('API27 scopes','GET',p(id,'/api-keys/scopes'),undefined,owner,id);
  const key=need(await call('API29 create key','POST',p(id,'/api-keys'),{name:`Disposable ${run}`,scopes:['document:read']},owner,id,201),'key');
  check('one-time key response shape',typeof key.plaintextKey==='string'&&!!key.apiKey.id);
  const keys=need(await call('API28 key metadata','GET',p(id,'/api-keys'),undefined,owner,id),'key list');
  check('key list has no plaintext and usageCount is string',keys.every(k=>!('plaintextKey'in k)&&typeof k.usageCount==='string'));
  await call('unsupported key scope','POST',p(id,'/api-keys'),{name:'Denied',scopes:['*:*']},owner,id,400);
  await call('API30 revoke key with DELETE body','DELETE',p(id,`/api-keys/${key.apiKey.id}`),{reason:'Disposable live verification complete'},owner,id);
  await call('repeat key revoke','DELETE',p(id,`/api-keys/${key.apiKey.id}`),{},owner,id);
  await call('API12 suspend','POST',p(id,`/members/${mid}/suspend`),{reason:'Disposable test'},owner,id);
  await call('suspended membership denied','GET',p(id),undefined,member,id,403);
  await call('API13 reactivate','POST',p(id,`/members/${mid}/reactivate`),{},owner,id);
  await call('reactivated access','GET',p(id),undefined,member,id);
  await call('cross tenant role rejected','GET',p(other.id,`/roles/${basic.id}`),undefined,leaver,other.id,404);
  await call('API16 invitations','GET',p(id,'/invitations'),undefined,owner,id);
  const invite=need(await call('API17 create invitation','POST',p(id,'/invitations'),{email:`${run}-invite@example.invalid`,roleId:viewer.id,message:'Disposable test invitation'},owner,id,201),'invite');
  await call('API18 resend invitation','POST',p(id,`/invitations/${invite.id}/resend`),{},owner,id);
  await call('API19 revoke invitation','DELETE',p(id,`/invitations/${invite.id}`),undefined,owner,id);
  await call('revoked invitation resend rejected','POST',p(id,`/invitations/${invite.id}/resend`),{},owner,id,409,'INVITATION_REVOKED');
  await call('API04 IP rules','GET',p(id,'/ip-rules'),undefined,owner,id);
  await call('enable without rules','PUT',p(id,'/ip-enforcement'),{enabled:true},owner,id,400);
  await call('invalid IP rule','POST',p(id,'/ip-rules'),{cidr:'not-an-ip'},owner,id,400);
  const rule=need(await call('API05 add IP rule','POST',p(id,'/ip-rules'),{cidr:'127.0.0.1/32',label:'Disposable loopback'},owner,id,201),'IP rule');
  await call('duplicate IP rule','POST',p(id,'/ip-rules'),{cidr:'127.0.0.1/32'},owner,id,409);
  const rule6=need(await call('add IPv6 loopback','POST',p(id,'/ip-rules'),{cidr:'::1/128'},owner,id,201),'IPv6');
  await call('API07 enable enforcement','PUT',p(id,'/ip-enforcement'),{enabled:true},owner,id);
  await call('disable enforcement','PUT',p(id,'/ip-enforcement'),{enabled:false},owner,id);
  await call('API06 remove IP rule','DELETE',p(id,`/ip-rules/${rule.id}`),undefined,owner,id);
  await call('remove IPv6 rule','DELETE',p(id,`/ip-rules/${rule6.id}`),undefined,owner,id);
  await call('owner cannot leave','POST',p(id,'/members/leave'),{},owner,id,409,'CANNOT_REMOVE_LAST_OWNER');
  await call('API15 member leaves','POST',p(id,'/members/leave'),{},leaver,id);
  await call('API14 remove member','DELETE',p(id,`/members/${mid}`),undefined,owner,id);
  await call('removed detail remains readable','GET',p(id,`/members/${mid}`),undefined,owner,id);
  // A fresh membership fixture is necessary for ownership transfer after removal.
  const successor=crypto.randomUUID();
  await db.query('INSERT INTO organization_members (id,organization_id,user_id,status,joined_at) VALUES ($1,$2,$3,$4,NOW())',[successor,id,member.user.id,'ACTIVE']);
  await db.query('INSERT INTO member_roles (member_id,role_id) VALUES ($1,$2)',[successor,basic.id]);
  await call('recompute successor','POST',p(id,'/roles/recompute'),{},owner,id);
  await call('API03 transfer ownership','POST',p(id,'/transfer-ownership'),{newOwnerUserId:member.user.id},owner,id);
  orgs[0].actor=member;
}
main().catch(e=>{console.log(JSON.stringify({fatal:e.message}));results.push({label:'run completed',pass:false,error:e.message});}).finally(async()=>{
  for (const o of orgs) await call('API02 cleanup disposable workspace','DELETE',p(o.id),undefined,o.actor,o.id);
  for (const u of users) await call('cleanup logout all fixture sessions','POST','/api/v1/auth/logout-all',{},u);
  if(db) await db.end();
  const report={run,completedAt:new Date().toISOString(),results,fixtureUsers:users.map(u=>u.user.id),fixtureWorkspaces:orgs.map(o=>o.id),
    limitations:['Membership fixtures inserted directly; mail delivery and invitation acceptance not verified.','Fixture accounts retained; sessions revoked. Workspaces soft-deleted through API.','No browser/frontend tests.']};
  fs.writeFileSync('docs/frontend/PHASE_2_LIVE_RESULTS.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({total:results.length,passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length}));
  process.exitCode=results.some(x=>!x.pass)?1:0;
});
