'use strict';
const element=id=>document.getElementById(id);
const statuses={scheduled:'참가 예약 중',open:'참가 준비 중',playing:'경기 진행 중',
  finished:'경기 종료',cancelled:'운영 중단',expired:'참가 인원 부족으로 마감',
  lobby:'참가 모집',ready:'다음 라운드 대기'};
const clock=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'numeric',minute:'2-digit'});
let deviceId=localStorage.getItem('rps_browser_id');
if(!deviceId){
  deviceId=crypto.randomUUID();
  localStorage.setItem('rps_browser_id',deviceId);
}
let preferences;
let countdownTime;
let refreshInFlight=false;
const message=text=>{element('feedback').textContent=text};
const report=error=>message(error.message);
async function api(path,method='GET',body){
  const response=await fetch(path,{method,headers:{'X-RPS-Device':deviceId,
    ...(body!==undefined&&{'Content-Type':'application/json'})},
    ...(body!==undefined&&{body:JSON.stringify(body)})});
  const value=await response.json();
  if(!response.ok)throw Error(value.error||'요청을 처리하지 못했습니다');
  return value;
}
function node(tag,text){
  const n=document.createElement(tag);
  n.textContent=text;
  return n;
}
function link(text,url,button=false){
  const n=node('a',text);
  n.href=url;
  if(button)n.className='action';
  return n;
}
function button(text,callback,secondary=false){
  const n=node('button',text);
  if(secondary)n.className='secondary';
  n.onclick=async()=>{
    n.disabled=true;
    try{await callback()}catch(error){report(error)}
    finally{n.disabled=false}
  };
  return n;
}
function list(id,rows,render,empty){
  element(id).replaceChildren(...(rows.length?rows.map(render):[node('li',empty)]));
}
function eventCard(container,event,primary){
  container.replaceChildren();
  if(!event){container.append(node('p','회차를 준비 중입니다.'));return}
  container.append(node('p',event.service_date+' · '+clock.format(new Date(event.scheduled_at))+' (한국시간)'),
    node('p',statuses[event.status]||event.status),
    node('p','예약 '+event.reservations+'명 · 실제 참가 '+event.participants+'명'));
  if(primary&&event.status==='scheduled'){
    countdownTime=new Date(event.scheduled_at).getTime();
    const n=node('p','');
    n.id='countdown';
    n.className='countdown';
    container.append(n);
  }
  const actions=node('div','');
  actions.className='actions';
  const canJoin=['scheduled','open'].includes(event.status);
  if(canJoin||event.joined||event.status==='finished'){
    actions.append(link(event.joined?'게임 다시 열기':event.status==='finished'?'경기 결과 보기':'게임 입장',
      '/tournament/join/'+encodeURIComponent(event.join_code),true));
  }
  if(canJoin){
    const reservationPath='/api/v1/daily/'+event.event_id+'/reservations';
    const active=event.reservation_status==='reserved';
    const notify=document.createElement('input');
    notify.type='checkbox';
    notify.checked=event.notify??false;
    const choice=node('label',' 이 회차 시작 알림');
    choice.prepend(notify);
    notify.onchange=async()=>{
      if(!active)return;
      try{await api(reservationPath,'POST',{notify:notify.checked});message('회차 알림 설정을 저장했습니다.')}
      catch(error){notify.checked=!notify.checked;report(error)}
    };
    actions.append(button(active?'예약 취소':'참가 예약',async()=>{
      if(active)await api(reservationPath+'/me','DELETE');
      else await api(reservationPath,'POST',{notify:notify.checked});
      message(active?'예약을 취소했습니다.':'참가 예약을 완료했습니다.');
      await refresh();
    },active),choice);
  }
  container.append(actions);
}
function tick(){
  const n=element('countdown');
  if(!n)return;
  const seconds=Math.max(0,Math.ceil((countdownTime-Date.now())/1000));
  n.textContent=seconds?Math.floor(seconds/3600)+'시간 '+Math.floor(seconds/60)%60+'분 '+seconds%60+'초':'개시 확인 중';
}
async function refresh(){
  if(refreshInFlight)return;
  refreshInFlight=true;
  try{
    const data=await api('/api/v1/me/home');
    eventCard(element('today'),data.today,true);
    element('nextSection').hidden=!data.next;
    if(data.next)eventCard(element('next'),data.next,false);
    tick();
    list('mine',data.events.filter(row=>!['expired','cancelled'].includes(row.status)),row=>{
      const li=node('li','');
      li.append(link(row.daily?'DAILY '+row.service_date:'토너먼트','/tournament/join/'+encodeURIComponent(row.join_code)),
        ' · '+(row.won?'우승':statuses[row.status]||row.status)+(Number(row.round)>0?' · '+row.round+'라운드':''));
      return li;
    },'참가 또는 예약한 이벤트가 없습니다.');
    list('events',data.available,row=>{
      const li=node('li','');
      li.append(link('토너먼트','/tournament/join/'+encodeURIComponent(row.join_code)),
        ' · '+(statuses[row.status]||row.status)+(Number(row.round)>0?' · '+row.round+'라운드':''));
      return li;
    },'진행 중인 별도 이벤트가 없습니다.');
    element('totals').textContent='참가 '+data.totals.joined+'회 · 우승 '+data.totals.wins+'회';
    list('history',data.history,row=>node('li',row.service_date+' · '+(row.won?'우승':statuses[row.status]||row.status)),'참가 기록이 없습니다.');
  }finally{refreshInFlight=false}
}
async function loadPreferences(){
  preferences=await api('/api/v1/me/notification-preferences');
  element('dailyStart').checked=preferences.daily_start;
  element('dailyStart').disabled=false;
  element('pushStatus').textContent=!('Notification' in window)
    ?'이 브라우저는 알림 권한을 지원하지 않습니다.'
    :Notification.permission==='denied'?'브라우저에서 알림을 차단했습니다. 게임과 예약은 이용할 수 있습니다.'
      :preferences.daily_start&&preferences.subscribed?'DAILY 알림 구독 중':'DAILY 알림은 꺼져 있습니다.';
}
async function subscribe(){
  if(!('Notification' in window)||!('serviceWorker' in navigator)||!preferences?.vapidPublicKey)
    throw Error('현재 브라우저 또는 서버에서 푸시 구독을 사용할 수 없습니다.');
  if(await Notification.requestPermission()!=='granted')throw Error('브라우저에서 알림 권한을 허용하지 않았습니다.');
  const registration=await navigator.serviceWorker.register('/tournament/sw.js',{scope:'/tournament/'});
  const worker=registration.installing||registration.waiting;
  if(!registration.active&&worker){
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('서비스 워커 준비 시간이 초과됐습니다.')),8000);
      worker.addEventListener('statechange',()=>{
        if(worker.state==='activated'){clearTimeout(timer);resolve()}
        if(worker.state==='redundant'){clearTimeout(timer);reject(Error('서비스 워커를 시작할 수 없습니다.'))}
      });
    });
  }
  let subscription=await registration.pushManager.getSubscription();
  if(!subscription){
    const encoded=preferences.vapidPublicKey.replace(/-/g,'+').replace(/_/g,'/');
    const key=Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length/4)*4,'=')),c=>c.charCodeAt(0));
    subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
  }
  await api('/tournament/api','POST',{action:'pushSubscribe',channel:'daily',deviceId,subscription:subscription.toJSON()});
}
element('dailyStart').onchange=async event=>{
  const input=event.target;
  input.disabled=true;
  try{
    if(input.checked)await subscribe();
    await api('/api/v1/me/notification-preferences','PUT',{dailyStart:input.checked});
    await loadPreferences();
  }catch(error){input.checked=Boolean(preferences?.daily_start);report(error)}
  finally{input.disabled=false}
};
refresh().catch(report);
loadPreferences().catch(report);
setInterval(tick,1000);
setInterval(()=>{if(!document.hidden)refresh().catch(report)},15000);

