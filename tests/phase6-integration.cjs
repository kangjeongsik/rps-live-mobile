const assert=require('node:assert/strict');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {randomUUID,createHash}=require('node:crypto');
const {resolve}=require('node:path');
const {Pool}=require('pg');
const {configuration,preflight}=require('../runtime-config.cjs');
const exec=promisify(execFile);
const work=resolve(__dirname,'..');
const source=new URL(process.env.RPS_E2E_DSN||'');
const db=source.pathname.slice(1);
assert(['127.0.0.1','localhost','[::1]'].includes(source.hostname)&&/^rps_local_[a-z0-9_]+$/.test(db));
assert(!source.search&&!source.hash);
const date=(day,h='20:00:00')=>'2039-01-'+String(day).padStart(2,'0')+'T'+h+'+09:00';
const port=Number(process.env.RPS_E2E_PORT||34859);
const environment={...process.env,PORT:String(port),RPS_ENV:'local',RPS_LOCAL_DB_NO_TLS:'1',
  PUBLIC_ORIGIN:'http://127.0.0.1:'+port,DATABASE_URL:source.href,ADMIN_USER:'admin',
  ADMIN_PASSWORD:'phase6 synthetic test password',DAILY_SCHEDULER_TOKEN:'s'.repeat(48),
  DAILY_PUSH_DELIVERY:'disabled',VAPID_PUBLIC_KEY:'',VAPID_PRIVATE_KEY:''};
