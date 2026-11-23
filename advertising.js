'use strict';
const {get,node,link,button,api,localTime,iso,fmt,names,states}=CampaignUI;
const admin=(path,method='GET',body)=>api('/admin'+path,method,body,true);
const ads=(path,method='GET',body)=>admin('/advertising'+path,method,body);
const companySelect=get('companySelect');
const forms=Object.fromEntries(['company','lead','proposal','contract','package','rule'].map(name=>[name,get(name+'Form')]));
const labels={fixed:'고정형',performance:'성과형',hybrid:'혼합형',
  store_visit:'매장 방문',brand_awareness:'브랜드 인지도',engagement:'반복 참여',consultation:'상담·예약',other:'기타',
  draft:'초안',finalized:'제안 확정',sent:'전달 기록',cancelled:'취소',consulting:'상담 중',
  proposal_writing:'제안 작성',proposal_sent:'제안 전달',negotiating:'계약 협의',confirmed:'계약 확정',
  running:'운영 중',ended:'종료',exclusive:'VAT 별도',inclusive:'VAT 포함',exempt:'면세 조건'};
const transitions={consulting:['proposal_writing','cancelled'],proposal_writing:['proposal_sent','cancelled'],
  proposal_sent:['negotiating','confirmed','cancelled'],negotiating:['proposal_sent','confirmed','cancelled'],
  confirmed:['running','cancelled'],running:['ended','cancelled'],ended:[],cancelled:[]};
