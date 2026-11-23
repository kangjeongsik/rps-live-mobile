const crypto=require('crypto'),fs=require('fs'),path=require('path');
const rand=()=>crypto.randomBytes(18).toString('hex');
const deviceHash=x=>crypto.createHash('sha256').update(String(x)).digest('hex');
const validDevice=x=>typeof x==='string'&&/^[a-f0-9-]{32,80}$/i.test(x);
const webpush=require('web-push');
const {approvedEndpoint}=require('./push-endpoint.cjs');

const moves=['rock','paper','scissors'];
// Lightweight Korean/English profanity masking, including common spaced/obfuscated variants.
// This is a best-effort blocklist, not a guarantee that every new slang expression is detected.
const profanityPatterns=[
 /시[\s._*~-]*발|씨[\s._*~-]*발|ㅅ[\s._*~-]*ㅂ|ㅆ[\s._*~-]*ㅂ|ㅅㅂ|ㅆㅂ|ㅂㅅ|ㅈㄹ|ㅁㅊ|ㅗㅗ/giu,
 /병[\s._*~-]*신|븅[\s._*~-]*신|개[\s._*~-]*새[\s._*~-]*끼|새[\s._*~-]*끼|미[\s._*~-]*친|지[\s._*~-]*랄|존[\s._*~-]*나|좆|좃|ㅈ[\s._*~-]*같|엿[\s._*~-]*먹|꺼[\s._*~-]*져|닥[\s._*~-]*쳐|느[\s._*~-]*금[\s._*~-]*마/giu,
 /fuck(?:ing|er|ed)?|shit(?:ty)?|bitch(?:es)?|asshole|motherfucker|dumbass/giu
];
function maskProfanity(value){let result=String(value||'').normalize('NFKC');for(const pattern of profanityPatterns)result=result.replace(pattern,'***');return result}
const beats=(a,b)=>(a==='rock'&&b==='scissors')||(a==='scissors'&&b==='paper')||(a==='paper'&&b==='rock');
// Production prize storage. DATABASE_URL is server-side only; never exposed to browsers.
const {Pool}=require('pg');
const {configuration,preflight}=require('./runtime-config.cjs');
const {record}=require('./telemetry.cjs');
const config=configuration();
const outboundPush=config.mode!=='staging'||process.env.STAGING_ALLOW_PUSH==='enabled';
// Supabase certificate chain can use a project-specific CA. Never disable TLS verification.
function prizeTlsOptions(){
 const raw=process.env.SUPABASE_DB_CA||'';
 const ca=raw.trim().replace(/\\n/g,'\n');
 if(raw&&!ca.includes('-----BEGIN CERTIFICATE-----'))throw Error('SUPABASE_DB_CA에는 PEM 형식의 CA 인증서를 넣어주세요');
 return ca?{rejectUnauthorized:true,ca,servername:new URL(process.env.DATABASE_URL).hostname}:{rejectUnauthorized:true};
}
function prizeConnectionConfig(){
 const url=new URL(process.env.DATABASE_URL);
 if(!['postgres:','postgresql:'].includes(url.protocol))throw Error('DATABASE_URL은 PostgreSQL 연결 주소여야 합니다');
 // pg connection-string SSL query params may override explicit ca; remove them.
 for(const key of ['sslmode','sslrootcert','sslcert','sslkey'])url.searchParams.delete(key);
 return {connectionString:url.toString(),ssl:config.noTLS?false:prizeTlsOptions(),max:5,connectionTimeoutMillis:3000,statement_timeout:6000,options:'-c search_path=public'};
}
const prizePool=new Pool(prizeConnectionConfig());
prizePool.on('error',error=>{
  record('database',503);
  console.error('Database pool:',error.code||error.name);
});
const PRIZE_TYPES={google:'구글 기프트카드 (1만원권)',valorant:'발로란트 선불카드 (1만원권)',kakao:'카카오 선물하기 상품권 (1만원권)',oliveyoung:'올리브영 기프트카드 (1만원권)'};
const {createEventStore}=require('./event-store.cjs');
const eventStore=createEventStore(prizePool);
const {createDaily,openForEntry,terminal}=require('./daily.cjs');
const daily=createDaily(eventStore,initialSnapshot);
const {createDailyHTTP}=require('./daily-http.cjs');
const {createDailyPush}=require('./daily-push.cjs');
const {createCampaigns}=require('./campaign-store.cjs');
const {createCampaignHTTP}=require('./campaign-http.cjs');
const {createCouponStore}=require('./coupon-store.cjs');
const {createSettlements}=require('./settlement-store.cjs');
const couponStore=createCouponStore(eventStore);
const campaigns=createCampaigns(eventStore,initialSnapshot,(row,client)=>createTournament(row,client).state(),couponStore.issue);

function campaignClock(){
  const override=process.env.RPS_CAMPAIGN_TEST_AT;
  if(override&&process.env.DATABASE_URL){
    const host=new URL(process.env.DATABASE_URL).hostname;
    const at=new Date(override);
    if(['127.0.0.1','localhost','[::1]'].includes(host)&&Number.isFinite(+at))return at;
  }
  return new Date();
}
async function sendPush(title,body,url,dbQuery){if(!outboundPush||!process.env.VAPID_PUBLIC_KEY||!process.env.VAPID_PRIVATE_KEY)return {sent:0,skipped:true};webpush.setVapidDetails(process.env.VAPID_SUBJECT||"mailto:admin@example.com",process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);const rows=await dbQuery(`select id,subscription from rps_push_subscriptions where legacy_enabled`);let sent=0;for(const x of rows){if(!approvedEndpoint(x.subscription?.endpoint))continue;try{await webpush.sendNotification(x.subscription,JSON.stringify({title,body,url}));sent++}catch(e){if([404,410].includes(e.statusCode))await dbQuery('delete from rps_push_subscriptions where id=$1',[x.id]);else console.error('Push:',e.message)}}return {sent}}

async function prizeSummary(dbQuery){
 const rows=await dbQuery('select type,count(*)::int as available from rps_prize_cards where award_id is null group by type');
 return Object.entries(PRIZE_TYPES).map(([type,name])=>({type,name,available:rows.find(x=>x.type===type)?.available||0}));
}
function publicPrize(enabled){return {enabled,types:Object.entries(PRIZE_TYPES).map(([type,name])=>({type,name,available:null}))}}
function awardResponse(row){return row?{name:PRIZE_TYPES[row.type],serial:row.serial,pin:row.pin,claimedAt:Number(row.claimed_at)}:null}
async function claimCard(client,type,p,claimEventId){
  // Serialize claims for this event and winner, including concurrent requests.
  await client.query('select pg_advisory_xact_lock(hashtext($1),hashtext($2))',[claimEventId,p.id]);
  const existing=await client.query(`select a.id,a.claimed_at,c.type,c.serial,c.pin from rps_prize_awards a
    join rps_prize_cards c on c.id=a.card_id where a.event_id=$1 and a.player_id=$2`,[claimEventId,p.id]);
  if(existing.rows.length){return {award:awardResponse(existing.rows[0]),already:true}}
  const card=await client.query(`select id,type,serial,pin from rps_prize_cards
    where type=$1 and award_id is null order by created_at,id for update skip locked limit 1`,[type]);
  if(!card.rows.length){return {error:'해당 상품의 미사용 재고가 없습니다'}}
  const id=crypto.randomUUID(),claimedAt=Date.now();
  await client.query(`insert into rps_prize_awards(id,event_id,player_id,player_name,card_id,claimed_at)
    values($1,$2,$3,$4,$5,$6)`,[id,claimEventId,p.id,p.name,card.rows[0].id,claimedAt]);
  await client.query('update rps_prize_cards set award_id=$1 where id=$2 and award_id is null',[id,card.rows[0].id]);
  
  return {award:awardResponse({...card.rows[0],claimed_at:claimedAt}),already:false};
}