async function loadCampaigns(){
  const data=await CampaignUI.api('/campaigns');
  const mine=new Set(data.mine.map(campaign=>campaign.id));
  const render=(id,rows,empty)=>element(id).replaceChildren(...(rows.length
    ?rows.map(CampaignUI.card):[node('p',empty)]));
  render('myCampaigns',data.mine,'참가한 기업 이벤트가 없습니다.');
  render('campaignList',data.available.filter(campaign=>!mine.has(campaign.id)),'공개된 기업 이벤트가 없습니다.');
  render('missionList',data.mine.filter(campaign=>campaign.type==='mission'&&campaign.status==='active'&&!campaign.progress.completed),
    '진행 중인 미션이 없습니다.');
}
async function loadCampaignPreferences(){
  const prefs=await CampaignUI.api('/me/campaign-notification-preferences');
  element('campaignUpdates').checked=prefs.event_updates;
  element('campaignAdvertising').checked=prefs.advertising;
  for(const id of ['campaignUpdates','campaignAdvertising'])element(id).disabled=false;
}
for(const id of ['campaignUpdates','campaignAdvertising']){
  element(id).onchange=async()=>{
    for(const field of ['campaignUpdates','campaignAdvertising'])element(field).disabled=true;
    try{
      await CampaignUI.api('/me/campaign-notification-preferences','PUT',{
        eventUpdates:element('campaignUpdates').checked,advertising:element('campaignAdvertising').checked});
      message('기업 이벤트 알림 동의를 저장했습니다.');
    }catch(error){report(error)}
    finally{
      try{await loadCampaignPreferences()}catch(error){report(error)}
    }
  };
}
loadCampaigns().catch(report);
loadCampaignPreferences().catch(report);
setInterval(()=>{if(!document.hidden)loadCampaigns().catch(report)},15000);
