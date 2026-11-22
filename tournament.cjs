const crypto=require('crypto'),fs=require('fs'),path=require('path');
const rand=()=>crypto.randomBytes(18).toString('hex');
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
const players=new Map(),tokens=new Map(),codes=new Map(),streams=new Set();
let seq=0,version=0,chat=[],chatEnabled=true,customNotice='';
let autoMode=false,autoDelay=10,autoNextAt=0;
let t={mode:'nickname',history:[],phase:'lobby',round:0,matches:[],champion:null,deadline:0,duration:20,notice:'토너먼트 참가자를 모집 중입니다.'};
function send(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj))}
const {isAdminSession}=require('./admin-session.cjs');
function authorized(req){if(isAdminSession(req))return true;const h=req.headers.authorization||'';if(!h.startsWith('Basic '))return false;let decoded;try{decoded=Buffer.from(h.slice(6),'base64').toString('utf8')}catch{return false}const idx=decoded.indexOf(':');if(idx<0)return false;const user=Buffer.from(decoded.slice(0,idx)),expectUser=Buffer.from(process.env.ADMIN_USER||'admin'),pass=Buffer.from(decoded.slice(idx+1)),expectPass=Buffer.from(process.env.ADMIN_PASSWORD||'');return user.length===expectUser.length&&pass.length===expectPass.length&&crypto.timingSafeEqual(user,expectUser)&&crypto.timingSafeEqual(pass,expectPass)}
function deny(res){res.writeHead(401,{'WWW-Authenticate':'Basic realm="RPS Tournament Admin"','Cache-Control':'no-store'});res.end('관리자 인증이 필요합니다')}
function player(req){return players.get(tokens.get((req.headers.authorization||'').replace(/^Bearer /,'')))}
function publicPlayer(p){return p?{id:p.id,name:maskProfanity(p.name),alive:p.alive}:null}
function state(){const present=[...players.values()].filter(p=>!p.left);return {players:present.map(publicPlayer),history:t.history||[],mode:t.mode,phase:t.phase,round:t.round,deadline:t.deadline,duration:t.duration,stage:t.phase==='playing'?(Date.now()>=t.deadline-10000?'reveal':'select'):t.phase,notice:t.notice,customNotice,champion:publicPlayer(players.get(t.champion)),participants:present.length,alive:present.filter(p=>p.alive).length,matches:t.matches.map(m=>({id:m.id,a:publicPlayer(players.get(m.a)),b:publicPlayer(players.get(m.b)),winner:m.winner,phase:m.phase,amove:m.phase==='done'?m.amove:null,bmove:m.phase==='done'?m.bmove:null,submittedA:!!m.amove,submittedB:!!m.bmove,autoA:!!m.autoA,autoB:!!m.autoB})),chat:chat.slice(-60),chatEnabled,autoMode,autoDelay,autoNextAt,roundType:stageLabel(t.matches)}}
function broadcast(){const line='data: '+JSON.stringify(state())+'\n\n';for(const s of streams){try{s.write(line)}catch{streams.delete(s)}}}
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
function openRound(){autoNextAt=0;if(t.phase!=='ready')throw Error('라운드를 시작할 수 없습니다');const pending=t.matches.filter(m=>m.phase==='pending');if(!pending.length){advance();return}const sequential=t.matches.length<=2;const selected=sequential?[pending[0]]:pending;for(const m of selected){m.phase='active';m.amove=null;m.bmove=null;m.autoA=false;m.autoB=false}t.deadline=Date.now()+t.duration*1000;t.phase='playing';t.notice='대진 상대가 결정되었습니다. 참가자는 대결을 준비해주세요!';const epoch=++version;setTimeout(()=>{if(epoch===version&&t.phase==='playing'){applyDefaultRock();t.notice='잠시 후 대결 결과가 공개됩니다';broadcast()}},Math.max(0,t.duration-10)*1000+30);setTimeout(()=>{if(epoch===version&&t.phase==='playing'){finishRound();broadcast()}},t.duration*1000+120)}
function applyDefaultRock(){if(t.phase!=='playing')return;let changed=false;for(const m of activeMatches()){if(!m.amove){m.amove='rock';m.autoA=true;changed=true}if(!m.bmove){m.bmove='rock';m.autoB=true;changed=true}}if(changed)broadcast()}
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
function reset(mode){autoMode=false;autoNextAt=0;customNotice='';++version;players.clear();tokens.clear();chat=[];seq=0;codes.clear();t={mode,history:[],phase:'lobby',round:0,matches:[],champion:null,deadline:0,duration:t.duration,notice:'새 토너먼트 참가 신청 중입니다.'}}
function readBody(req,res,cb){let raw='';req.on('data',chunk=>{raw+=chunk;if(raw.length>8192)req.destroy()});req.on('end',()=>{try{cb(JSON.parse(raw))}catch(e){if(!res.writableEnded)send(res,400,{error:e.message||'잘못된 요청'})}})}
function handle(req,res,u){if(!u.pathname.startsWith('/tournament'))return false;
if(req.method==='GET'&&u.pathname==='/tournament/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write('data: '+JSON.stringify(state())+'\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return true}
if(req.method==='GET'&&u.pathname==='/tournament/admin'&&!authorized(req)){res.writeHead(302,{Location:'/admin-login?next=%2Ftournament%2Fadmin','Cache-Control':'no-store'});res.end();return true}
if(req.method==='GET'&&['/tournament','/tournament/admin'].includes(u.pathname)){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(__dirname,u.pathname==='/tournament'?'tournament.html':'tournament-admin.html')));return true}
if(req.method!=='POST'||u.pathname!=='/tournament/api'){send(res,404,{error:'찾을 수 없습니다'});return true}
readBody(req,res,b=>{const p=player(req);if(b.action==='join'){if(t.phase!=='lobby')return send(res,409,{error:'참가 신청이 마감되었습니다'});if(players.size>=200)return send(res,409,{error:'최대 200명까지 참가할 수 있습니다'});let name;if(t.mode==='verified'){const code=String(b.code||'').trim().toUpperCase();if(!codes.has(code)||codes.get(code))return send(res,403,{error:'사용할 수 없는 인증코드입니다'});name=String(b.nickname||'').trim();if(name.length<2||name.length>12||!/^[가-힣a-zA-Z0-9_ ]+$/.test(name))return send(res,400,{error:'닉네임은 한글·영문·숫자 2~12자로 입력해주세요'});if([...players.values()].some(x=>x.name.toLowerCase()===name.toLowerCase()))return send(res,409,{error:'이미 사용 중인 닉네임입니다'});codes.set(code,true)}else if(t.mode==='nickname'){name=String(b.nickname||'').trim();if(name.length<2||name.length>12||!/^[가-힣a-zA-Z0-9_ ]+$/.test(name))return send(res,400,{error:'닉네임은 한글·영문·숫자 2~12자로 입력해주세요'});if(b.agree!==true)return send(res,400,{error:'참가 안내에 동의해야 합니다'});if([...players.values()].some(x=>x.name.toLowerCase()===name.toLowerCase()))return send(res,409,{error:'이미 사용 중인 닉네임입니다'})}else name=`PLAYER ${String(seq+1).padStart(3,'0')}`;const id=`P${++seq}`,token=rand();players.set(id,{id,name,alive:true});tokens.set(token,id);broadcast();return send(res,200,{token,id,name})}
if(b.action==='resume')return p&&!p.left?send(res,200,{id:p.id,name:p.name,alive:p.alive}):send(res,401,{error:'다시 참가해주세요'});
if(b.action==='leave'){
 if(!p)return send(res,401,{error:'참가 정보를 확인할 수 없습니다'});
 // Before draw: cancel registration. After draw: mark absent from live roster,
 // but retain match history/bracket records and revoke the token.
 if(t.phase==='lobby')players.delete(p.id);
 else p.left=true;
 for(const [token,pid] of tokens){if(pid===p.id)tokens.delete(token)}
 broadcast();return send(res,200,{ok:true});
}

if(b.action==='move'){if(!p||p.left||!p.alive)return send(res,403,{error:'경기 참가자가 아닙니다'});if(t.phase!=='playing'||Date.now()>=t.deadline-10000)return send(res,409,{error:'선택 가능 시간이 종료됐습니다'});if(!moves.includes(b.move))return send(res,400,{error:'잘못된 선택입니다'});const m=activeMatches().find(x=>x.a===p.id||x.b===p.id);if(!m)return send(res,403,{error:'현재 경기가 없습니다'});if(m.a===p.id)m.amove=b.move;else m.bmove=b.move;broadcast();return send(res,200,{ok:true})}
if(b.action==='chat'){if(!p||p.left||!chatEnabled)return send(res,403,{error:'채팅을 사용할 수 없습니다'});const msg=String(b.message||'').trim();if(!msg||msg.length>80||/https?:|@|\d[\d -]{7,}\d/i.test(msg))return send(res,400,{error:'메시지 내용을 확인해주세요'});const now=Date.now();if(p.lastChat&&now-p.lastChat<2500)return send(res,429,{error:'잠시 후 다시 보내주세요'});p.lastChat=now;chat.push({id:rand().slice(0,12),name:maskProfanity(p.name),message:maskProfanity(msg),time:now});if(chat.length>100)chat.shift();broadcast();return send(res,200,{ok:true})}
if(b.action==='admin'){if(!authorized(req))return send(res,401,{error:'로그인이 필요합니다'});try{if(b.cmd==='reset'){if(!['nickname','anonymous','verified'].includes(b.mode))throw Error('모드를 선택하세요');reset(b.mode)}else if(b.cmd==='codes'){if(t.phase!=='lobby'||t.mode!=='verified')throw Error('인증코드 모드 대기 중에만 발급 가능합니다');const count=Number(b.count||10);if(!Number.isInteger(count)||count<1||count>200||codes.size+count>200)throw Error('발급 수량은 최대 200개입니다');const issued=[];for(let i=0;i<count;i++){let code;do{code=crypto.randomBytes(5).toString('hex').toUpperCase()}while(codes.has(code));codes.set(code,false);issued.push(code)}broadcast();return send(res,200,{ok:true,codes:issued})}else if(b.cmd==='start'){if(t.phase!=='lobby')throw Error('이미 시작했습니다');start()}else if(b.cmd==='auto'){
 const enabled=b.enabled===true;
 const delay=Number(b.delay);
 if(!Number.isInteger(delay)||delay<3||delay>120)throw Error('자동 진행 대기 시간은 3~120초로 설정하세요');
 if(enabled&&t.phase==='lobby')throw Error('대진 추첨 후 자동 진행을 켜주세요');
 autoMode=enabled;autoDelay=delay;autoNextAt=enabled&&t.phase==='ready'?Date.now()+autoDelay*1000:0;
 }else if(b.cmd==='open'){openRound()}else if(b.cmd==='close'){++version;finishRound()}else if(b.cmd==='duration'){if(t.phase==='playing')throw Error('경기 진행 중입니다');const d=Number(b.duration);if(!Number.isInteger(d)||d<15||d>120)throw Error('15~120초 사이로 설정하세요');t.duration=d}else if(b.cmd==='removePlayer'){if(t.phase!=='lobby')throw Error('참가자 제외는 대회 시작 전만 가능합니다');const id=String(b.playerId||'');if(!players.has(id))throw Error('참가자를 찾을 수 없습니다');players.delete(id);for(const [token,pid] of tokens){if(pid===id)tokens.delete(token)}}else if(b.cmd==='deleteChat'){const id=String(b.messageId||'');const index=chat.findIndex(m=>m.id===id);if(index<0)throw Error('메시지를 찾을 수 없습니다');chat.splice(index,1)}else if(b.cmd==='adminChat'){if(!chatEnabled)throw Error('채팅이 꺼져 있습니다');const message=String(b.message||'').trim();if(!message||message.length>80)throw Error('관리자 메시지는 1~80자로 입력하세요');chat.push({id:rand().slice(0,12),name:'📢 관리자',message:maskProfanity(message),time:Date.now()});if(chat.length>100)chat.shift()}else if(b.cmd==='setNotice'){const message=String(b.message||'').trim();if(message.length>140)throw Error('안내문은 140자 이내로 입력하세요');customNotice=maskProfanity(message)}else if(b.cmd==='toggleChat'){chatEnabled=!chatEnabled}else if(b.cmd==='clearChat'){chat=[]}else throw Error('잘못된 명령');broadcast();return send(res,200,{ok:true})}catch(e){return send(res,409,{error:e.message})}}
send(res,400,{error:'알 수 없는 요청'})});return true}
setInterval(()=>{for(const s of streams){try{s.write(': ping\n\n')}catch{streams.delete(s)}}},25000).unref();
module.exports={handle};

setInterval(()=>{if(!autoMode||t.phase!=='ready'||!autoNextAt||Date.now()<autoNextAt)return;autoNextAt=0;try{openRound();broadcast()}catch(e){autoMode=false;broadcast()}},500).unref();