function initialSnapshot(mode='nickname',duration=20,autoDelay=10,chatEnabled=true){
  return {
    game:{mode,history:[],phase:'lobby',round:0,matches:[],champion:null,deadline:0,
      duration,notice:'토너먼트 참가자를 모집 중입니다.'},
    players:[],tokens:[],codes:[],seq:0,chat:[],chatEnabled,customNotice:'',
    autoMode:false,autoDelay,autoNextAt:0,revealed:false
  };
}
function send(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj))}
const {authorized}=require('./admin-session.cjs');
function createTournament(row,client){
const eventId=row.id,joinCode=row.join_code;
const saved=row.snapshot.game?structuredClone(row.snapshot):initialSnapshot();
const {game:t}=saved;
let dailyRow=row.daily;
let campaign=row.campaign;
const players=new Map(saved.players),tokens=new Map(saved.tokens),codes=new Map(saved.codes);
let {seq,chat,chatEnabled,customNotice,autoMode,autoDelay,autoNextAt,revealed}=saved;
const dbQuery=async (sql,params=[]) => (await client.query(sql,params)).rows;
const currentJoin=()=>`/tournament/join/${joinCode}`;
let changed=!row.snapshot.game;
const markChanged=()=>{changed=true};
async function awardForChampion(){
 const rows=await dbQuery(`select a.id,a.claimed_at,a.player_name,c.type,c.serial,c.pin
 from rps_prize_awards a join rps_prize_cards c on c.id=a.card_id
 where a.event_id=$1 and a.player_id=$2 limit 1`,[eventId,t.champion]);
 return rows[0]||null;
}
function player(req){return players.get(tokens.get(deviceHash((req.headers.authorization||'').replace(/^Bearer /,''))))}
function publicPlayer(p){return p?{id:p.id,name:maskProfanity(p.name),alive:p.alive}:null}
function state(){const closedStatus=dailyRow&&['cancelled','expired'].includes(dailyRow.status)?dailyRow.status:
  campaign&&['paused','cancelled','completed'].includes(campaign.status)&&t.phase!=='finished'?campaign.status:null;
 const closed=Boolean(closedStatus);const present=[...players.values()].filter(p=>!p.left);return {players:present.map(publicPlayer),history:t.history||[],mode:t.mode,phase:closed?closedStatus:t.phase,round:t.round,deadline:closed?0:t.deadline,duration:t.duration,stage:closed?closedStatus:t.phase==='playing'?(Date.now()>=t.deadline-10000?'reveal':'select'):t.phase,notice:t.notice,customNotice,champion:publicPlayer(players.get(t.champion)),participants:present.length,alive:present.filter(p=>p.alive).length,matches:t.matches.map(m=>({id:m.id,a:publicPlayer(players.get(m.a)),b:publicPlayer(players.get(m.b)),winner:m.winner,phase:m.phase,amove:m.phase==='done'?m.amove:null,bmove:m.phase==='done'?m.bmove:null,submittedA:!!m.amove,submittedB:!!m.bmove,autoA:!!m.autoA,autoB:!!m.autoB})),chat:chat.slice(-60),chatEnabled,autoMode,autoDelay,autoNextAt,prize:publicPrize(row.prizes_enabled),joinPath:currentJoin(),eventId,roundType:stageLabel(t.matches),daily:dailyRow?{status:dailyRow.status,date:dailyRow.date_key,scheduledAt:dailyRow.scheduled_at}:null,
 campaign:campaign?{id:campaign.id,status:campaign.status,title:campaign.title,description:campaign.description,
   brand:campaign.brand,logoURL:campaign.logo_url,joinTerms:campaign.join_terms}:null}}
function stageLabel(matches){const real=matches.filter(m=>!!m.b).length;const hasByes=matches.some(m=>!m.b);return hasByes?'예선':real===1?'결승':real===2?'4강':`${real*2}강`}
function nextMatch(a,b){return {id:rand().slice(0,10),a,b,amove:null,bmove:null,winner:null,phase:b?'pending':'done',replays:0,autoA:false,autoB:false}}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=crypto.randomInt(i+1);[a[i],a[j]]=[a[j],a[i]]}return a}
function start(){
 const entrants=shuffle([...players.values()].map(p=>p.id));
 if(entrants.length<2)throw Error('2명 이상 참가해야 합니다');
 for(const p of players.values())p.alive=true;
 // A power-of-two field must always play directly: 2=>1, 4=>2, 8=>4 real matches.
 // For other counts, only the minimum necessary entrants play a preliminary round.
 const floorPower=2**Math.floor(Math.log2(entrants.length));
 const prelim=entrants.length-floorPower;
 const matches=[];
 for(let i=0;i<prelim*2;i+=2)matches.push(nextMatch(entrants[i],entrants[i+1]));
 if(prelim===0){
  for(let i=0;i<entrants.length;i+=2)matches.push(nextMatch(entrants[i],entrants[i+1]));
 }else{
  for(let i=prelim*2;i<entrants.length;i++)matches.push(nextMatch(entrants[i],null));
 }
 t.round=1;t.matches=shuffle(matches);t.history=[];t.champion=null;t.phase='ready';autoNextAt=autoMode?Date.now()+autoDelay*1000:0;
 t.notice='대진 상대가 결정되었습니다. 참가자는 대결을 준비해주세요!';
 t.deadline=0;
}
function activeMatches(){return t.matches.filter(m=>m.phase==='active')}
function openRound(){autoNextAt=0;if(t.phase!=='ready')throw Error('라운드를 시작할 수 없습니다');const pending=t.matches.filter(m=>m.phase==='pending');if(!pending.length){advance();return}const sequential=t.matches.length<=2;const selected=sequential?[pending[0]]:pending;for(const m of selected){m.phase='active';m.amove=null;m.bmove=null;m.autoA=false;m.autoB=false}t.deadline=Date.now()+t.duration*1000;t.phase='playing';t.notice='대진 상대가 결정되었습니다. 참가자는 대결을 준비해주세요!';revealed=false}
function applyDefaultRock(){if(t.phase!=='playing')return;let changed=false;for(const m of activeMatches()){if(!m.amove){m.amove='rock';m.autoA=true;changed=true}if(!m.bmove){m.bmove='rock';m.autoB=true;changed=true}}if(changed)markChanged()}
function postSystemChat(message){
 chat.push({id:rand().slice(0,12),name:'📢 관리자',message:maskProfanity(message),time:Date.now()});
 if(chat.length>100)chat.splice(0,chat.length-100);
}
function resultName(id){return maskProfanity(players.get(id)?.name||'참가자')}
function finishRound(){if(t.phase!=='playing')throw Error('진행 중인 경기가 없습니다');applyDefaultRock();let replays=0,unresolved=0;for(const m of activeMatches()){if(m.amove&&m.bmove){if(m.amove===m.bmove){m.replays++;
 postSystemChat(`🤝 ${resultName(m.a)} vs ${resultName(m.b)} · 무승부입니다. 잠시 후 재대결 진행합니다.`);
 m.phase='pending';m.amove=null;m.bmove=null;m.autoA=false;m.autoB=false;replays++;continue}m.winner=beats(m.amove,m.bmove)?m.a:m.b}else if(m.amove||m.bmove){m.winner=m.amove?m.a:m.b}else{m.phase='pending';unresolved++;continue}m.phase='done';
 postSystemChat(`🏆 ${resultName(m.a)} vs ${resultName(m.b)} · 승자: ${resultName(m.winner)} · 다음 라운드 진출!`);
 const loser=m.winner===m.a?m.b:m.a;if(players.has(loser))players.get(loser).alive=false}t.deadline=0;t.phase='ready';t.notice=unresolved?`미완료 ${unresolved}경기 · 재진행 필요`:replays?'무승부 입니다. 잠시 후 재대결 진행합니다.':'경기 종료 · 다음 경기 준비';if(t.matches.every(m=>m.phase==='done'))advance();if(t.phase==='ready'&&autoMode)autoNextAt=Date.now()+autoDelay*1000}