const editContracts=new Set(['consulting','proposal_writing','proposal_sent','negotiating']);
const dirty=new Set();
const notice=value=>{get('feedback').textContent=value};
let current={leads:[],proposals:[],contracts:[],campaigns:[],logs:[]};
let catalogs={packages:[],rules:[]};
let selection={lead:null,proposal:null,contract:null,package:null,rule:null};
let companyId='';
const fields={
  lead:{industry:'industry',goal:'goal',goalNote:'goal_note',budget:'budget_krw',desiredDays:'desired_days',
    audience:'audience',benefits:'benefits',hasStore:'has_store',needsConsultation:'needs_consultation',consultationNote:'consultation_note'},
  proposal:{leadId:'lead_id',packageId:'package_id',title:'title',description:'description',recommendationReason:'recommendation_reason',
    eventType:'event_type',activities:'activities',benefitNotes:'benefit_notes',joinTerms:'join_terms',opensAt:'opens_at',
    startsAt:'starts_at',endsAt:'ends_at',expectedReach:'expected_reach',couponPolicyId:'coupon_policy_id'},
  contract:{proposalId:'proposal_id',billingMode:'billing_mode',performanceBasis:'performance_basis',fixedFee:'fixed_fee_krw',
    unitFee:'unit_fee_krw',purchaseRate:'purchase_rate_bps',cap:'cap_krw',projectedCouponUses:'projected_coupon_uses',
    projectedPurchase:'projected_purchase_krw',contractStart:'contract_start',contractEnd:'contract_end',discountPayer:'discount_payer',
    vatMode:'vat_mode',settlementCycle:'settlement_cycle',capScope:'cap_scope',evidenceLevel:'evidence_level',vatRate:'vat_rate_bps'},
  package:{name:'name',description:'description',eventType:'event_type',minDays:'min_days',
    maxDays:'max_days',defaultDays:'default_days',activities:'activities',suggestedBilling:'suggested_billing',enabled:'enabled'},
  rule:{field:'field',matchValue:'match_value',weight:'weight',reason:'reason',enabled:'enabled'}
};
const formField=(form,name)=>forms[form].elements.namedItem(name);
const set=(form,name,value)=>{
  const field=formField(form,name);
  if(field.type==='checkbox')field.checked=Boolean(value);
  else field.value=value??'';
};
const getFields=form=>Object.fromEntries(Object.keys(fields[form]).map(key=>{
  const input=formField(form,key);
  return [key,input.type==='checkbox'?input.checked:input.value];
}));
const number=value=>value===''?null:Number(value);
const lines=value=>value.split('\n').map(line=>line.trim()).filter(Boolean);
const money=value=>value==null?'미산정':new Intl.NumberFormat('ko-KR').format(BigInt(value))+'원';
const pct=value=>value==null?'미산정':value+'%';
const sayError=error=>{
  if(error.status===401)location.assign('/admin-login?next=%2Fadmin%2Fadvertising');
  notice(error.message);
};
function safe(work){return async()=>{try{await work()}catch(error){sayError(error)}}}
function step(name){
  for(const panel of document.querySelectorAll('.workflow-panel'))panel.hidden=panel.id!==name;
  for(const item of get('workflow').querySelectorAll('button')){
    if(item.dataset.step===name)item.setAttribute('aria-current','step');
    else item.removeAttribute('aria-current');
  }
}
function discard(...names){
  const affected=names.filter(name=>dirty.has(name));
  if(affected.length&&!confirm('저장하지 않은 변경사항이 있습니다. 변경사항을 버릴까요?'))return false;
  for(const name of affected)dirty.delete(name);
  return true;
}
for(const [name,form] of Object.entries(forms))form.addEventListener('input',()=>dirty.add(name));
window.addEventListener('beforeunload',event=>{
  if(dirty.size){event.preventDefault();event.returnValue=''}
});
for(const item of get('workflow').querySelectorAll('button'))item.onclick=()=>step(item.dataset.step);
function onForm(name,work){
  forms[name].onsubmit=async event=>{
    event.preventDefault();
    const submit=event.submitter;
    if(submit)submit.disabled=true;
    try{await work()}catch(error){sayError(error)}
    finally{if(submit)submit.disabled=false}
  };
}
function selectOptions(select,rows,textOf,currentValue,placeholder){
  const empty=node('option',placeholder);
  empty.value='';
  select.replaceChildren(empty,...rows.map(row=>{
    const option=node('option',textOf(row));option.value=row.id;return option;
  }));
  select.value=rows.some(row=>row.id===currentValue)?currentValue:'';
}
function fill(form,row){
  forms[form].reset();
  for(const [key,column] of Object.entries(fields[form])){
    if(row?.[column]===undefined)continue;
    let value=row[column];
    if(['opensAt','startsAt','endsAt'].includes(key))value=localTime(value);
    if(['contractStart','contractEnd'].includes(key)&&value)value=String(value).slice(0,10);
    if(['purchaseRate','vatRate'].includes(key)&&value!=null)value=value/100;
    if(Array.isArray(value))value=value.join('\n');
    if(value!==null)set(form,key,value);
  }
}
function fillLead(row){
  selection.lead=row;
  fill('lead',row);
  if(!row)set('lead','industry',current.company?.industry);
  get('recommendations').replaceChildren();
  renderLists();
}
function defaultPeriod(days){
  const tomorrow=localTime(Date.now()+86400000).slice(0,10);
  const end=new Date(tomorrow+'T00:00:00Z');
  end.setUTCDate(end.getUTCDate()+days);
  set('proposal','opensAt',tomorrow+'T09:00');
  set('proposal','startsAt',tomorrow+'T09:00');
  set('proposal','endsAt',end.toISOString().slice(0,10)+'T00:00');
}
function fillProposal(row){
  selection.proposal=row;
  fill('proposal',row);
  const locked=Boolean(row&&row.status!=='draft');
  for(const field of Object.keys(fields.proposal))formField('proposal',field).disabled=locked||(field==='leadId'&&!!row);
  get('saveProposal').disabled=locked;
  if(!row){
    set('proposal','leadId',selection.lead?.id||current.leads[0]?.id);
    const pkg=catalogs.packages.find(item=>item.enabled);
    if(pkg)set('proposal','packageId',pkg.id);
    defaultPeriod(pkg?.default_days||3);
  }
  get('preview').hidden=true;
  renderLists();
  renderProposalActions();
}
function fillContract(row,linked=selection.proposal){
  selection.contract=row;
  fill('contract',row);
  const locked=Boolean(row&&!editContracts.has(row.status));
  for(const key of Object.keys(fields.contract))formField('contract',key).disabled=locked||(key==='proposalId'&&!!row);
  get('saveContract').disabled=locked;
  if(!row&&linked){
    set('contract','proposalId',linked.id);
    const pkg=catalogs.packages.find(item=>item.id===linked.package_id);
    if(pkg)set('contract','billingMode',pkg.suggested_billing);
    set('contract','contractStart',localTime(linked.starts_at).slice(0,10));
    set('contract','contractEnd',localTime(new Date(Date.parse(linked.ends_at)-1)).slice(0,10));
  }
  toggleBilling();
  showEstimate(row?.estimate_krw,row?.vat_mode);
  renderLists();
  renderContractActions();
}
function fillPackage(row){
  selection.package=row;
  fill('package',row);
  fillRule(null);
  renderCatalog();
}
function fillRule(row){
  selection.rule=row;
  fill('rule',row);
  if(!row)set('rule','enabled',true);
  renderCatalog();
}
function rowButtons(id,items,selected,textOf,load,form){
  get(id).replaceChildren(...items.map(row=>{
    const item=button(textOf(row),async()=>{if(discard(form))load(row)});
    item.classList.toggle('active',selected?.id===row.id);
    return item;
  }));
}
function renderLists(){
  rowButtons('leadItems',current.leads,selection.lead,row=>labels[row.goal]+' · '+fmt(row.created_at),fillLead,'lead');
  rowButtons('proposalItems',current.proposals,selection.proposal,row=>row.title+' · '+labels[row.status],fillProposal,'proposal');
  rowButtons('contractItems',current.contracts,selection.contract,row=>row.proposal_title+' · '+labels[row.status],fillContract,'contract');
}
function renderCatalog(){
  rowButtons('packageItems',catalogs.packages,selection.package,row=>row.name+(row.enabled?'':' (비활성)'),
    row=>{if(discard('rule'))fillPackage(row)},'package');
  rowButtons('ruleItems',catalogs.rules.filter(item=>item.package_id===selection.package?.id),selection.rule,
    row=>row.field+' · '+row.match_value+(row.enabled?'':' (꺼짐)'),fillRule,'rule');
}
function renderReport(){
  const report=get('companyReport');
  if(!current.company){report.replaceChildren(node('p','광고주를 선택하세요.'));return}
  const company=current.company;
  report.replaceChildren(node('article'));
  const header=report.firstChild;
  header.append(node('h3',company.brand+' · '+company.name),
    node('p',company.industry+' · '+(company.enabled?'운영 중':'비활성')),
    node('p','담당자 '+(company.contact_name||'미등록')+' · '+(company.contact_info||'미등록')),
    node('p','상담 '+current.leads.length+'건 · 제안 '+current.proposals.length+'건 · 계약 '+current.contracts.length+'건'),
    node('p',current.actualSettlement?'확정 정산서 '+current.actualSettlement.finalized+'건 · 총 청구 예정 '+
      money(current.actualSettlement.planned_total):'확정된 정산서가 없습니다.'));
  for(const row of current.contracts){
    const item=node('article');
    item.append(node('h3',row.proposal_title),node('p',labels[row.status]+' · '+labels[row.billing_mode]+
      ' · 예상 광고비 '+money(row.estimate_krw)));
    report.append(item);
  }
  for(const row of current.campaigns){
    const item=node('article');
    item.append(link(row.title,'/admin/campaigns?edit='+row.id),node('p',(states[row.status]||row.status)+
      ' · 참가 '+row.participants+'명 · 퀴즈 제출 '+row.quiz_submitters+'명 · 미션 완료 '+row.mission_completers+'명'),
      node('p','참여율 '+pct(row.participationRate)+' (실제 참가 ÷ 예상 참여) · 완료율 '+pct(row.completionRate)));
    report.append(item);
  }
  if(current.logs.length){
    const history=node('details');
    history.append(node('summary','최근 상담·제안·계약 변경 이력'));
    const list=node('ul');
    const actionNames={lead_create:'상담 등록',lead_update:'상담 수정',proposal_create:'제안 작성',
      proposal_update:'제안 수정',proposal_finalized:'제안 확정',proposal_sent:'전달 기록',proposal_cancelled:'제안 취소',
      contract_create:'계약 조건 등록',contract_update:'계약 조건 수정',campaign_draft:'캠페인 초안 생성'};
    for(const row of current.logs)list.append(node('li',fmt(row.occurred_at)+' · '+
      (actionNames[row.action]||labels[row.action.replace('contract_','')]||row.action)));
    history.append(list);report.append(history);
  }
}
async function refresh(){
  const data=await ads('/dashboard'+(companyId?'?companyId='+companyId:''));
  current={leads:[],proposals:[],contracts:[],campaigns:[],logs:[],...data};
  selectOptions(companySelect,current.companies,row=>row.brand+' · '+row.name,companyId,'광고주 선택');
  const d=current.totals;
  get('overview').textContent='활성 광고주 '+d.advertisers+'곳 · 제안 '+d.proposals+'건 · 계약 '+d.contracts+
    '건 · 운영 캠페인 '+d.active_campaigns+'건 · 참가 '+d.participants+'명 · 퀴즈 제출 '+d.quiz_submitters+
    '명 · 미션 완료 '+d.mission_completers+'명';
  const a=formField('proposal','leadId'),b=formField('proposal','packageId'),c=formField('contract','proposalId');
  selectOptions(a,current.leads,row=>labels[row.goal]+' · '+fmt(row.created_at),a.value,'상담 선택');
  selectOptions(b,catalogs.packages.filter(row=>row.enabled||row.id===selection.proposal?.package_id),
    row=>row.name,b.value,'상품 선택');
  selectOptions(c,current.proposals.filter(row=>row.status!=='cancelled'||row.id===selection.contract?.proposal_id),
    row=>row.title,c.value,'제안 선택');
  renderLists();
  renderReport();
}
async function selectCompany(id){
  companyId=id;
  await refresh();
  fillLead(null);fillProposal(null);fillContract(null);
}
companySelect.onchange=safe(async()=>{
  if(!discard('lead','proposal','contract')){companySelect.value=companyId;return}
  await selectCompany(companySelect.value);
});
onForm('company',async()=>{
  const data=Object.fromEntries(new FormData(forms.company));
  if(!discard('lead','proposal','contract'))return;
  const result=await admin('/companies','POST',data);
  dirty.delete('company');forms.company.reset();
  await selectCompany(result.company.id);notice('광고주를 등록했습니다.');
});
function leadBody(){
  if(!companyId)throw Error('광고주를 먼저 선택하세요.');
  const body=getFields('lead');
  return {...body,companyId,desiredDays:number(body.desiredDays)};
}
onForm('lead',async()=>{
  const record=selection.lead;
  const result=await ads('/leads'+(record?'/'+record.id:''),record?'PUT':'POST',leadBody());
  dirty.delete('lead');await refresh();fillLead(result.lead);notice('상담 내용을 저장했습니다.');
});
get('newLead').onclick=()=>{if(discard('lead'))fillLead(null)};
get('recommend').onclick=safe(async()=>{
  if(!forms.lead.reportValidity())return;
  const {recommendations}=await ads('/recommend','POST',leadBody());
  get('recommendations').replaceChildren(...recommendations.map(rec=>{
    const item=node('article');
    const reasons=node('ul');
    for(const reason of rec.reasons)reasons.append(node('li',reason));
    const plan=node('p',rec.activities.join(' · '));
    item.append(node('h3',rec.name),node('p',names[rec.eventType]+' · '+rec.durationDays+
      '일 · '+labels[rec.billingMode]),reasons,plan,button('제안에 적용',async()=>{
      if(!selection.lead||dirty.has('lead'))throw Error('이 상담을 먼저 저장하세요.');
      if(!discard('proposal'))return;
      fillProposal(null);
      set('proposal','leadId',selection.lead.id);
      set('proposal','packageId',rec.packageId);
      set('proposal','eventType',rec.eventType);
      set('proposal','title',current.company.brand+' '+rec.name+' 캠페인');
      set('proposal','description',rec.activities.join('\n'));
      set('proposal','activities',rec.activities.join('\n'));
      set('proposal','recommendationReason',rec.reasons.join('\n'));
      set('proposal','benefitNotes',selection.lead.benefits);
      defaultPeriod(rec.durationDays);
      dirty.add('proposal');step('proposal');
    }));
    return item;
  }));
});
function proposalBody(){
  const data=getFields('proposal');
  return {...data,activities:lines(data.activities),expectedReach:number(data.expectedReach),
    opensAt:iso(data.opensAt),startsAt:iso(data.startsAt),endsAt:iso(data.endsAt),
    revision:selection.proposal?.revision};
}
onForm('proposal',async()=>{
  const record=selection.proposal;
  const {proposal}=await ads('/proposals'+(record?'/'+record.id:''),record?'PUT':'POST',proposalBody());
  dirty.delete('proposal');await refresh();fillProposal(proposal);notice('제안 초안을 저장했습니다.');
});
get('newProposal').onclick=()=>{if(discard('proposal'))fillProposal(null)};
get('showPreview').onclick=safe(async()=>{
  if(!forms.proposal.reportValidity())return;
  const data=proposalBody();
  const pkg=catalogs.packages.find(row=>row.id===data.packageId);
  const agreement=current.contracts.find(row=>row.proposal_id===selection.proposal?.id);
  const plan=node('ul');
  const billing=node('div');
  if(agreement){
    const payers={advertiser:'광고주',platform:'플랫폼',shared:'분담',none:'해당 없음'};
    const cycles={end_of_campaign:'캠페인 종료 시',monthly:'월간',weekly:'주간'};
    billing.append(node('p',labels[agreement.billing_mode]+' · 예상 '+money(agreement.estimate_krw)+' · '+labels[agreement.vat_mode]),
      node('p','계약 기간 '+agreement.contract_start+' ~ '+agreement.contract_end+
        ' · 상한 '+(agreement.cap_krw==null?'미설정':money(agreement.cap_krw))),
      node('p','혜택 부담 '+payers[agreement.discount_payer]+' · 정산 주기 '+cycles[agreement.settlement_cycle]));
    if(agreement.fixed_fee_krw)billing.append(node('p','고정 광고비 '+money(agreement.fixed_fee_krw)));
    if(agreement.unit_fee_krw)billing.append(node('p','검증된 쿠폰 실사용 건당 '+money(agreement.unit_fee_krw)));
    if(agreement.purchase_rate_bps)billing.append(node('p','확인된 구매액의 '+agreement.purchase_rate_bps/100+'%'));
    billing.append(node('p','실제 정산은 쿠폰·정산 메뉴에서 확인'));
  }else billing.append(node('p','저장된 광고비 조건이 없습니다.'));
  for(const item of data.activities)plan.append(node('li',item));
  get('preview').replaceChildren(node('h3','제안서 미리보기'),node('p',current.company?.brand||''),node('h3',data.title),
    node('p',(pkg?.name||'')+' · '+names[data.eventType]+' · '+fmt(data.startsAt)+' ~ '+fmt(data.endsAt)+' KST'),
    node('p',data.description),node('p',data.recommendationReason),plan,
    node('p','혜택 · '+(data.benefitNotes||'미기재')),node('p','참가 조건 · '+(data.joinTerms||'미기재')),
    billing);
  get('preview').hidden=false;
});
function renderProposalActions(){
  const area=get('proposalActions'),row=selection.proposal;
  area.replaceChildren();
  if(!row)return;
  const act=(text,command)=>button(text,async()=>{
    if(dirty.has('proposal'))throw Error('변경사항을 먼저 저장하세요.');
    const data=await ads('/proposals/'+row.id+'/commands','POST',{command,revision:row.revision});
    await refresh();fillProposal(data.proposal);notice('제안 상태를 반영했습니다.');
  });
  if(row.status==='draft')area.append(act('제안 확정','finalize'));
  if(row.status==='finalized')area.append(act('전달 기록','mark_sent'));
  if(row.status!=='cancelled'&&!row.campaign_id)area.append(act('제안 취소','cancel'));
  if(row.status!=='cancelled')area.append(button('광고비·계약 조건',async()=>{
    if(!discard('contract'))return;
    fillContract(current.contracts.find(item=>item.proposal_id===row.id)||null,row);
    step('contract');
  }));
  if(row.campaign_id)area.append(link('캠페인 편집','/admin/campaigns?edit='+row.campaign_id,true));
  else if(['finalized','sent'].includes(row.status))area.append(button('캠페인 초안 만들기',async()=>{
    const data=await ads('/proposals/'+row.id+'/create-campaign','POST',{});
    await refresh();fillProposal(current.proposals.find(item=>item.id===row.id));
    notice('캠페인을 초안으로 저장했습니다. 기업 이벤트 화면에서 검토할 수 있습니다.');
  }));
}
function contractBody(){
  const data=getFields('contract');
  return {...data,projectedCouponUses:number(data.projectedCouponUses),
    evidenceLevel:data.billingMode!=='fixed'&&data.performanceBasis==='validated_purchase'?'external':data.evidenceLevel,
    vatRateBps:data.vatRate===''?1000:Math.round(Number(data.vatRate)*100),
    purchaseRateBps:data.purchaseRate===''?null:Math.round(Number(data.purchaseRate)*100),
    revision:selection.contract?.revision};
}
function toggleBilling(){
  const value=formField('contract','billingMode').value;
  const basis=formField('contract','performanceBasis').value;
  for(const field of forms.contract.querySelectorAll('[data-billing]')){
    const type=field.dataset.billing;
    field.hidden=type==='fixed'?value==='performance':type==='performance'?value==='fixed':
      value==='fixed'||(type==='coupon'?basis!=='validated_coupon':basis!=='validated_purchase');
  }
}
formField('contract','billingMode').onchange=toggleBilling;
formField('contract','performanceBasis').onchange=toggleBilling;
formField('contract','proposalId').onchange=()=>{
  const record=current.proposals.find(item=>item.id===formField('contract','proposalId').value);
  const existing=current.contracts.find(item=>item.proposal_id===record?.id);
  if(existing){fillContract(existing,record);return}
  if(record){
    set('contract','contractStart',localTime(record.starts_at).slice(0,10));
    set('contract','contractEnd',localTime(new Date(Date.parse(record.ends_at)-1)).slice(0,10));
  }
};
function showEstimate(value,vat){
  get('estimate').textContent='예상 광고비 '+money(value)+(vat?' · '+labels[vat]:'');
}
get('calcEstimate').onclick=safe(async()=>{
  if(!forms.contract.reportValidity())return;
  const result=await ads('/estimate','POST',contractBody());
  showEstimate(result.estimate,result.vatMode);
});
onForm('contract',async()=>{
  const selected=selection.contract;
  const {contract}=await ads('/contracts'+(selected?'/'+selected.id:''),selected?'PUT':'POST',contractBody());
  dirty.delete('contract');await refresh();fillContract(contract);notice('계약 조건을 저장했습니다.');
});
get('newContract').onclick=()=>{if(discard('contract'))fillContract(null)};
function renderContractActions(){
  const area=get('contractActions'),record=selection.contract;
  area.replaceChildren();
  if(!record)return;
  area.append(node('p',labels[record.status]),...(transitions[record.status]||[]).map(status=>button(labels[status],async()=>{
    if(dirty.has('contract'))throw Error('조건을 먼저 저장하세요.');
    if(['cancelled','confirmed','ended'].includes(status)&&!confirm(labels[status]+' 상태로 변경할까요?'))return;
    const {contract}=await ads('/contracts/'+record.id+'/commands','POST',{status,revision:record.revision});
    await refresh();fillContract(contract);notice('계약 상태를 반영했습니다.');
  })));
}
onForm('package',async()=>{
  if(!selection.package)throw Error('상품을 선택하세요.');
  const data=getFields('package');
  const payload={...data,minDays:Number(data.minDays),maxDays:Number(data.maxDays),defaultDays:Number(data.defaultDays),
    activities:lines(data.activities)};
  const {package:item}=await ads('/packages/'+selection.package.id,'PUT',payload);
  catalogs=await ads('/packages');dirty.delete('package');
  selection.package=item;fill('package',item);renderCatalog();await refresh();
  notice('상품 설정을 저장했습니다.');
});
onForm('rule',async()=>{
  if(!selection.package)throw Error('상품을 선택하세요.');
  const data=getFields('rule'),record=selection.rule;
  const {rule}=await ads('/rules'+(record?'/'+record.id:''),record?'PUT':'POST',
    {...data,packageId:selection.package.id,weight:Number(data.weight)});
  catalogs=await ads('/packages');dirty.delete('rule');fillRule(rule);notice('추천 규칙을 저장했습니다.');
});
get('newRule').onclick=()=>{if(discard('rule'))fillRule(null)};
step('consult');
safe(async()=>{
  catalogs=await ads('/packages');
  await refresh();
  fillPackage(catalogs.packages[0]||null);
  const defaultCompany=current.companies.find(row=>row.enabled);
  if(defaultCompany)await selectCompany(defaultCompany.id);
})()
