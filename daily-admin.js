'use strict';
const byId=id=>document.getElementById(id);
const statusNames={scheduled:'예약 중',open:'준비 중',playing:'진행 중',finished:'종료',
  cancelled:'중단',expired:'대기 시간 만료',create:'회차 생성',pending:'대기',retry:'재시도',
  sent:'발송 성공',failed:'실패',skipped:'발송 제외'};
const fmt=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'short',timeStyle:'short'});
async function api(path,method='GET',body){
  const response=await fetch('/api/v1/admin/daily/'+path,{method,
    ...(body&&{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  if(response.status===401){
    location.assign('/admin-login?next=%2Fadmin%2Fdaily');
    throw Error('관리자 로그인이 필요합니다');
  }
  const data=await response.json();
  if(!response.ok)throw Error(data.error||'요청 실패');
  return data;
}
function node(tag,text){
  const n=document.createElement(tag);
  n.textContent=text;
  return n;
}
function show(text){byId('feedback').textContent=text}
function run(work){
  return async event=>{
    event.preventDefault();
    const target=event.currentTarget;
    target.disabled=true;
    try{await work();await refresh(false);show('변경사항을 반영했습니다.')}
    catch(error){show(error.message)}
    finally{target.disabled=false}
  };
}
function command(row,type,text,question){
  const n=node('button',text);
  n.onclick=event=>{
    if(question&&!confirm(question))return;
    return run(()=>api(row.event_id+'/commands','POST',{command:type}))(event);
  };
  return n;
}
async function refresh(fillForm){
  const data=await api('schedules');
  const schedule=data.schedules[0];
  if(schedule){
    byId('schedule').textContent='매일 '+schedule.start_time.slice(0,5)+' KST · 가위바위보 토너먼트';
    if(fillForm)for(const [name,field] of Object.entries({minPlayers:'min_players',
      preparationSeconds:'preparation_seconds',waitMinutes:'wait_minutes'})){
      byId('settings').elements[name].value=schedule[field];
    }
  }
  const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date());
  const next=data.occurrences.filter(row=>row.service_date>date).at(-1);
  byId('rounds').replaceChildren(...data.occurrences.map(row=>{
    const article=node('article','');
    const label=row.service_date===date?' · 오늘':row===next?' · 다음 회차':'';
    article.append(node('h3',row.service_date+label),
      node('p',fmt.format(new Date(row.scheduled_at))+' · '+statusNames[row.status]),
      node('p','예약 '+row.reservations+'명 · 실제 참가 '+row.participants+'명'));
    const actions=node('div','');
    actions.className='actions';
    const link=node('a','대진·채팅 관리');
    link.href='/tournament/admin?event='+encodeURIComponent(row.event_id);
    actions.append(link);
    if(['scheduled','open'].includes(row.status))actions.append(command(row,'start','수동 개시'));
    if(['scheduled','open','playing'].includes(row.status))actions.append(
      command(row,'cancel','회차 중단','이 DAILY 회차를 중단하시겠습니까?'));
    if(row.status==='cancelled'&&!row.started_at&&row.service_date===date)actions.append(command(row,'resume','회차 재개'));
    article.append(actions);
    return article;
  }));
  const dates=new Map(data.occurrences.map(row=>[row.event_id,row.service_date]));
  byId('executions').replaceChildren(...data.executions.map(row=>node('li',
    fmt.format(new Date(row.executed_at))+' · '+(dates.get(row.event_id)||row.event_id)+' · '+(statusNames[row.action]||row.action))));
  byId('notifications').replaceChildren(...(data.notifications.length?data.notifications.map(row=>node('li',
    (dates.get(row.event_id)||row.event_id)+' · '+statusNames[row.status]+' '+row.count+'건')):[node('li','발송 기록이 없습니다.')]));
}
byId('settings').onsubmit=run(async()=>{
  const fields=Object.fromEntries(new FormData(byId('settings')));
  await api('schedules','PUT',Object.fromEntries(Object.entries(fields).map(([name,value])=>[name,Number(value)])));
});
byId('run').onclick=run(()=>api('run','POST',{}));
refresh(true).catch(error=>show(error.message));