function advance(){t.history.push({round:t.round,roundType:stageLabel(t.matches),matches:t.matches.map(m=>({a:publicPlayer(players.get(m.a)),b:publicPlayer(players.get(m.b)),winner:m.winner,phase:m.phase,amove:m.amove,bmove:m.bmove}))});const winners=t.matches.map(m=>m.winner||(!m.b?m.a:null)).filter(Boolean);if(winners.length===1){t.champion=winners[0];t.phase='finished';autoNextAt=0;t.notice=`🏆 ${players.get(t.champion).name} 최종 우승!`;postSystemChat(`🏆 최종 우승: ${resultName(t.champion)}! 축하합니다!`);return}if(winners.length<2)throw Error('대진표에 진행할 참가자가 없습니다');t.round++;t.matches=[];for(let i=0;i<winners.length;i+=2)t.matches.push(nextMatch(winners[i],winners[i+1]||null));t.phase='ready';t.notice=`다음 라운드 준비 · ${winners.length}명 진출`}
function snapshot(){
  return {game:t,players:[...players],tokens:[...tokens],codes:[...codes],seq,chat,
    chatEnabled,customNotice,autoMode,autoDelay,autoNextAt,revealed};
}
function nextActionAt(){
  if(dailyRow&&terminal.has(dailyRow.status))return 0;
  if(campaign&&!campaigns.isActive(campaign,campaignClock()))return 0;
  if(t.phase==='playing')return revealed?t.deadline:t.deadline-10000;
  return t.phase==='ready'&&autoMode?autoNextAt:0;
}
function tick(now){
  const due=nextActionAt();
  if(!due||due>now)return;
  if(t.phase==='ready')openRound();
  else if(now>=t.deadline)finishRound();
  else{
    applyDefaultRock();
    revealed=true;
    t.notice='잠시 후 대결 결과가 공개됩니다';
  }
  markChanged();
}
async function persist(){
  if(campaign?.status==='active'&&t.phase==='finished'){
    const updated=await campaigns.finishEngine(client,campaign,campaignClock());
    campaign={...campaign,...updated};
  }
  if(dailyRow?.status==='playing'&&t.phase==='finished'){
    await setDailyStatus('finished',new Date(),'engine');
  }
  if(!changed)return row.revision;
  if(t.champion&&row.snapshot.game?.champion!==t.champion){
    const winner=players.get(t.champion);
    await dbQuery(`insert into rps_winners(id,event_id,player_id,player_name,device_hash,access_hash)
      values($1,$2,$3,$4,$5,null) on conflict(event_id,player_id) do update
      set device_hash=coalesce(rps_winners.device_hash,excluded.device_hash)`,
      [crypto.randomUUID(),eventId,winner.id,winner.name,winner.deviceHash]);
  }
  const revision=await eventStore.save(client,row,snapshot(),nextActionAt());
  if(campaign&&t.champion&&saved.game.champion!==row.snapshot.game?.champion){
    await couponStore.issueWinner(client,campaign.id,t.champion,campaignClock());
  }
  return revision;
}
async function setDailyStatus(status,now,source){
  dailyRow=await daily.transition(client,dailyRow,status,now,source);
  markChanged();
}
async function dailyAdvance(now,source='schedule'){
  if(!dailyRow||terminal.has(dailyRow.status)||dailyRow.status==='playing')return;
  if(dailyRow.status==='scheduled'){
    if(source==='schedule'&&now<dailyRow.scheduled_at)return;
    if(source==='schedule'&&now.getTime()>=dailyRow.scheduled_at.getTime()+dailyRow.wait_minutes*60000){
      await setDailyStatus('expired',now,source);
      return;
    }
    await setDailyStatus('open',now,source);
  }
  if(now>=dailyRow.wait_until){
    await setDailyStatus('expired',now,source);
    return;
  }
  if(now<dailyRow.ready_at||players.size<dailyRow.min_players)return;
  // The event runtime row is locked from eligibility through the first active match.
  start();
  autoMode=true;
  openRound();
  await setDailyStatus('playing',now,source);
}
async function dailyCommand(command,now){
  if(command==='start'&&openForEntry(dailyRow)){
    await dailyAdvance(now,'admin');
  }else if(command==='cancel'&&['scheduled','open','playing'].includes(dailyRow.status)){
    await setDailyStatus('cancelled',now,'admin');
  }else if(command==='resume'&&dailyRow.status==='cancelled'&&!dailyRow.started_at){
    if(dailyRow.date_key!==new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(now))
      return {error:'오늘 회차만 재개할 수 있습니다'};
    await setDailyStatus('scheduled',now,'admin');
    if(now>=dailyRow.scheduled_at)await dailyAdvance(now,'admin');
  }else if(!((command==='cancel'&&dailyRow.status==='cancelled')||
    (command==='start'&&dailyRow.status==='playing')||
    (command==='resume'&&openForEntry(dailyRow)))){
    return {error:'현재 회차 상태에서는 실행할 수 없습니다'};
  }
  return {status:dailyRow.status};
}
const reply=(status,obj)=>({status,obj});
async function action(req,b){
const p=player(req);
if(campaign){
  const at=campaignClock();
  if((!campaigns.isPublic(campaign)||campaign.status==='scheduled')&&!authorized(req))
    return reply(404,{error:'공개된 이벤트를 찾을 수 없습니다'});
  if((b.action==='move'&&!campaigns.isActive(campaign,at))||
    (b.action==='chat'&&!campaigns.canEnter(campaign,at)))
    return reply(409,{error:'현재 진행 중인 협찬 경기가 아닙니다'});
  if(b.action==='admin'){
    if(!authorized(req))return reply(401,{error:'관리자 로그인이 필요합니다'});
    if(['notifyRegistration','notifyStarting','addPrize','deletePrize'].includes(b.cmd))
      return reply(409,{error:'협찬 토너먼트에서는 이 기능을 사용할 수 없습니다'});
    if(['start','open','close','auto'].includes(b.cmd)&&!campaigns.isActive(campaign,at))
      return reply(409,{error:'협찬 이벤트 진행 시간에만 경기 명령을 실행할 수 있습니다'});
  }
}
if(dailyRow&&terminal.has(dailyRow.status)&&['move','chat','leave'].includes(b.action))
  return reply(409,{error:'종료되거나 중단된 DAILY 회차입니다'});
if(dailyRow&&b.action==='admin'&&authorized(req)){
  if(['notifyRegistration','notifyStarting'].includes(b.cmd))
    return reply(409,{error:'DAILY 알림은 예약 동의에 따라 자동 처리됩니다'});
  if(['start','open','close','auto','duration','removePlayer'].includes(b.cmd)&&
      (terminal.has(dailyRow.status)||(!dailyRow.started_at&&['start','open','close','auto'].includes(b.cmd))))
    return reply(409,{error:'DAILY 회차의 시작과 중단은 DAILY 관리 화면에서 제어합니다'});
}
if(b.action==='join'){if(b.joinCode!==joinCode)return reply(403,{error:'만료되거나 잘못된 대회 링크입니다. 현재 초대 링크를 이용해주세요'});if(!validDevice(b.deviceId))return reply(400,{error:'브라우저 식별정보를 확인할 수 없습니다'});const blocked=await dbQuery(`select 1 from rps_device_blocks where device_hash=$1 and (expires_at is null or expires_at>now()) limit 1`,[deviceHash(b.deviceId)]);if(blocked.length)return reply(403,{error:'운영 규칙에 따라 참가가 제한된 브라우저입니다'});
if(dailyRow){
  const hash=deviceHash(b.deviceId);
  const existing=[...players.values()].find(entry=>entry.deviceHash===hash&&!entry.left);
  if(existing){
    if(p?.id===existing.id)return reply(200,{token:req.headers.authorization.slice(7),id:p.id,name:p.name});
    return reply(409,{error:'이미 참가했습니다. 기존 참가 세션으로 접속하세요'});
  }
  if(!openForEntry(dailyRow))return reply(409,{error:'첫 라운드 참가 신청이 마감되었습니다'});
}
if(campaign){
  if(!campaigns.canEnter(campaign,campaignClock()))return reply(409,{error:'현재 참가할 수 없는 이벤트입니다'});
  const existing=[...players.values()].find(entry=>entry.deviceHash===deviceHash(b.deviceId)&&!entry.left);
  if(existing){
    if(p?.id===existing.id)return reply(200,{token:req.headers.authorization.slice(7),id:p.id,name:p.name});
    return reply(409,{error:'이미 참가했습니다. 기존 참가 세션으로 접속하세요'});
  }
}
if(t.phase!=='lobby')return reply(409,{error:'참가 신청이 마감되었습니다'});if(players.size>=200)return reply(409,{error:'최대 200명까지 참가할 수 있습니다'});let name;if(t.mode==='verified'){const code=String(b.code||'').trim().toUpperCase();if(!codes.has(code)||codes.get(code))return reply(403,{error:'사용할 수 없는 인증코드입니다'});name=String(b.nickname||'').trim();if(name.length<2||name.length>12||!/^[가-힣a-zA-Z0-9_ ]+$/.test(name))return reply(400,{error:'닉네임은 한글·영문·숫자 2~12자로 입력해주세요'});if([...players.values()].some(x=>x.name.toLowerCase()===name.toLowerCase()))return reply(409,{error:'이미 사용 중인 닉네임입니다'});codes.set(code,true)}else if(t.mode==='nickname'){name=String(b.nickname||'').trim();if(name.length<2||name.length>12||!/^[가-힣a-zA-Z0-9_ ]+$/.test(name))return reply(400,{error:'닉네임은 한글·영문·숫자 2~12자로 입력해주세요'});if(b.agree!==true)return reply(400,{error:'참가 안내에 동의해야 합니다'});if([...players.values()].some(x=>x.name.toLowerCase()===name.toLowerCase()))return reply(409,{error:'이미 사용 중인 닉네임입니다'})}else name=`PLAYER ${String(seq+1).padStart(3,'0')}`;const id=`P${++seq}`,token=rand();players.set(id,{id,name,alive:true,deviceHash:deviceHash(b.deviceId)});tokens.set(deviceHash(token),id);if(dailyRow)await daily.participant(client,dailyRow,deviceHash(b.deviceId),id,new Date());if(campaign)await campaigns.enroll(client,campaign,deviceHash(b.deviceId),name,campaignClock(),id);markChanged();return reply(200,{token,id,name})}
if(b.action==='config'){return reply(200,{joinPath:currentJoin(),vapidPublicKey:process.env.VAPID_PUBLIC_KEY||'',pushAvailable:!!(process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY)})}
if(b.action==='pushSubscribe'){
  if(!validDevice(b.deviceId))return reply(400,{error:'기기 ID가 없습니다'});
  const sub=b.subscription;
  if(!sub||!approvedEndpoint(sub.endpoint)||JSON.stringify(sub).length>4096)
    return reply(400,{error:'푸시 구독 정보가 올바르지 않습니다'});
  await dbQuery(`insert into rps_push_subscriptions(id,device_hash,subscription,legacy_enabled) values($1,$2,$3,$4)
    on conflict(device_hash) do update set subscription=$3,
    legacy_enabled=rps_push_subscriptions.legacy_enabled OR excluded.legacy_enabled`,
  [crypto.randomUUID(),deviceHash(b.deviceId),sub,b.channel!=='daily']);
  return reply(200,{ok:true});
}
if(b.action==='pushUnsubscribe'){
  if(!validDevice(b.deviceId))return reply(400,{error:'기기 ID가 없습니다'});
  const hash=deviceHash(b.deviceId);
  const prefs=await dbQuery('select daily_start from daily_notification_preferences where device_hash=$1',[hash]);
  const keepSubscription=prefs[0]?.daily_start===true;
  if(keepSubscription)await dbQuery('update rps_push_subscriptions set legacy_enabled=false where device_hash=$1',[hash]);
  else await dbQuery('delete from rps_push_subscriptions where device_hash=$1',[hash]);
  return reply(200,{ok:true,keepSubscription});
}
if(b.action==='pushStatus'){
  if(!validDevice(b.deviceId))return reply(200,{enabled:false});
  const rows=await dbQuery('select 1 from rps_push_subscriptions where device_hash=$1 and legacy_enabled',[deviceHash(b.deviceId)]);
  return reply(200,{enabled:!!rows.length});
}
if(b.action==='winnerAccess'){const access=String(b.access||'');if(!/^[a-f0-9]{64}$/.test(access))return reply(403,{error:'수령 링크가 올바르지 않습니다'});const rows=await dbQuery(`select w.id,w.event_id,w.player_name,w.player_id,a.claimed_at,c.type,c.serial,c.pin from rps_winners w left join rps_prize_awards a on a.event_id=w.event_id and a.player_id=w.player_id left join rps_prize_cards c on c.id=a.card_id where w.access_hash=$1`,[deviceHash(access)]);if(!rows.length)return reply(404,{error:'우승 기록을 찾을 수 없습니다'});const x=rows[0];return reply(200,{winner:x.player_name,award:x.type?awardResponse(x):null})}
if(b.action==='winnerClaim'){const access=String(b.access||'');const rows=await dbQuery('select event_id,player_id,player_name from rps_winners where access_hash=$1',[deviceHash(access)]);if(!rows.length)return reply(403,{error:'우승 수령 링크가 올바르지 않습니다'});const w=rows[0];const type=String(b.type||'');if(!PRIZE_TYPES[type])return reply(400,{error:'상품 종류를 선택하세요'});const result=await claimCard(client,type,{id:w.player_id,name:w.player_name},w.event_id);return reply(result.error?409:200,result)}
if(b.action==='inquiry'){const content=String(b.message||'').trim();const category=String(b.category||'other');if(!['prize','code','bug','idea','other'].includes(category)||content.length<2||content.length>1000)return reply(400,{error:'문의 유형과 내용(2~1000자)을 확인하세요'});let owner=null;const access=String(b.access||'');if(/^[a-f0-9]{64}$/.test(access)){const r=await dbQuery('select event_id,player_id,player_name from rps_winners where access_hash=$1',[deviceHash(access)]);owner=r[0]||null}if(!owner&&!validDevice(b.deviceId))return reply(400,{error:'브라우저 식별정보가 없습니다'});const ownerHash=owner?deviceHash(access):deviceHash(b.deviceId);const id=crypto.randomUUID();await dbQuery(`insert into rps_inquiries(id,owner_hash,event_id,player_name,category,message) values($1,$2,$3,$4,$5,$6)`,[id,ownerHash,owner?.event_id||eventId,owner?.player_name||p?.name||'참가자',category,content]);return reply(200,{ok:true,id})}
if(b.action==='myInquiries'){const access=String(b.access||'');const ownerHash=/^[a-f0-9]{64}$/.test(access)?deviceHash(access):validDevice(b.deviceId)?deviceHash(b.deviceId):null;if(!ownerHash)return reply(400,{error:'접근 정보가 없습니다'});const rows=await dbQuery(`select id,category,message,reply,created_at from rps_inquiries where owner_hash=$1 order by created_at desc limit 30`,[ownerHash]);return reply(200,{inquiries:rows})}
if(b.action==='winnerHistory'){if(!authorized(req))return reply(401,{error:'관리자 인증이 필요합니다'});const rows=await dbQuery(`select w.event_id,w.player_id,w.player_name,w.device_hash,w.created_at,e.created_at as event_created_at,a.claimed_at,c.type as prize_type,c.serial as prize_serial,(select count(*)::int from rps_winners w2 where w2.device_hash=w.device_hash and w.device_hash is not null) as wins from rps_winners w left join rps_events e on e.id=w.event_id left join rps_prize_awards a on a.event_id=w.event_id and a.player_id=w.player_id left join rps_prize_cards c on c.id=a.card_id order by w.created_at desc limit 300`);return reply(200,{winners:rows.map(x=>({...x,deviceId:x.device_hash?'…'+x.device_hash.slice(-10):'기록 없음',device_hash:undefined,prizeName:x.prize_type?PRIZE_TYPES[x.prize_type]:null}))})}
if(b.action==='adminExtra'){if(!authorized(req))return reply(401,{error:'관리자 인증이 필요합니다'});const blocks=await dbQuery(`select device_hash,reason,expires_at,created_at from rps_device_blocks order by created_at desc limit 100`);const inquiries=await dbQuery(`select id,player_name,category,message,reply,created_at from rps_inquiries order by created_at desc limit 100`);return reply(200,{blocks,inquiries,joinPath:currentJoin()})}
if(b.action==='resume')return p&&!p.left?reply(200,{id:p.id,name:p.name,alive:p.alive}):reply(401,{error:'다시 참가해주세요'});
if(b.action==='leave'){
 if(!p)return reply(401,{error:'참가 정보를 확인할 수 없습니다'});
 // Before draw: cancel registration. After draw: mark absent from live roster,
 // but retain match history/bracket records and revoke the token.
 if(t.phase==='lobby')players.delete(p.id);
 else p.left=true;
 for(const [token,pid] of tokens){if(pid===p.id)tokens.delete(token)}
 markChanged();return reply(200,{ok:true});
}

if(b.action==='winnerLink'){if(!row.prizes_enabled||!p||p.left||t.phase!=='finished'||p.id!==t.champion)return reply(403,{error:'우승자만 가능합니다'});let access=p.winnerAccess;if(!access){access=crypto.randomBytes(32).toString('hex');await dbQuery(`insert into rps_winners(id,event_id,player_id,player_name,device_hash,access_hash) values($1,$2,$3,$4,$5,$6) on conflict(event_id,player_id) do update set access_hash=coalesce(rps_winners.access_hash,excluded.access_hash),device_hash=coalesce(rps_winners.device_hash,excluded.device_hash)`,[crypto.randomUUID(),eventId,p.id,p.name,p.deviceHash,deviceHash(access)]);p.winnerAccess=access;markChanged()}return reply(200,{url:'/tournament/winner/'+access})}
if(b.action==='prizeStatus'){
 if(!row.prizes_enabled||!p||p.left||t.phase!=='finished'||p.id!==t.champion)return reply(403,{error:'최종 우승자만 상품을 확인할 수 있습니다'});
 const award=await awardForChampion();
 return reply(200,{types:await prizeSummary(dbQuery),award:awardResponse(award)});
}
if(b.action==='claimPrize'){
 if(!row.prizes_enabled||!p||p.left||t.phase!=='finished'||p.id!==t.champion)return reply(403,{error:'최종 우승자만 수령할 수 있습니다'});
 const type=String(b.type||'');if(!PRIZE_TYPES[type])return reply(400,{error:'상품을 선택하세요'});
 const result=await claimCard(client,type,p,eventId);
 if(result.error)return reply(409,result);
 markChanged();return reply(200,result);
}
if(b.action==='move'){if(!p||p.left||!p.alive)return reply(403,{error:'경기 참가자가 아닙니다'});if(t.phase!=='playing'||Date.now()>=t.deadline-10000)return reply(409,{error:'선택 가능 시간이 종료됐습니다'});if(!moves.includes(b.move))return reply(400,{error:'잘못된 선택입니다'});const m=activeMatches().find(x=>x.a===p.id||x.b===p.id);if(!m)return reply(403,{error:'현재 경기가 없습니다'});if(m.a===p.id)m.amove=b.move;else m.bmove=b.move;if(campaign)p.submittedMove=true;markChanged();return reply(200,{ok:true})}
if(b.action==='chat'){if(!p||p.left||!chatEnabled)return reply(403,{error:'채팅을 사용할 수 없습니다'});const msg=String(b.message||'').trim();if(!msg||msg.length>80||/https?:|@|\d[\d -]{7,}\d/i.test(msg))return reply(400,{error:'메시지 내용을 확인해주세요'});const now=Date.now();if(p.lastChat&&now-p.lastChat<2500)return reply(429,{error:'잠시 후 다시 보내주세요'});p.lastChat=now;chat.push({id:rand().slice(0,12),name:maskProfanity(p.name),message:maskProfanity(msg),time:now});if(chat.length>100)chat.shift();markChanged();return reply(200,{ok:true})}
if(b.action==='prizeAdmin'){
 if(!authorized(req))return reply(401,{error:'관리자 인증이 필요합니다'});
 const inventory=await dbQuery(`select c.id,c.type,c.serial,c.award_id,a.player_name,a.claimed_at,a.event_id
 from rps_prize_cards c left join rps_prize_awards a on a.id=c.award_id order by c.created_at desc`);
 return reply(200,{inventory:inventory.map(x=>({id:x.id,type:x.type,name:PRIZE_TYPES[x.type],serial:x.serial,status:x.award_id?'지급완료':'미사용',award:x.award_id?{playerName:x.player_name,claimedAt:Number(x.claimed_at),eventId:x.event_id}:null})),awards:[]});
}
if(b.action==='admin'){if(!authorized(req))return reply(401,{error:'로그인이 필요합니다'});try{if(b.cmd==='addPrize'){
 const type=String(b.type||'');const serial=String(b.serial||'').trim();const pin=String(b.pin||'').trim();
 if(!PRIZE_TYPES[type]||!serial||!pin||serial.length>160||pin.length>160)throw Error('상품 종류·일련번호·PIN을 확인하세요');
 try{await dbQuery('insert into rps_prize_cards(id,type,serial,pin) values($1,$2,$3,$4)',[crypto.randomUUID(),type,serial,pin])}
 catch(e){if(e.code==='23505')throw Error('이미 등록된 일련번호입니다');throw e}
 return reply(200,{ok:true});
 }else if(b.cmd==='deletePrize'){
 const rows=await dbQuery('delete from rps_prize_cards where id=$1 and award_id is null returning id',[String(b.id||'')]);
 if(!rows.length)throw Error('미사용 상품만 삭제할 수 있습니다');return reply(200,{ok:true});
 }else if(b.cmd==='blockPlayer'){const target=players.get(String(b.playerId||''));if(!target?.deviceHash)throw Error('차단할 참가자 기기 정보가 없습니다');const days=Number(b.days);if(![7,30,0].includes(days))throw Error('차단 기간 오류');await dbQuery(`insert into rps_device_blocks(device_hash,reason,expires_at) values($1,$2,$3) on conflict(device_hash) do update set reason=$2,expires_at=$3`,[target.deviceHash,String(b.reason||'운영 규칙 위반').slice(0,100),days?new Date(Date.now()+days*86400000):null]);if(t.phase==='lobby'){players.delete(target.id);for(const [tok,pid] of tokens)if(pid===target.id)tokens.delete(tok)}
}else if(b.cmd==='unblock'){await dbQuery('delete from rps_device_blocks where device_hash=$1',[String(b.hash||'')]);
}else if(b.cmd==='replyInquiry'){await dbQuery('update rps_inquiries set reply=$2 where id=$1',[String(b.id||''),String(b.reply||'').slice(0,1000)]);
}else if(b.cmd==='notifyRegistration'){const result=await sendPush('✊ 가위바위보 LIVE','새로운 대회 참가 신청이 시작됐습니다!',currentJoin(),dbQuery);return reply(200,{ok:true,...result});
}else if(b.cmd==='notifyStarting'){const result=await sendPush('⏰ 가위바위보 LIVE','대회 시작 10분 전입니다. 참가 화면으로 이동하세요.',currentJoin(),dbQuery);return reply(200,{ok:true,...result});
}else if(b.cmd==='codes'){if(t.phase!=='lobby'||t.mode!=='verified')throw Error('인증코드 모드 대기 중에만 발급 가능합니다');const count=Number(b.count||10);if(!Number.isInteger(count)||count<1||count>200||codes.size+count>200)throw Error('발급 수량은 최대 200개입니다');const issued=[];for(let i=0;i<count;i++){let code;do{code=crypto.randomBytes(5).toString('hex').toUpperCase()}while(codes.has(code));codes.set(code,false);issued.push(code)}markChanged();return reply(200,{ok:true,codes:issued})}else if(b.cmd==='start'){if(t.phase!=='lobby')throw Error('이미 시작했습니다');start()}else if(b.cmd==='auto'){
 const enabled=b.enabled===true;
 const delay=Number(b.delay);
 if(!Number.isInteger(delay)||delay<3||delay>120)throw Error('자동 진행 대기 시간은 3~120초로 설정하세요');
 if(enabled&&t.phase==='lobby')throw Error('대진 추첨 후 자동 진행을 켜주세요');
 autoMode=enabled;autoDelay=delay;autoNextAt=enabled&&t.phase==='ready'?Date.now()+autoDelay*1000:0;
 }else if(b.cmd==='open'){openRound()}else if(b.cmd==='close'){finishRound()}else if(b.cmd==='duration'){if(t.phase==='playing')throw Error('경기 진행 중입니다');const d=Number(b.duration);if(!Number.isInteger(d)||d<15||d>120)throw Error('15~120초 사이로 설정하세요');t.duration=d}else if(b.cmd==='removePlayer'){if(t.phase!=='lobby')throw Error('참가자 제외는 대회 시작 전만 가능합니다');const id=String(b.playerId||'');if(!players.has(id))throw Error('참가자를 찾을 수 없습니다');players.delete(id);for(const [token,pid] of tokens){if(pid===id)tokens.delete(token)}}else if(b.cmd==='deleteChat'){const id=String(b.messageId||'');const index=chat.findIndex(m=>m.id===id);if(index<0)throw Error('메시지를 찾을 수 없습니다');chat.splice(index,1)}else if(b.cmd==='adminChat'){if(!chatEnabled)throw Error('채팅이 꺼져 있습니다');const message=String(b.message||'').trim();if(!message||message.length>80)throw Error('관리자 메시지는 1~80자로 입력하세요');chat.push({id:rand().slice(0,12),name:'📢 관리자',message:maskProfanity(message),time:Date.now()});if(chat.length>100)chat.shift()}else if(b.cmd==='setNotice'){const message=String(b.message||'').trim();if(message.length>140)throw Error('안내문은 140자 이내로 입력하세요');customNotice=maskProfanity(message)}else if(b.cmd==='toggleChat'){chatEnabled=!chatEnabled}else if(b.cmd==='clearChat'){chat=[]}else throw Error('잘못된 명령');markChanged();return reply(200,{ok:true})}catch(e){if(e.code)throw e;return reply(409,{error:e.message})}}
return reply(400,{error:'알 수 없는 요청'});
}
return {state,action,persist,tick,dailyAdvance,dailyCommand,hasChanges:()=>changed,
  replacement:(mode)=>initialSnapshot(mode,t.duration,autoDelay,chatEnabled)};
}