const host=environment.PUBLIC_ORIGIN;
const credentials='Basic '+Buffer.from('admin:'+environment.ADMIN_PASSWORD).toString('base64');
const pool=new Pool({connectionString:source.href,ssl:false});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const person=randomUUID(),other=randomUUID();
let app,serverLog='';
async function waitFor(check){
  let error;
  for(let i=0;i<65;i++){
    try{const value=await check();if(value)return value}catch(e){error=e}
    await delay(100);
  }
  throw error||Error('Expected condition did not arrive');
}
async function spawnApp(clock){
  app=spawn(process.execPath,['server.cjs'],{cwd:work,env:{...environment,RPS_CAMPAIGN_TEST_AT:clock},
    stdio:['ignore','ignore','pipe']});
  app.stderr.on('data',data=>serverLog+=data);
  await waitFor(async()=> (await fetch(host+'/health')).ok);
}
async function stop(){
  if(app&&app.exitCode===null)await new Promise(done=>{app.once('exit',done);app.kill()});
}
async function request(path,{method='GET',data,device,authorization,cookie,expect=200,raw=false,headers}={}){
  const result=await fetch(host+path,{method,headers:{...(data&&{'Content-Type':'application/json'}),
    ...(device&&{'X-RPS-Device':device}),...(authorization&&{Authorization:authorization}),...(cookie&&{Cookie:cookie}),...headers},
    ...(data&&{body:JSON.stringify(data)})});
  const body=raw?await result.text():await result.json();
  assert.equal(result.status,expect,path+' '+(result.status===expect?'':JSON.stringify(body)));
  return {body,cookie:result.headers.get('set-cookie')?.split(';')[0],headers:result.headers};
}
const post=(path,data,options={})=>request(path,{method:'POST',data,...options});
const api=(path,options)=>request('/api/v1'+path,options);
const admin=(path,method='GET',data,expect=200)=>api('/admin'+path,{method,data,expect,authorization:credentials}).then(x=>x.body);
const engine=(scope,data,authorization,expect=200)=>post('/tournament/api'+scope,data,{authorization,expect}).then(x=>x.body);
const cmd=(scope,command,extra={})=>engine(scope,{action:'admin',cmd:command,...extra},credentials);
const bearer=record=>'Bearer '+record.token;
async function live(scope){
  const response=await fetch(host+'/tournament/events'+scope,{signal:AbortSignal.timeout(3000)});
  assert.equal(response.status,200);
  const reader=response.body.getReader();
  const chunk=await reader.read();
  await reader.cancel();
  return JSON.parse(Buffer.from(chunk.value).toString().split('\n')[0].slice(6));
}
const dbRows=async(sql,args)=>(await pool.query(sql,args)).rows;
const quiz={prompt:'Choose the correct option',choices:['A','B'],correctIndex:0,points:10};
async function main(){
  assert.throws(()=>configuration({...environment,DATABASE_URL:''}),error=>error.configuration);
  assert.throws(()=>configuration({...environment,RPS_ENV:'staging',PUBLIC_ORIGIN:'https://fixture.invalid'}),
    error=>error.configuration);
  await preflight(pool,configuration(environment));
  await spawnApp(date(7));
  for(const path of ['/live','/','/store/coupons'])assert.equal((await fetch(host+path)).status,200);
  await api('/admin/advertising/dashboard',{expect:401});
  await api('/admin/operations',{expect:401});
  await post('/admin/login',{user:'admin',password:environment.ADMIN_PASSWORD},
    {headers:{Origin:'https://outside.invalid'},expect:403});
  const login=await post('/admin/login',{user:'admin',password:environment.ADMIN_PASSWORD});
  assert.match(login.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Strict/);
  await waitFor(async()=>Boolean((await api('/admin/operations',{cookie:login.cookie})).body.metrics.dailySchedule));
  const company=(await admin('/companies','POST',{name:'Synthetic sponsor',brand:'Fixture Cafe',industry:'Cafe',
    contactInfo:'PRIVATE FIXTURE',internalNote:'PRIVATE INTERNAL'},201)).company;
  const competitor=(await admin('/companies','POST',{name:'Other synthetic sponsor',brand:'Other Fixture',industry:'Education'},201)).company;
  const recommendation=(await admin('/advertising/recommend','POST',{companyId:company.id,industry:'Cafe',goal:'store_visit',
    hasStore:true})).recommendations[0];
  assert.equal(recommendation.code,'store_visit');
  const lead=(await admin('/advertising/leads','POST',{companyId:company.id,industry:'Cafe',goal:'store_visit'},201)).lead;
  const schedule={opensAt:date(7,'18:00:00'),startsAt:date(7,'19:00:00'),endsAt:date(7,'23:55:00')};
  let proposal=(await admin('/advertising/proposals','POST',{leadId:lead.id,packageId:recommendation.packageId,
    title:'Fixture proposal',eventType:'quiz',activities:['Fixture quiz'],...schedule},201)).proposal;
  proposal=(await admin('/advertising/proposals/'+proposal.id+'/commands','POST',
    {command:'finalize',revision:proposal.revision})).proposal;
  let contract=(await admin('/advertising/contracts','POST',{proposalId:proposal.id,billingMode:'performance',
    performanceBasis:'validated_coupon',unitFee:'2500',cap:'2400',vatMode:'exclusive',discountPayer:'none',
    contractStart:'2039-01-07',contractEnd:'2039-01-07',settlementCycle:'end_of_campaign'},201)).contract;
  for(const status of ['proposal_writing','proposal_sent','confirmed'])
    contract=(await admin('/advertising/contracts/'+contract.id+'/commands','POST',{status,revision:contract.revision})).contract;
  const quizCampaign=(await admin('/advertising/proposals/'+proposal.id+'/create-campaign','POST',{},201)).campaign;
  await api('/campaigns/'+quizCampaign.id,{expect:404});
  await admin('/campaigns/'+quizCampaign.id,'PUT',{companyId:company.id,title:'Fixture quiz',type:'quiz',
    questions:[quiz],advertisingReviewed:true,...schedule});
  await admin('/campaigns/'+quizCampaign.id+'/commands','POST',{command:'publish'});
  const ch=await api('/campaigns/'+quizCampaign.id);
  assert(!JSON.stringify(ch.body).includes('PRIVATE'));
  const m=(await admin('/campaigns','POST',{companyId:company.id,title:'Synthetic mission',type:'mission',
    missions:[{...quiz,title:'Fixture mission',kind:'daily_quiz'}],...schedule},201)).campaign;
  const r=(await admin('/campaigns','POST',{companyId:company.id,title:'Synthetic RPS',type:'rps',...schedule},201)).campaign;
  for(const id of [m.id,r.id])await admin('/campaigns/'+id+'/commands','POST',{command:'publish'});
  await post('/api/v1/campaigns/'+m.id+'/join',{nickname:'Fixture browser'},{device:person});
  assert((await post('/api/v1/campaigns/'+m.id+'/missions/1/submit',{requestId:randomUUID(),answer:0},{device:person})).body.completed);

  const store=(await admin('/coupons/stores','POST',{companyId:company.id,name:'Synthetic store'},201)).store;
  const alien=(await admin('/coupons/stores','POST',{companyId:competitor.id,name:'Other store'},201)).store;
  const staffName='fixture-'+randomUUID().slice(0,8);
  const foreignName='foreign-'+randomUUID().slice(0,8);
  for(const [storeId,username] of [[store.id,staffName],[alien.id,foreignName]])
    await admin('/coupons/staff','POST',{storeId,username,displayName:'Fixture staff',
      password:'synthetic staff password',canRequestCancel:true},201);
  await admin('/coupons/policies','POST',{campaignId:quizCampaign.id,name:'Synthetic discount',minimum:'10000',discount:'1000',
    issueStart:date(7,'17:00:00'),issueEnd:date(7,'23:59:00'),validFrom:date(7,'17:00:00'),validUntil:date(9),
    inventory:3,perPerson:3,eligibility:'quiz_complete',storeIds:[store.id],active:true},201);
  await post('/api/v1/campaigns/'+quizCampaign.id+'/join',{nickname:'Fixture browser'},{device:person});
  const q=await api('/campaigns/'+quizCampaign.id,{device:person});
  assert(!Object.hasOwn(q.body.questions[0],'correct_index'));
  assert.equal((await post('/api/v1/campaigns/'+quizCampaign.id+'/quiz/submit',
    {requestId:randomUUID(),answers:[0]},{device:person})).body.score,10);
  const wallet=(await api('/me/coupons',{device:person})).body.coupons;
  assert.equal(wallet.length,3);
  await api('/me/coupons/'+wallet[0].id,{device:other,expect:404});
  const owner=await post('/api/v1/me/coupons/'+wallet[0].id+'/present',{},{device:person});
  assert.match(owner.body.qrPNG,/^data:image\/png;base64,/);
  assert.match(owner.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Strict/);
  const merchant=(await post('/api/v1/store/login',{username:staffName,password:'synthetic staff password'})).cookie;
  const foreign=(await post('/api/v1/store/login',{username:foreignName,password:'synthetic staff password'})).cookie;
  const code=owner.body.code;
  await post('/api/v1/store/coupons/verify',{code},{cookie:foreign,expect:403});
  const verify=await post('/api/v1/store/coupons/verify',{code},{cookie:merchant});
  await post('/api/v1/me/coupons/'+wallet[0].id+'/confirm',{challenge:verify.body.challenge},{device:person,expect:403});
  await post('/api/v1/me/coupons/'+wallet[0].id+'/confirm',{challenge:verify.body.challenge},{device:person,cookie:owner.cookie});
  const approval={code,requestId:randomUUID(),beforeDiscount:'10000',paid:'9000'};
  await post('/api/v1/store/coupons/redeem',{...approval,beforeDiscount:'9999',paid:'8999'},
    {cookie:merchant,expect:409});
  const response=await fetch(host+'/api/v1/store/coupons/redeem',{method:'POST',
    headers:{Cookie:merchant,'Content-Type':'application/json'},body:JSON.stringify(approval)});
  assert.equal(response.status,200);
  await response.body.cancel(); // A committed approval whose response body was lost.
  const [retry,conflict]=await Promise.all([
    post('/api/v1/store/coupons/redeem',approval,{cookie:merchant}),
    post('/api/v1/store/coupons/redeem',{...approval,requestId:randomUUID()},{cookie:merchant,expect:409})
  ]);
  assert(conflict.body.error);
  assert.equal((await api('/store/redemptions',{cookie:merchant})).body.redemptions.length,1);
  assert.equal((await api('/store/redemptions',{cookie:foreign})).body.redemptions.length,0);
  const expiredSession=createHash('sha256').update(foreign.split('=')[1]).digest('hex');
  const [foreignStaff]=await dbRows('SELECT id FROM store_staff_accounts WHERE username=$1',[foreignName]);
  await dbRows('DELETE FROM store_staff_sessions WHERE token_hash=$1',[expiredSession]);
  await dbRows("INSERT INTO store_staff_sessions(token_hash,staff_id,expires_at) VALUES($1,$2,now()-interval '1 second')",
    [expiredSession,foreignStaff.id]);
  await api('/store/redemptions',{cookie:foreign,expect:401});
  const redemption=retry.body.transaction;
  const stale=await post('/api/v1/me/coupons/'+wallet[1].id+'/present',{},{device:person,cookie:owner.cookie});
  const staleChallenge=await post('/api/v1/store/coupons/verify',{code:stale.body.code},{cookie:merchant});
  await post('/api/v1/me/coupons/'+wallet[1].id+'/confirm',{challenge:staleChallenge.body.challenge},{device:person,cookie:owner.cookie});

  const expires=await post('/api/v1/me/coupons/'+wallet[2].id+'/present',{},{device:person,cookie:owner.cookie});
  const expiresChallenge=await post('/api/v1/store/coupons/verify',{code:expires.body.code},{cookie:merchant});
  await post('/api/v1/me/coupons/'+wallet[2].id+'/confirm',{challenge:expiresChallenge.body.challenge},{device:person,cookie:owner.cookie});

  // The test clock drives campaign and coupon time. The engine keeps real, short round deadlines.
  const card=(await api('/campaigns/'+r.id)).body.gameURL;
  const joinCode=card.split('/').at(-1),scope='?join='+joinCode;
  const a=await engine(scope,{action:'join',deviceId:person,nickname:'Fixture One',agree:true,joinCode});
  const b=await engine(scope,{action:'join',deviceId:other,nickname:'Fixture Two',agree:true,joinCode});
  await cmd(scope,'start');await cmd(scope,'open');
  await engine(scope,{action:'move',move:'rock'},bearer(a));
  const before=await live(scope);
  await stop();await spawnApp(date(7,'20:01:59'));
  assert.equal((await live(scope)).deadline,before.deadline);
  assert.equal((await engine(scope,{action:'resume'},bearer(a))).id,a.id);
  await engine(scope,{action:'move',move:'scissors'},bearer(b));await cmd(scope,'close');
  assert.equal((await api('/campaigns/'+r.id+'/results')).body.results.length,1);
  // A valid approval immediately before the 120-second expiry.
  await post('/api/v1/store/coupons/redeem',{...approval,code:stale.body.code,requestId:randomUUID()},{cookie:merchant});
  await stop();await spawnApp(date(7,'20:02:00'));
  await post('/api/v1/store/coupons/redeem',{...approval,code:expires.body.code,requestId:randomUUID()},{cookie:merchant,expect:409});
  const daily='2040-01-05';
  const runAt=clock=>exec(process.execPath,['daily-run.cjs','--at',clock],{cwd:work,env:environment});
  await Promise.all([runAt(daily+'T20:59:59+09:00'),runAt(daily+'T20:59:59+09:00')]);
  const [day]=await dbRows("SELECT d.*,e.join_code FROM daily_occurrences d JOIN rps_events e ON e.id=d.event_id WHERE d.service_date=$1",[daily]);
  assert.equal(day.scheduled_at.toISOString(),daily+'T12:00:00.000Z');
  await post('/api/v1/daily/'+day.event_id+'/reservations',{notify:false},{device:person});
  await Promise.all([runAt(daily+'T21:01:00+09:00'),runAt(daily+'T21:01:00+09:00')]);
  assert.equal((await dbRows("SELECT count(*)::int AS n FROM daily_execution_log WHERE event_id=$1 AND action='open'",[day.event_id]))[0].n,1);
  assert.equal((await live('?join='+day.join_code)).daily.status,'open');
  const joinedScope='?join='+day.join_code;
  const da=await engine(joinedScope,{action:'join',joinCode:day.join_code,deviceId:person,nickname:'Daily One',agree:true});
  const dbb=await engine(joinedScope,{action:'join',joinCode:day.join_code,deviceId:other,nickname:'Daily Two',agree:true});
  await runAt(daily+'T21:01:12+09:00');
  await engine(joinedScope,{action:'join',joinCode:day.join_code,deviceId:randomUUID(),nickname:'Too Late',agree:true},null,409);
  await engine(joinedScope,{action:'move',move:'rock'},bearer(da));
  await engine(joinedScope,{action:'move',move:'scissors'},bearer(dbb));await cmd(joinedScope,'close');
  assert.equal((await live(joinedScope)).daily.status,'finished');
  assert.equal((await dbRows("SELECT count(*)::int AS n FROM daily_occurrences WHERE service_date='2040-01-06'"))[0].n,1);
  assert.equal((await dbRows('SELECT count(*)::int n FROM daily_reservations WHERE event_id=$1',[day.event_id]))[0].n,1);
  assert.equal((await dbRows('SELECT count(*)::int n FROM daily_participations WHERE event_id=$1',[day.event_id]))[0].n,2);

  await stop();await spawnApp(date(8));
  const cancellation=await post('/api/v1/store/redemptions/'+redemption.id+'/cancel-request',{reason:'Synthetic cancellation'},{cookie:merchant});
  await admin('/coupons/adjustments/'+cancellation.body.request.id+'/decision','POST',{command:'reject'});
  const base='/coupons/contracts/'+contract.id;
  const statement=(await admin(base+'/collect','POST',{})).settlement;
  assert.equal(statement.snapshot.recognizedCount,2);
  assert.equal(statement.snapshot.supply,'2400');
  await admin(base+'/review','POST',{settlementId:statement.id});
  const finalized=(await admin(base+'/finalize','POST',{settlementId:statement.id})).settlement;
  assert.equal(finalized.snapshot.total,'2640');
  assert.equal((await admin(base+'/finalize','POST',{settlementId:statement.id})).settlement.id,finalized.id);
  await assert.rejects(dbRows("UPDATE advertising_settlements SET snapshot='{}' WHERE id=$1",[statement.id]),/immutable/);
  const rival=await admin('/advertising/dashboard?companyId='+competitor.id);
  assert.equal(rival.contracts.length,0);
  assert.equal((await api('/me/coupons',{device:person})).body.coupons.filter(c=>c.status==='used').length,2);
  assert((await api('/admin/operations',{authorization:credentials})).body.metrics.settlementRequests.ok>0);

  if(process.env.RPS_E2E_MAINTENANCE_DSN){
    const maintenance=new URL(process.env.RPS_E2E_MAINTENANCE_DSN);
    assert.equal(maintenance.hostname,source.hostname);assert.equal(maintenance.port,source.port);
    assert.equal(maintenance.pathname,'/postgres');assert(!maintenance.search&&!maintenance.hash);
    const controller=new Pool({connectionString:maintenance.href,ssl:false});
    try{
      await controller.query('ALTER DATABASE "'+db+'" ALLOW_CONNECTIONS false');
      await controller.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1',[db]);
      await waitFor(async()=> (await fetch(host+'/health')).status===503);
      const degraded=await request('/health',{expect:503});
      assert.deepEqual(degraded.body,{ok:false,database:'down'});
    }finally{
      await controller.query('ALTER DATABASE "'+db+'" ALLOW_CONNECTIONS true');
      await controller.end();
    }
    await waitFor(async()=> (await fetch(host+'/health')).status===200);
    assert.equal((await admin('/coupons/settlements/'+statement.id)).settlement.id,finalized.id);
  }
  for(let i=0;i<12;i++)await post('/admin/login',{user:'admin',password:'incorrect fixture password'},{expect:401});
  assert.equal((await post('/admin/login',{user:'admin',password:'incorrect fixture password'},{expect:429})).headers.get('retry-after'),'600');
  const noConfig=await exec(process.execPath,['server.cjs'],{cwd:work,env:{...environment,DATABASE_URL:''}})
    .then(()=>null,error=>error);
  assert(noConfig&&noConfig.code===1&&!noConfig.stderr.includes(environment.ADMIN_PASSWORD));
  console.log('PASS Phase 6: three roles, DAILY KST/race/late start, campaign and RPS restart, QR, ownership, redemption replay, settlement immutability, authorization and outage recovery.');
}
main().catch(error=>{console.error(error);if(serverLog)console.error(serverLog);process.exitCode=1})
  .finally(async()=>{await stop();await pool.end()});
