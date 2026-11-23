'use strict';
const {get,node,button,link,api,localTime,iso,fmt}=CampaignUI;
const call=(path,method='GET',body)=>api('/admin/coupons'+path,method,body,true);
const msg=value=>{get('feedback').textContent=value};
const number=value=>new Intl.NumberFormat('ko-KR').format(BigInt(value??0));
const won=value=>number(value)+'원';
const states={available:'사용 가능',used:'사용 완료',suspended:'사용 중지',cancelled:'취소',expired:'기간 만료',
  approved:'승인 완료',partially_refunded:'부분 환불',refunded:'전액 환불',pending:'검토 대기',rejected:'거절',
  collecting:'집계 중',needs_review:'검토 필요',reviewed:'검토 완료',finalized:'확정'};
const eligibility={quiz_complete:'퀴즈 제출 완료',quiz_score:'퀴즈 기준 점수',all_missions:'모든 미션 완료',winner:'협찬 토너먼트 우승'};
let companyId='',data={companies:[],campaigns:[],stores:[]},billing={contracts:[],settlements:[]},chosen=null;
const active={policy:null,store:null,staff:null};
const forms={};
const fields={
  policy:[
    ['campaignId','캠페인','select','campaign_id'],['name','쿠폰명','text'],['description','설명','textarea'],
    ['terms','사용 조건','textarea'],['exclusions','제외 조건','textarea'],
    ['minimum','최소 구매액 (원)','integer','minimum_krw'],['discount','정액 할인 (원)','integer','discount_krw'],
    ['issueStart','발급 시작 (KST)','datetime-local','issue_starts_at'],['issueEnd','발급 종료 (KST)','datetime-local','issue_ends_at'],
    ['validFrom','사용 시작 (KST)','datetime-local','valid_from'],['validUntil','사용 종료 (KST)','datetime-local','valid_until'],
    ['inventory','총 발급 수량','number'],['perPerson','참가자당 수량','number','per_person'],
    ['storeIds','사용 매장 (복수 선택)','multiple','store_ids'],['eligibility','발급 조건','select'],
    ['minimumScore','최소 점수 (점수형 정책)','number','minimum_score'],['active','사용 중','checkbox']
  ],
  store:[['name','매장명','text'],['address','매장 주소','text'],['active','매장 운영 중','checkbox']],
  staff:[['storeId','소속 매장','select','store_id'],['username','직원 ID','text'],
    ['displayName','직원 표시 이름','text','display_name'],['password','비밀번호 (신규 또는 변경 시 12자 이상)','password'],
    ['active','계정 활성화','checkbox'],['canRequestCancel','취소 요청 가능','checkbox','can_request_cancel']]
};
function error(error){
  if(error.status===401)location.assign('/admin-login?next=%2Fadmin%2Fcoupons');
  msg(error.message);
}
for(const item of get('couponTabs').querySelectorAll('button')){
  item.onclick=()=>{
    for(const panel of document.querySelectorAll('.coupon-panel'))panel.hidden=panel.id!==item.dataset.tab;
    for(const other of get('couponTabs').querySelectorAll('button'))other.removeAttribute('aria-current');
    item.setAttribute('aria-current','page');
  };
}
get('couponTabs').querySelector('button').click();