const streams=new Set();
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const validJoinCode=/^[A-Za-z0-9_-]{1,128}$/;
const tournamentMode=mode=>['nickname','anonymous','verified'].includes(mode);
const defaultSelector=selector=>!selector.joinCode&&!selector.eventId;

function eventSelector(url){
  const eventId=url.searchParams.get('event');
  const joinCode=url.searchParams.get('join');
  if(eventId!==null&&(!uuid.test(eventId)||joinCode!==null))return null;
  if(joinCode!==null&&!validJoinCode.test(joinCode))return null;
  return {eventId,joinCode};
}

function writeState(stream,row,state,revision){
  if(stream.eventId===row.id&&stream.revision!==null&&BigInt(stream.revision)>=BigInt(revision))return;
  stream.eventId=row.id;
  stream.revision=revision;
  stream.res.write('data: '+JSON.stringify(state)+'\n\n');
}

function publish(update){
  if(!update)return;
  const {row,state,revision,previous}=update;
  for(const stream of streams){
    if(previous&&stream.eventId===previous){
      if(stream.default){writeState(stream,row,state,revision)}
      else{
        stream.res.end('event: retired\ndata: '+JSON.stringify({joinPath:state.joinPath})+'\n\n');
        streams.delete(stream);
      }
    }else if(stream.eventId===row.id){
      writeState(stream,row,state,revision);
    }
  }
}

