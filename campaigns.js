'use strict';
const {get,node,link,image,api,button,names,states,fmt}=CampaignUI;
const path='/campaigns/'+encodeURIComponent(location.pathname.split('/').at(-1));
const announce=value=>{get('feedback').textContent=value};
let quizAttempt=null;
const missionAttempts=new Map();
function choices(question,name){
  const field=node('fieldset');
  field.append(node('legend',question.prompt));
  question.choices.forEach((value,index)=>{
    const choice=node('input');
    Object.assign(choice,{type:'radio',name,value:String(index),required:true});
    const label=node('label',' '+value);
    label.prepend(choice);
    field.append(label);
  });
  return field;
}
function sendForm(form,label,work){
  const submit=node('button',label);
  form.append(submit);
  form.onsubmit=async event=>{
    event.preventDefault();
    submit.disabled=true;
    try{await work(new FormData(form))}
    catch(error){announce(error.message)}
    finally{submit.disabled=false}
  };
}
async function render(){
  const event=await api(path);
  document.title=event.title+' · LIVE 챌린지';
  const summary=get('summary'),area=get('activity'),ranking=get('results');
  const logo=image(event.company.logoURL,'campaign-logo');
  const banner=image(event.imageURL,'campaign-banner');
  summary.replaceChildren();
  if(logo)summary.append(logo);
  summary.append(node('p',event.company.brand+' · '+(event.adQuiz?'브랜드·서비스 퀴즈':names[event.type])),node('h2',event.title),
    node('p',states[event.status]),node('p',fmt(event.startsAt)+' ~ '+fmt(event.endsAt)+' (KST)'));
  if(banner)summary.append(banner);
  if(event.description)summary.append(node('p',event.description));
  if(event.joinTerms)summary.append(node('p','참가 조건 · '+event.joinTerms));
  if(event.company.description)summary.append(node('p',event.company.description));
  if(event.company.websiteURL)summary.append(link('기업 안내',event.company.websiteURL));
  area.replaceChildren();
  area.hidden=true;
  ranking.hidden=true;
  const member=event.progress;
  if(!member.joined&&event.canJoin){
    const join=node('form');
    if(event.type!=='rps'){
      const label=node('label','닉네임 (선택)');
      const input=node('input');
      Object.assign(input,{name:'nickname',type:'text',maxLength:20,autocomplete:'nickname'});
      label.append(input);
      join.append(label);
    }
    if(event.joinTerms){
      const label=node('label',' 참가 조건을 확인했습니다.');
      const agree=node('input');
      Object.assign(agree,{type:'checkbox',name:'terms',required:true});
      label.prepend(agree);
      join.append(label);
    }
    sendForm(join,event.type==='rps'?'토너먼트 입장':'이벤트 참가',async data=>{
      const result=await api(path+'/join','POST',{nickname:String(data.get('nickname')||''),termsAccepted:data.has('terms')});
      if(result.gameURL){location.assign(result.gameURL);return}
      announce('참가했습니다.');
      await render();
    });
    summary.append(join);
  }
  if(event.type==='rps'&&member.joined&&event.gameURL)summary.append(link('대진 및 경기 보기',event.gameURL,true));
  if(event.type==='quiz'&&member.joined){
    area.hidden=false;
    area.append(node('h2','퀴즈'));
    if(member.attempts)area.append(node('p','최고 '+member.score+'점 · '+member.attempts+'회 제출'));
    if(member.canSubmit&&event.questions?.length){
      const form=node('form');
      form.className='campaign-form';
      for(const q of event.questions)form.append(choices(q,'q'+q.position));
      sendForm(form,'답안 제출',async data=>{
        const answers=event.questions.map(q=>Number(data.get('q'+q.position)));
        quizAttempt??=crypto.randomUUID();
        const result=await api(path+'/quiz/submit','POST',{answers,requestId:quizAttempt});
        quizAttempt=null;
        announce('제출 점수 '+result.score+'점');
        await render();
      });
      area.append(form);
    }
  }
  if(event.type==='mission'&&member.joined){
    area.hidden=false;
    area.append(node('h2','일일 미션'),node('p',member.days.length+'/'+member.total+
      '개 완료 · 최장 '+member.longestStreak+'일 연속'));
    for(const mission of event.missions||[]){
      const article=node('article');
      const completed=member.days.includes(mission.day);
      article.append(node('h3',mission.day+'일차 · '+mission.title),node('p',mission.description||''));
      if(completed)article.append(node('p','완료'));
      else if(member.canSubmit&&mission.choices){
        if(mission.content)article.append(node('p',mission.content));
        const form=node('form');
        form.className='campaign-form';
        form.append(choices(mission,'answer'));
        sendForm(form,'미션 확인',async data=>{
          if(!missionAttempts.has(mission.day))missionAttempts.set(mission.day,crypto.randomUUID());
          const result=await api(path+'/missions/'+mission.day+'/submit','POST',
            {answer:Number(data.get('answer')),requestId:missionAttempts.get(mission.day)});
          missionAttempts.delete(mission.day);
          announce(result.completed?'미션을 완료했습니다.':'조건을 충족하지 못했습니다. 다시 확인해 주세요.');
          if(result.completed)await render();
        });
        article.append(form);
      }else article.append(node('p','제출 가능 시간이 아닙니다.'));
      area.append(article);
    }
  }
  if(event.status==='completed'){
    const {results}=await api(path+'/results');
    ranking.hidden=false;
    const list=node('ol');
    for(const row of results){
      const label=event.type==='quiz'?row.rank+'위 · '+row.display_name+' · '+row.score+'점':
        event.type==='mission'?row.display_name+' · '+row.days+'개 완료':row.display_name+' 우승';
      list.append(node('li',label));
    }
    ranking.replaceChildren(node('h2','결과 및 순위'),results.length?list:node('p','공개된 결과가 없습니다.'));
  }
}
render().catch(error=>announce(error.message));