function options(input,choices,value,blank){
  const items=choices.map(([id,title])=>{
    const option=node('option',title);option.value=id;return option;
  });
  if(blank){const option=node('option',blank);option.value='';items.unshift(option)}
  input.replaceChildren(...items);
  if(value!=null)input.value=value;
}
function editor(kind,row){
  active[kind]=row||null;
  const form=node('form');form.className='campaign-form';
  forms[kind]=form;
  const grid=node('div');grid.className='campaign-grid';
  for(const [name,title,type,column] of fields[kind]){
    const label=node('label',title);
    const input=node(['select','multiple'].includes(type)?'select':type==='textarea'?'textarea':'input');
    input.name=name;
    if(input.tagName==='INPUT')input.type=type==='integer'?'text':type;
    if(type==='integer'){input.inputMode='numeric';input.pattern='[0-9]{1,14}'}
    if(type==='number'){input.min='0';input.step='1'}
    if(type==='multiple')input.multiple=true;
    if(type==='password'){input.autocomplete='new-password';input.minLength=12}
    const value=row?.[column||name];
    if(name==='campaignId')options(input,data.campaigns.map(x=>[x.id,x.title]),value,'캠페인 선택');
    if(['storeId','storeIds'].includes(name)){
      options(input,data.stores.map(x=>[x.id,x.name]),typeof value==='string'?value:null,name==='storeId'?'매장 선택':null);
      if(Array.isArray(value))for(const option of input.options)option.selected=value.includes(option.value);
    }
    if(name==='eligibility')options(input,Object.entries(eligibility),value);
    if(type==='checkbox'){input.checked=value??(name==='active'&&kind!=='policy');label.prepend(input);grid.append(label);continue}
    if(!['select','multiple'].includes(type)){
      input.value=value==null?(name==='perPerson'?'1':''):type==='datetime-local'?localTime(value):String(value);
    }
    input.required=['campaignId','name','minimum','discount','issueStart','issueEnd','validFrom','validUntil',
      'inventory','perPerson','storeIds','storeId','username','displayName'].includes(name)||(name==='password'&&!row);
    if((name==='campaignId'||name==='storeId')&&row)input.disabled=true;
    label.append(input);grid.append(label);
  }
  form.append(grid);
  const control=node('div');control.className='campaign-controls';
  const save=node('button',row?'수정 저장':'등록');
  control.append(save,button('새 항목',async()=>editor(kind,null)));form.append(control);
  form.onsubmit=async event=>{
    event.preventDefault();
    if(!companyId){msg('기업을 선택하세요.');return}
    const payload={companyId};
    for(const [name,,type] of fields[kind]){
      const input=form.elements.namedItem(name);
      payload[name]=type==='checkbox'?input.checked:type==='multiple'?[...input.selectedOptions].map(x=>x.value):
        type==='datetime-local'?iso(input.value):type==='number'?(input.value===''?null:Number(input.value)):input.value;
    }
    const resource={policy:'policies',store:'stores',staff:'staff'}[kind];
    save.disabled=true;
    try{
      await call('/'+resource+(row?'/'+row.id:''),row?'PUT':'POST',payload);
      await refresh();msg('저장했습니다.');
    }catch(e){error(e)}finally{save.disabled=false}
  };
  get(kind+'Editor').replaceChildren(form);
}
function editItems(target,items,kind,describe){
  get(target).replaceChildren(...items.map(row=>button(describe(row),async()=>editor(kind,row))));
}
async function action(path,body){
  await call(path,'POST',body);await refresh();msg('처리했습니다.');
}
function cards(target,rows,draw){
  get(target).replaceChildren(...(rows.length?rows.map(draw):[node('p','기록이 없습니다.')]));
}
function renderTrades(){
  cards('issueList',data.issuances||[],row=>{
    const card=node('article');
    const state=row.status==='available'?(Date.now()>=Date.parse(row.valid_until)?'expired':!row.active?'suspended':'available'):row.status;
    card.append(node('p',row.name+' · '+states[state]+' · '+fmt(row.issued_at)));
    if(['available','suspended'].includes(row.status)){
      card.append(button(row.status==='available'?'사용 중지':'다시 사용 가능',()=>action('/issuances/'+row.id+'/status',
        {status:row.status==='available'?'suspended':'available'})));
      card.append(button('발급 취소',async()=>{if(confirm('이 쿠폰 발급을 취소할까요?'))await action('/issuances/'+row.id+'/status',{status:'cancelled'})}));
    }
    return card;
  });
  cards('tradeList',data.redemptions||[],row=>{
    const card=node('article');
    card.append(node('h3',row.store_name+' · '+states[row.status]),node('p',fmt(row.approved_at)+' · 매장 확인 결제액 '+won(row.paid_krw)),
      node('p',(row.external_verified_at?'관리자 확인 외부 증빙 있음':'매장 입력 금액 · 외부 증빙 없음')+
        ' · '+(row.recognized?'확정 정산에 포함됨':'확정 정산 미포함')));
    if(['approved','partially_refunded'].includes(row.status)){
      if(!row.external_verified_at)card.append(button('POS·영수증 증빙 확인 등록',async()=>{
        const reference=prompt('확인한 POS 거래 또는 영수증 고유 참조를 입력하세요.');
        if(!reference)return;
        const amount=prompt('증빙에서 확인한 할인 후 원결제액을 입력하세요.');
        if(amount!==null)await action('/redemptions/'+row.id+'/evidence',{reference,amount});
      }));
      card.append(button('확인된 환불 기록',async()=>{
        const refund=prompt('검증한 환불액을 입력하세요.');
        if(!refund)return;
        const reference=prompt('환불 증빙 참조를 입력하세요.');
        if(!reference)return;
        const reason=prompt('환불 사유를 입력하세요.');
        if(reason)await action('/redemptions/'+row.id+'/refund',{refund,reference,reason});
      }));
    }
    return card;
  });
  cards('adjustmentList',data.adjustments||[],row=>{
    const card=node('article');
    card.append(node('h3',(row.kind==='refund'?'환불':'취소')+' · '+states[row.status]),node('p',row.reason));
    if(row.status==='approved')card.append(node('p',row.settlement_applied?'정산 조정 반영 완료':
      row.originated_in_settlement?'차기 조정 대상':'원 정산 집계 시 반영'));
    if(row.status==='pending'){
      card.append(button('취소 확정',async()=>{
        if(confirm('원거래를 취소할까요?'))await action('/adjustments/'+row.id+'/decision',{command:'approve'});
      }),button('요청 거절',()=>action('/adjustments/'+row.id+'/decision',{command:'reject'})));
    }
    return card;
  });
}
function showSettlement(row){
  chosen=row;
  const s=row.snapshot,target=get('settlementDetail');
  target.replaceChildren(node('h3',row.period_start+' ~ '+row.period_end+' · '+(row.adjustment_needed?'조정 필요':states[row.status])),
    node('p','인정 '+s.recognizedCount+'건 · 확인 구매 '+won(s.recognizedPurchase)+' · 제외 '+s.excluded.length+'건'),
    node('p','고정 '+won(s.fixed)+' · 성과 '+won(s.performance)+' · 조정 '+won(s.adjustment)+' · 상한 차감 '+won(s.capApplied)),
    node('p','공급가액 '+won(s.supply)+' · VAT '+won(s.vat)+' · 총 예정액 '+won(s.total)),
    link('CSV 다운로드','/api/v1/admin/coupons/settlements/'+row.id+'/csv',true));
  if(s.items.length||s.adjustments.length||s.excluded.length){
    const items=node('details');items.append(node('summary','대상 거래와 제외 사유'));
    const list=node('ul');
    for(const item of s.items)list.append(node('li',item.id+' · '+(item.proof==='external'?'외부 증빙':'매장 인증')+' · '+won(item.purchase)));
    for(const item of s.adjustments)list.append(node('li','조정 '+item.id+' · '+item.countDelta+'건 · '+won(item.purchaseDelta)));
    for(const item of s.excluded)list.append(node('li','제외 '+item.id+' · '+(item.reason==='reversed'?'취소·전액 환불':'외부 증빙 필요')));
    items.append(list);target.append(items);
  }
  const command=(type,label)=>button(label,async()=>{
    if(type==='finalize'&&!confirm('이 정산서를 확정할까요? 확정서는 감사용으로 보관됩니다.'))return;
    const result=await call('/contracts/'+row.contract_id+'/'+type,'POST',{settlementId:row.id});
    await refresh();showSettlement(result.settlement);msg('정산 상태를 반영했습니다.');
  });
  if(['collecting','needs_review'].includes(row.status))target.append(command('review','검토 완료'));
  if(row.status==='reviewed')target.append(command('finalize','정산 확정'));
}
async function refresh(){
  data=await call('/dashboard'+(companyId?'?companyId='+companyId:''));
  options(get('companies'),data.companies.map(row=>[row.id,row.brand+' · '+row.name]),companyId,'기업 선택');
  const stats=data.stats;
  get('couponStats').textContent=stats?'발급 '+data.policies.reduce((sum,row)=>sum+row.issued,0)+'건 · 사용 가능 '+
    data.policies.reduce((sum,row)=>sum+row.available,0)+'건 · 매장 승인 '+stats.approved+'건 · 취소·전액 환불 '+stats.cancelled+
    '건 · 확정 인정 '+stats.recognized+'건 · 정산 제외 '+stats.excluded+'건 · 미확정 '+(stats.not_recognized-stats.excluded)+'건':'기업을 선택하세요.';
  editItems('policyList',data.policies||[],'policy',row=>row.name+' · 발급 '+row.issued);
  editItems('storeList',data.stores||[],'store',row=>row.name+(row.active?'':' (중지)'));
  editItems('staffList',data.staff||[],'staff',row=>row.display_name+(row.active?'':' (중지)'));
  for(const [kind,key] of Object.entries({policy:'policies',store:'stores',staff:'staff'}))
    editor(kind,(data[key]||[]).find(row=>row.id===active[kind]?.id));
  renderTrades();
  billing=companyId?await call('/settlements?companyId='+companyId):{contracts:[],settlements:[]};
  options(get('contracts'),billing.contracts.map(row=>[row.id,row.title]),get('contracts').value,'계약 선택');
  get('settlementList').replaceChildren(...billing.settlements.map(row=>button(
    row.title+' · '+row.period_start+' · '+(row.adjustment_needed?'조정 필요':states[row.status]),async()=>showSettlement(row))));
  if(chosen){
    const item=billing.settlements.find(row=>row.id===chosen.id);
    if(item)showSettlement(item);
  }
}
get('companies').onchange=async()=>{
  companyId=get('companies').value;chosen=null;
  get('settlementDetail').replaceChildren();
  for(const key of Object.keys(active))active[key]=null;
  try{await refresh()}catch(e){error(e)}
};
get('collect').onclick=async()=>{
  const contract=get('contracts').value;
  if(!contract){msg('확정된 계약을 선택하세요.');return}
  try{
    const result=await call('/contracts/'+contract+'/collect','POST',{});
    await refresh();showSettlement(result.settlement);msg('정산 기간을 집계했습니다.');
  }catch(e){error(e)}
};
refresh().catch(error);