async function loadEvent(client,selector){
  const row=await eventStore.load(client,selector);
  if(row){
    row.daily=await daily.occurrence(client,row.id);
    row.campaign=await campaigns.findByEvent(client,row.id);
  }
  return row;
}

async function openStream(req,res,selector){
  const result=await eventStore.transaction(async client=>{
    const row=await loadEvent(client,selector);
    if(!row)return {status:404,obj:{error:'대회를 찾을 수 없습니다'}};
    if(row.campaign&&(!campaigns.isPublic(row.campaign)||row.campaign.status==='scheduled')&&!authorized(req))
      return {status:404,obj:{error:'공개된 이벤트를 찾을 수 없습니다'}};
    if(res.destroyed)return null;
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform',
      'Connection':'keep-alive','X-Accel-Buffering':'no'});
    if(row.retired_at){
      const joinPath=row.replacement_code?'/tournament/join/'+row.replacement_code:null;
      res.end('event: retired\ndata: '+JSON.stringify({joinPath})+'\n\n');
      return null;
    }
    const stream={res,eventId:row.id,revision:null,default:defaultSelector(selector)};
    streams.add(stream);
    res.once('close',()=>streams.delete(stream));
    writeState(stream,row,createTournament(row,client).state(),row.revision);
    return null;
  });
  if(result)send(res,result.status,result.obj);
}

