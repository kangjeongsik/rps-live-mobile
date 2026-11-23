'use strict';
const {get,node,link,api,button,names,states,fmt,localTime,iso,card}=CampaignUI;
const admin=(path,method='GET',body)=>api('/admin'+path,method,body,true);
const companyForm=get('companyForm'),campaignForm=get('campaignForm'),editor=get('editor');
const feedback=value=>{get('feedback').textContent=value};
const actions={publish:'게시',pause:'중단',resume:'재개',complete:'종료',cancel:'취소'};
const allowed={draft:['publish','cancel'],scheduled:['cancel'],open:['pause','complete','cancel'],
  active:['pause','complete','cancel'],paused:['resume','complete','cancel']};
let companies=[],companyId=null,campaignId=null;
const companyFields={name:'name',brand:'brand',industry:'industry',contactName:'contact_name',contactInfo:'contact_info',
  websiteURL:'website_url',logoURL:'logo_url',imageURL:'image_url',description:'description',internalNote:'internal_note'};
const campaignFields={companyId:'company_id',type:'type',title:'title',imageURL:'image_url',estimatedReach:'estimated_reach',
  description:'description',joinTerms:'join_terms',adGoal:'ad_goal'};

function editCompany(row){
  companyId=row?.id||null;
  companyForm.reset();
  for(const [name,field] of Object.entries(companyFields))companyForm.elements[name].value=row?.[field]||'';
  companyForm.elements.enabled.checked=row?.enabled??true;
}
function loadCompanySelect(){
  const select=campaignForm.elements.companyId,current=select.value;
  select.replaceChildren(...companies.map(row=>{
    const option=node('option',row.brand+' · '+row.name+(row.enabled?'':' (비활성)'));
    option.value=row.id;
    return option;
  }));
  if(companies.some(row=>row.id===current))select.value=current;
}
function onSubmit(form,work){
  form.onsubmit=async event=>{
    event.preventDefault();
    try{await work()}catch(error){feedback(error.message)}
  };
}
function input(parent,label,name,value,{kind='text',min,max,maxLength,required=true}={}){
  const wrap=node('label',label);
  const control=node(kind==='textarea'?'textarea':kind==='select'?'select':'input');
  control.dataset.field=name;
  if(control.tagName==='INPUT')control.type=kind;
  control.required=required;
  if(min!==undefined)control.min=min;
  if(max!==undefined)control.max=max;
  if(maxLength!==undefined)control.maxLength=maxLength;
  if(kind==='select'){
    for(const [id,title] of Object.entries({daily_quiz:'일일 퀴즈',content_check:'콘텐츠 확인 문제'})){
      const option=node('option',title);
      option.value=id;control.append(option);
    }
  }
  control.value=value??'';
  wrap.append(control);
  parent.append(wrap);
  return control;
}
function renumber(){
  [...editor.children].forEach((row,index)=>{
    row.querySelector('legend').textContent=(index+1)+(campaignForm.elements.type.value==='mission'?'일차':'번 문제');
  });
}
function addQuestion(value={}){
  const type=campaignForm.elements.type.value;
  if(type==='rps'||editor.children.length>=(type==='mission'?31:30))return;
  const field=node('fieldset');
  field.append(node('legend',''));
  if(type==='mission'){
    input(field,'미션 제목','title',value.title,{maxLength:180});
    input(field,'미션 설명','description',value.description,{kind:'textarea',required:false,maxLength:800});
    input(field,'완료 조건','kind',value.kind||'daily_quiz',{kind:'select'});
    input(field,'확인할 콘텐츠','content',value.content,{kind:'textarea',required:false,maxLength:1600});
  }
  input(field,'문제','prompt',value.prompt,{kind:'textarea',maxLength:800});
  input(field,'보기 (줄마다 하나, 2~6개)','choices',(value.choices||[]).join('\n'),{kind:'textarea'});
  input(field,'정답 번호 (첫 보기는 1번)','correctIndex',(value.correct_index??0)+1,{kind:'number',min:1,max:6});
  if(type==='quiz')input(field,'배점','points',value.points||10,{kind:'number',min:1,max:1000});
  field.append(button('항목 제거',async()=>{field.remove();renumber()}));
  editor.append(field);
  renumber();
}
function showEditor(type){
  get('retryLabel').hidden=type!=='quiz';
  get('addQuestion').hidden=type==='rps';
  get('addQuestion').textContent=type==='mission'?'다음 날짜 미션 추가':'문제 추가';
}
function changeType(){
  const type=campaignForm.elements.type.value;
  editor.replaceChildren();
  showEditor(type);
  const start=campaignForm.elements.startsAt.value;
  if(type==='mission'){
    for(let day=1;day<=7;day++)addQuestion({title:day+'일차 미션'});
    if(start){
      const date=new Date(start.slice(0,10)+'T00:00:00Z');
      date.setUTCDate(date.getUTCDate()+6);
      campaignForm.elements.endsAt.value=date.toISOString().slice(0,10)+'T23:59';
    }
  }else if(type==='quiz'){
    addQuestion();
    if(start)campaignForm.elements.endsAt.value=start.slice(0,10)+'T23:59';
  }
}
function newCampaign(){
  campaignId=null;
  campaignForm.reset();
  campaignForm.elements.type.disabled=false;
  campaignForm.elements.companyId.disabled=false;
  get('advertisingPlan').hidden=true;
  get('advertisingReview').hidden=true;
  const now=Date.now();
  campaignForm.elements.opensAt.value=localTime(now);
  campaignForm.elements.startsAt.value=localTime(now);
  campaignForm.elements.endsAt.value=localTime(now).slice(0,10)+'T23:59';
  get('preview').hidden=true;
  loadCompanySelect();changeType();
}
function readCampaign(){
  const form=campaignForm.elements;
  const value=Object.fromEntries(Object.keys(campaignFields).map(name=>[name,form[name].value]));
  for(const name of ['opensAt','startsAt','endsAt'])value[name]=iso(form[name].value);
  value.allowRetry=form.allowRetry.checked;
  value.advertisingReviewed=form.advertisingReviewed.checked;
  value.estimatedReach=value.estimatedReach===''?null:Number(value.estimatedReach);
  const items=[...editor.children].map(row=>{
    const result=Object.fromEntries([...row.querySelectorAll('[data-field]')].map(field=>[field.dataset.field,field.value]));
    result.choices=result.choices.split('\n').map(choice=>choice.trim()).filter(Boolean);
    result.correctIndex=Number(result.correctIndex)-1;
    if(result.points!==undefined)result.points=Number(result.points);
    return result;
  });
  if(value.type==='quiz')value.questions=items;
  if(value.type==='mission')value.missions=items;
  return value;
}
async function editCampaign(id){
  const {campaign,content}=await admin('/campaigns/'+id);
  campaignId=id;
  campaignForm.reset();
  for(const [name,field] of Object.entries(campaignFields))campaignForm.elements[name].value=campaign[field]??'';
  for(const [name,field] of Object.entries({opensAt:'opens_at',startsAt:'starts_at',endsAt:'ends_at'}))
    campaignForm.elements[name].value=localTime(campaign[field]);
  campaignForm.elements.type.disabled=true;
  campaignForm.elements.allowRetry.checked=campaign.allow_retry;
  editor.replaceChildren();
  for(const item of content)addQuestion(item);
  const plan=campaign.advertising_plan;
  get('advertisingPlan').hidden=!plan;
  get('advertisingReview').hidden=!campaign.advertising_review_required;
  campaignForm.elements.companyId.disabled=Boolean(plan);
  if(plan){
    const items=node('ul');
    for(const item of plan.activities)items.append(node('li',item));
    get('advertisingPlan').replaceChildren(node('h3','광고 제안의 기본 구성'),items,node('p',plan.benefitNotes));
    if(!content.length&&campaign.type==='quiz'){
      addQuestion();
    }else if(!content.length&&campaign.type==='mission'){
      const start=localTime(campaign.starts_at).slice(0,10);
      const end=localTime(new Date(Date.parse(campaign.ends_at)-1)).slice(0,10);
      const days=(Date.parse(end)-Date.parse(start))/86400000+1;
      for(let day=1;day<=days;day++)addQuestion({title:day+'일차 미션',
        description:plan.activities[(day-1)%plan.activities.length]});
    }
  }
  showEditor(campaign.type);
  get('preview').hidden=true;
  campaignForm.scrollIntoView({block:'start'});
}
async function operating(id){
  const {campaign,counts,ranking,logs,content}=await admin('/campaigns/'+id);
  const area=get('operatingData');
  const submitted=campaign.type==='quiz'?counts.quiz_submitters:campaign.type==='mission'?counts.mission_submitters:
    counts.rps_submitters;
  const percentage=campaign.type==='mission'&&counts.participants&&content.length
    ?Math.round(counts.mission_checks*100/(counts.participants*content.length))
    :counts.participants?Math.round(counts.completed*100/counts.participants):0;
  const top=node('ol');
  for(const row of ranking){
    top.append(node('li',row.display_name+(row.score!==undefined?' · '+row.score+'점':
      row.days!==undefined?' · '+row.days+'일 완료':' · 우승')));
  }
  const history=node('ul');
  for(const record of logs)history.append(node('li',fmt(record.occurred_at)+' · '+
    (states[record.action]||({rejected:'오류: 명령 거절',create:'작성',edit:'수정'})[record.action]||record.action)+
    (record.detail?' ('+record.detail+')':'')));
  area.replaceChildren(node('h3',campaign.title),node('p','참가 '+counts.participants+'명 · 제출 '+submitted+
    '명 · 완료 '+counts.completed+'명 · 진행률 '+percentage+'%'),
    node('h3','점수 및 순위'),ranking.length?top:node('p','아직 결과가 없습니다.'),
    node('h3','실행 기록'),history);
  get('operations').hidden=false;
}
async function refresh(){
  const [businesses,events]=await Promise.all([admin('/companies'),admin('/campaigns')]);
  companies=businesses.companies;
  get('companies').replaceChildren(...companies.map(row=>button(row.brand+(row.enabled?'':' (비활성)'),async()=>editCompany(row))));
  loadCompanySelect();
  get('campaignList').replaceChildren(...events.campaigns.map(row=>{
    const article=node('article');
    article.append(node('h3',row.title),node('p',row.brand+' · '+names[row.type]+' · '+states[row.status]),
      node('p',fmt(row.starts_at)+' ~ '+fmt(row.ends_at)+' KST'));
    const group=node('div');group.className='campaign-controls';
    if(row.status==='draft')group.append(button('초안 편집',()=>editCampaign(row.id)));
    if(row.event_id)group.append(link('토너먼트 운영','/tournament/admin?event='+row.event_id,true));
    group.append(button('운영 현황',()=>operating(row.id)));
    for(const action of allowed[row.status]||[])group.append(button(actions[action],async()=>{
      if(['cancel','complete','pause'].includes(action)&&!confirm('이 이벤트를 '+actions[action]+'할까요?'))return;
      await admin('/campaigns/'+row.id+'/commands','POST',{command:action});
      await refresh();await operating(row.id);feedback(actions[action]+' 처리했습니다.');
    }));
    article.append(group);
    return article;
  }));
}
onSubmit(companyForm,async()=>{
  const form=companyForm.elements;
  const data=Object.fromEntries(Object.keys(companyFields).map(name=>[name,form[name].value]));
  data.enabled=form.enabled.checked;
  const result=await admin('/companies'+(companyId?'/'+companyId:''),companyId?'PUT':'POST',data);
  editCompany(result.company);await refresh();feedback('기업을 저장했습니다.');
});
onSubmit(campaignForm,async()=>{
  const result=await admin('/campaigns'+(campaignId?'/'+campaignId:''),campaignId?'PUT':'POST',readCampaign());
  await refresh();await operating(result.campaign.id);await editCampaign(result.campaign.id);
  feedback('초안을 저장했습니다. 게시하려면 이벤트 목록에서 게시를 선택하세요.');
});
get('previewButton').onclick=()=>{
  if(!campaignForm.reportValidity())return;
  const draft=readCampaign();
  const company=companies.find(row=>row.id===draft.companyId);
  if(!company)return;
  const preview=card({id:'preview',title:draft.title,type:draft.type,status:'draft',
    startsAt:draft.startsAt,endsAt:draft.endsAt,company:{brand:company.brand,logoURL:company.logo_url}});
  preview.querySelector('a').remove();
  if(draft.description)preview.append(node('p',draft.description));
  if(draft.joinTerms)preview.append(node('p','참가 조건 · '+draft.joinTerms));
  for(const question of draft.questions||draft.missions||[])preview.append(node('p',question.title||question.prompt));
  get('preview').replaceChildren(node('h3','참가자 화면 미리보기'),preview);
  get('preview').hidden=false;
};
get('newCompany').onclick=()=>editCompany();
get('newCampaign').onclick=newCampaign;
get('addQuestion').onclick=()=>addQuestion();
campaignForm.elements.type.onchange=changeType;
newCampaign();
refresh().then(async()=>{
  const selected=new URLSearchParams(location.search).get('edit');
  if(selected){
    const info=await admin('/campaigns/'+encodeURIComponent(selected));
    if(info.campaign.status==='draft')await editCampaign(selected);
    else await operating(selected);
  }
}).catch(error=>feedback(error.message));
