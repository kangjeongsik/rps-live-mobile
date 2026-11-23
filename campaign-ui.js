'use strict';
const CampaignUI=(()=>{
  const names={quiz:'당일 퀴즈',mission:'일일 미션 챌린지',rps:'협찬 가위바위보'};
  const states={draft:'초안',scheduled:'예약 게시',open:'참가 모집',active:'진행 중',paused:'중단',
    completed:'종료',cancelled:'취소'};
  const time=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'short',timeStyle:'short'});
  const sortableKST=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  const fmt=value=>value?time.format(new Date(value)):'';
  const localTime=value=>sortableKST.format(new Date(value)).replace(' ','T');
  const iso=value=>value?new Date(value+':00+09:00').toISOString():'';
  const get=id=>document.getElementById(id);
  function node(tag,value){
    const element=document.createElement(tag);
    if(value!==undefined)element.textContent=value;
    return element;
  }
  function link(label,href,button=false){
    const element=node('a',label);
    element.href=href;
    if(button)element.className='action';
    return element;
  }
  function image(url,className=''){
    if(!url)return null;
    const element=node('img');
    element.src=url;
    element.alt='';
    element.referrerPolicy='no-referrer';
    element.loading='lazy';
    element.className=className;
    return element;
  }
  function device(){
    let id=localStorage.getItem('rps_browser_id');
    if(!id){id=crypto.randomUUID();localStorage.setItem('rps_browser_id',id)}
    return id;
  }
  async function api(path,method='GET',body,admin=false){
    const response=await fetch('/api/v1'+path,{method,headers:{
      ...(!admin&&{'X-RPS-Device':device()}),...(body!==undefined&&{'Content-Type':'application/json'})},
      ...(body!==undefined&&{body:JSON.stringify(body)})});
    const data=await response.json();
    if(!response.ok)throw Object.assign(Error(data.error||'요청을 처리하지 못했습니다'),{status:response.status});
    return data;
  }
  function button(label,work){
    const element=node('button',label);
    element.type='button';
    element.onclick=async()=>{
      element.disabled=true;
      try{await work()}catch(error){get('feedback').textContent=error.message}
      finally{element.disabled=false}
    };
    return element;
  }
  function card(campaign){
    const card=node('article');
    card.className='campaign-card';
    const heading=node('div');
    heading.className='campaign-heading';
    const logo=image(campaign.company.logoURL,'campaign-logo');
    if(logo)heading.append(logo);
    const title=node('div');
    title.append(node('small',campaign.company.brand||campaign.company.name),
      node('h3',campaign.title));
    heading.append(title);
    card.append(heading,node('p',(campaign.adQuiz?'브랜드·서비스 퀴즈':names[campaign.type])+' · '+states[campaign.status]),
      node('p',fmt(campaign.startsAt)+' ~ '+fmt(campaign.endsAt)+' KST'));
    const p=campaign.progress;
    if(p?.joined){
      let progress='참가 완료';
      if(campaign.type==='quiz'&&p.attempts)progress='최고 '+p.score+'점';
      if(campaign.type==='mission')progress=p.days.length+'/'+p.total+'개 완료 · '+p.completionPercent+'%';
      if(campaign.type==='rps'&&p.round)progress=p.won?'우승':p.round+'라운드';
      card.append(node('p',progress));
    }
    card.append(link(p?.joined?'내 진행 보기':campaign.canJoin?'이벤트 참여':'이벤트 보기',
      '/campaigns/'+encodeURIComponent(campaign.id),true));
    return card;
  }
  return {names,states,fmt,localTime,iso,get,node,link,image,api,button,card};
})();