async function runAction(req,res,selector,body){
  const result=await eventStore.transaction(async client=>{
    const row=await loadEvent(client,selector);
    if(!row)return {status:404,obj:{error:'대회를 찾을 수 없습니다'}};
    const b=body;
    if(row.campaign&&(!campaigns.isPublic(row.campaign)||row.campaign.status==='scheduled')&&!authorized(req))
      return {status:404,obj:{error:'공개된 이벤트를 찾을 수 없습니다'}};
    if(row.retired_at)return {status:410,obj:{error:'종료된 대회입니다'}};
    if(b.expectedEventId&&b.expectedEventId!==row.id){
      return {status:409,obj:{error:'대회가 변경되었습니다. 화면을 새로고침하세요'}};
    }
    const game=createTournament(row,client);
    if(b.action==='admin'&&['createEvent','reset'].includes(b.cmd)){
      if(!authorized(req))return {status:401,obj:{error:'로그인이 필요합니다'}};
      if(!tournamentMode(b.mode))return {status:400,obj:{error:'모드를 선택하세요'}};
      const snapshot=game.replacement(b.mode);
      if(b.cmd==='createEvent'){
        const next=await eventStore.create(client,snapshot);
        if(b.listed===true&&b.mode!=='verified'){
          await client.query('UPDATE rps_event_runtime SET listed=true WHERE event_id=$1',[next.id]);
        }
        return {status:201,obj:{eventId:next.id,joinPath:'/tournament/join/'+next.join_code}};
      }
      if(!defaultSelector(selector)){
        return {status:409,obj:{error:'기본 대회만 교체할 수 있습니다. 새 대회를 만들어 주세요'}};
      }
      const next=await eventStore.replaceDefault(client,row,snapshot);
      const state=createTournament(next,client).state();
      return {status:200,obj:{ok:true,eventId:next.id},pushPath:state.joinPath,
        update:{row:next,state,revision:next.revision,previous:row.id}};
    }
    const reply=await game.action(req,b);
    if(reply.status>=400)return reply;
    const changed=game.hasChanges();
    const revision=await game.persist();
    if(changed)reply.update={row,state:game.state(),revision};
    return reply;
  });
  publish(result.update);
  send(res,result.status,result.obj);
  if(result.pushPath){
    const query=async (sql,params)=>(await prizePool.query(sql,params)).rows;
    sendPush('✊ 가위바위보 LIVE','새로운 대회 참가 신청이 시작됐습니다!',result.pushPath,query)
      .catch(error=>console.error('Tournament push:',error.code||error.name));
  }
}

function routeError(res,error){
  console.error('Tournament:',error.code||error.name);
  if(res.headersSent){res.end();return}
  send(res,503,{error:'대회 데이터베이스 연결 및 Phase 1 마이그레이션 상태를 확인하세요'});
}

function readBody(req,res,callback,limit=8192){
  const chunks=[];
  let size=0;
  req.on('data',chunk=>{
    size+=chunk.length;
    if(size<=limit)chunks.push(chunk);
    else if(!res.headersSent)send(res,413,{error:'요청 크기가 너무 큽니다'});
  });
  req.on('end',()=>{
    if(size>limit)return;
    let body;
    try{
      body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!body||typeof body!=='object'||Array.isArray(body))throw Error();
    }catch{
      send(res,400,{error:'잘못된 요청'});
      return;
    }
    callback(body).catch(error=>routeError(res,error));
  });
}

function serve(res,file,type='text/html; charset=utf-8'){
  res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});
  res.end(fs.readFileSync(path.join(__dirname,file)));
}

function handle(req,res,url){
  const pathname=url.pathname;
  if(couponHTTP(req,res,url))return true;
  if(advertisingHTTP(req,res,url))return true;
  if(campaignHTTP(req,res,url))return true;
  if(dailyHTTP(req,res,url))return true;
  if(pathname!=='/tournament'&&!pathname.startsWith('/tournament/'))return false;
  if(req.method==='GET'){
    if(pathname==='/tournament/sw.js'){
      res.setHeader('Service-Worker-Allowed','/tournament/');
      serve(res,'sw.js','application/javascript');
    }else if(pathname.startsWith('/tournament/winner/')){
      serve(res,'winner.html');
    }else if(pathname==='/tournament'||pathname.startsWith('/tournament/join/')){
      serve(res,'tournament.html');
    }else if(pathname==='/tournament/admin'){
      if(authorized(req))serve(res,'tournament-admin.html');
      else{
        res.writeHead(302,{Location:'/admin-login?next='+encodeURIComponent(pathname+url.search),
          'Cache-Control':'no-store'});
        res.end();
      }
    }else if(pathname==='/tournament/events'){
      const selector=eventSelector(url);
      if(selector)openStream(req,res,selector).catch(error=>routeError(res,error));
      else send(res,400,{error:'잘못된 대회 식별자입니다'});
    }else send(res,404,{error:'찾을 수 없습니다'});
  }else if(req.method==='POST'&&pathname==='/tournament/api'){
    const selector=eventSelector(url);
    if(selector)readBody(req,res,body=>runAction(req,res,selector,body));
    else send(res,400,{error:'잘못된 대회 식별자입니다'});
  }else send(res,404,{error:'찾을 수 없습니다'});
  return true;
}

setInterval(()=>{
  for(const {res} of streams)res.write(': ping\n\n');
},25000).unref();

let polling=false;
let lastPollError;
async function advanceDueEvents(){
  if(!prizePool||polling)return;
  polling=true;
  try{
    const due=await eventStore.dueEvents();
    for(const {event_id:eventId} of due){
      const update=await eventStore.transaction(async client=>{
        const row=await loadEvent(client,{eventId});
        if(!row||row.retired_at||row.daily?.status==='cancelled'||
          (row.campaign&&!campaigns.isActive(row.campaign,campaignClock())))return null;
        const game=createTournament(row,client);
        game.tick(Date.now());
        if(!game.hasChanges())return null;
        const revision=await game.persist();
        return {row,state:game.state(),revision};
      }).catch(error=>{
        console.error('Tournament event advance:',eventId,error.code||error.name);
        return null;
      });
      publish(update);
    }
    lastPollError=undefined;
  }catch(error){
    const code=error.code||error.name;
    if(code!==lastPollError)console.error('Tournament scheduler:',code);
    lastPollError=code;
  }finally{
    polling=false;
  }
}


async function dailyMutation(eventId,work){
  const result=await eventStore.transaction(async client=>{
    const row=await loadEvent(client,{eventId});
    if(!row?.daily)return {status:404,obj:{error:'DAILY 회차를 찾을 수 없습니다'}};
    const game=createTournament(row,client);
    const response=await work(client,row.daily,game);
    if(game.hasChanges()){
      const revision=await game.persist();
      response.update={row,state:game.state(),revision};
    }
    return response;
  });
  publish(result.update);
  return result;
}
async function runDailySchedule(now=new Date()){
  try{
    const due=await daily.recover(now);
    for(const id of due){
      await dailyMutation(id,async (_client,_row,game)=>{
        await game.dailyAdvance(now);
        return {status:200};
      });
    }
    record('dailySchedule',200,new Date(),due.length);
    return {processed:due.length};
  }catch(error){record('dailySchedule',503);throw error}

}
const {createAdvertising}=require('./advertising-store.cjs');
const {createAdvertisingHTTP}=require('./advertising-http.cjs');
const {createCouponHTTP}=require('./coupon-http.cjs');
const couponHTTP=createCouponHTTP({store:couponStore,settlements:createSettlements(couponStore),
  authorized,send,serve,readBody,validDevice,deviceHash,clock:campaignClock});
const advertisingHTTP=createAdvertisingHTTP({service:createAdvertising(campaigns),
  authorized,send,serve,readBody,routeError});
const campaignHTTP=createCampaignHTTP({campaigns,publish,authorized,send,serve,readBody,
  deviceHash,validDevice,routeError,clock:campaignClock});
const dailyHTTP=createDailyHTTP({store:eventStore,daily,dailyMutation,runDailySchedule,
  authorized,send,serve,readBody,deviceHash,validDevice,routeError,
  vapidPublicKey:process.env.VAPID_PUBLIC_KEY||'',schedulerToken:process.env.DAILY_SCHEDULER_TOKEN});
const dailyPush=createDailyPush({
  store:eventStore,
  sender:outboundPush&&process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY
    ? (subscription,payload)=>{
      webpush.setVapidDetails(process.env.VAPID_SUBJECT||'mailto:admin@example.com',
        process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);
      if(!approvedEndpoint(subscription?.endpoint))throw Object.assign(Error('Unsupported push endpoint'),{statusCode:410});
      return webpush.sendNotification(subscription,JSON.stringify(payload),{TTL:120,timeout:8000});
    }:null
});
let campaignRunning=false;
let lastCampaignError;
async function runCampaignSchedule(at=campaignClock()){return campaigns.advance(at,publish)}
async function pollCampaigns(){
  if(!prizePool||campaignRunning)return;
  campaignRunning=true;
  try{
    await runCampaignSchedule();
    record('campaignSchedule',200);
    lastCampaignError=undefined;
  }catch(error){
    const code=error.code||error.name;
    record('campaignSchedule',503);
    if(code!==lastCampaignError)console.error('Campaign scheduler:',code);
    lastCampaignError=code;
  }finally{campaignRunning=false}
}
let dailyRunning=false;
let lastDailyError;
async function pollDaily(){
  if(!prizePool||dailyRunning)return;
  dailyRunning=true;
  try{
    await runDailySchedule();
    lastDailyError=undefined;
  }catch(error){
    const code=error.code||error.name;
    if(code!==lastDailyError)console.error('DAILY scheduler:',code);
    lastDailyError=code;
  }finally{dailyRunning=false}
}
let pushRunning=false;
async function pollDailyPush(){
  if(!prizePool||pushRunning)return;
  pushRunning=true;
  try{await dailyPush.deliver(new Date())}
  catch(error){console.error('DAILY push:',error.code||error.name)}
  finally{pushRunning=false}
}
function startBackground(){
  setInterval(advanceDueEvents,500).unref();
  setInterval(pollDaily,1000).unref();
  setInterval(pollCampaigns,1000).unref();
  setImmediate(pollCampaigns);
  if(process.env.DAILY_PUSH_DELIVERY==='enabled'&&dailyPush.enabled)
    setInterval(pollDailyPush,1500).unref();
  setImmediate(pollDaily);
}
async function initialize(){
  await preflight(prizePool,config);
  if(process.env.VAPID_PUBLIC_KEY){
    try{webpush.setVapidDetails(process.env.VAPID_SUBJECT||'mailto:admin@example.com',
      process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY)}
    catch{throw Object.assign(Error('VAPID 키 또는 발신자 설정을 확인하세요'),{configuration:true})}
  }
}
let lastProbe=null, pendingProbe=null;
function databaseHealthy(){
  if(lastProbe&&Date.now()-lastProbe.at<800)return Promise.resolve(lastProbe.ok);
  if(!pendingProbe){
    pendingProbe=prizePool.query({text:'SELECT 1',query_timeout:1800}).then(()=>true,()=>false).then(ok=>{
      if(!lastProbe||lastProbe.ok!==ok)record('database',ok?200:503);
      lastProbe={at:Date.now(),ok};
      pendingProbe=null;
      return ok;
    });
  }
  return pendingProbe;
}
module.exports={handle,runDailySchedule,runCampaignSchedule,initialize,startBackground,databaseHealthy,close:()=>prizePool.end()};
