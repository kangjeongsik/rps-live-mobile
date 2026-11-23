const {requireValue,isUUID,text,dateIndex}=require('./campaign-validation.cjs');
const goals=['store_visit','brand_awareness','engagement','consultation','other'];
const eventTypes=['quiz','mission','rps'];
const billingModes=['fixed','performance','hybrid'];
const fields=['goal','industry','has_store','needs_consultation','benefits','duration','budget','audience'];
const maxMoney=99999999999999n;
const enabled=value=>value!==false;
const id=(value,label)=>{requireValue(isUUID(value),label+'을 확인하세요');return value};
const allowed=(value,items,label)=>{
  requireValue(items.includes(value),label+'을 확인하세요');return value;
};
const integer=(value,min,max,label,optional=false)=>{
  if(optional&&(value===null||value===undefined||value===''))return null;
  requireValue(Number.isInteger(value)&&value>=min&&value<=max,label+' 범위를 확인하세요');
  return value;
};
const amount=(value,label,optional=true)=>{
  if(optional&&(value===null||value===undefined||value===''))return null;
  requireValue((typeof value==='string'||typeof value==='number')&&/^\d{1,14}$/.test(String(value)),label+'은 원 단위 숫자로 입력하세요');
  return BigInt(value).toString();
};
const list=value=>{
  requireValue(Array.isArray(value)&&value.length>=1&&value.length<=31,'구성 항목은 1~31개를 입력하세요');
  return value.map(item=>text(item,300,1));
};
function dateOnly(value){
  requireValue(typeof value==='string'&&/^\d{4}-\d\d-\d\d$/.test(value),'날짜를 확인하세요');
  const date=new Date(value+'T00:00:00Z');
  requireValue(Number.isFinite(+date)&&date.toISOString().slice(0,10)===value,'날짜를 확인하세요');
  return value;
}
function instant(value){
  requireValue(typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value),
    '시간대가 포함된 운영 일시를 입력하세요');
  dateOnly(value.slice(0,10));
  const date=new Date(value);
  requireValue(Number.isFinite(+date),'운영 일시를 확인하세요');
  return date;
}
function lead(body){
  return {
    company_id:id(body.companyId,'기업'),industry:text(body.industry,100,1),goal:allowed(body.goal,goals,'광고 목적'),
    goal_note:text(body.goalNote,500),budget_krw:amount(body.budget,'예산'),
    desired_days:integer(body.desiredDays,1,31,'희망 기간',true),audience:text(body.audience,500),
    has_store:body.hasStore===true,benefits:text(body.benefits,1200),needs_consultation:body.needsConsultation===true,
    consultation_note:text(body.consultationNote,3000)
  };
}
function pkg(body){
  const min=integer(body.minDays,1,31,'최소 기간');
  const max=integer(body.maxDays,min,31,'최대 기간');
  return {name:text(body.name,120,1),description:text(body.description,1000,1),
    event_type:allowed(body.eventType,eventTypes,'게임 유형'),min_days:min,max_days:max,
    default_days:integer(body.defaultDays,min,max,'기본 기간'),activities:JSON.stringify(list(body.activities)),
    suggested_billing:allowed(body.suggestedBilling,billingModes,'권장 광고비 방식'),enabled:enabled(body.enabled)};
}
function rule(body){
  const field=allowed(body.field,fields,'규칙 항목');
  const match=text(body.matchValue,300,1);
  if(['has_store','needs_consultation'].includes(field))requireValue(['true','false'].includes(match),'참·거짓 조건을 확인하세요');
  if(field==='duration')integer(Number(match),1,31,'기간 조건');
  if(field==='budget')amount(match,'최소 예산',false);
  if(field==='goal')allowed(match,goals,'광고 목적');
  return {field,match_value:match,weight:integer(body.weight,1,1000,'가중치'),
    reason:text(body.reason,500,1),enabled:enabled(body.enabled)};
}
function proposal(body){
  const opens=instant(body.opensAt),starts=instant(body.startsAt),ends=instant(body.endsAt);
  requireValue(opens<=starts&&starts<ends,'참가 시작, 이벤트 시작, 종료 시각을 확인하세요');
  const days=dateIndex(new Date(+ends-1))-dateIndex(starts)+1;
  requireValue(days>=1&&days<=31,'캠페인 운영 기간은 1~31일입니다');
  return {lead_id:id(body.leadId,'상담'),package_id:id(body.packageId,'광고상품'),title:text(body.title,180,2),
    description:text(body.description,3000),recommendation_reason:text(body.recommendationReason,1500),
    event_type:allowed(body.eventType,eventTypes,'게임 유형'),activities:JSON.stringify(list(body.activities)),
    benefit_notes:text(body.benefitNotes,1200),join_terms:text(body.joinTerms,900),
    opens_at:opens,starts_at:starts,ends_at:ends,expected_reach:integer(body.expectedReach,0,2147483647,'예상 참여',true),
    coupon_policy_id:body.couponPolicyId?id(body.couponPolicyId,'향후 쿠폰 정책'):null};
}
function contract(body){
  const mode=allowed(body.billingMode,billingModes,'광고비 방식');
  const hasFixed=mode!=='performance',hasPerformance=mode!=='fixed';
  const basis=hasPerformance?allowed(body.performanceBasis,['validated_coupon','validated_purchase'],'성과 기준'):null;
  const fixed=hasFixed?amount(body.fixedFee,'고정 광고비',false):null;
  const unit=basis==='validated_coupon'?amount(body.unitFee,'실사용 건당 광고비',false):null;
  const rate=basis==='validated_purchase'?integer(body.purchaseRateBps,1,10000,'수수료율'):null;
  const cap=amount(body.cap,'광고비 상한');
  requireValue((!hasFixed||BigInt(fixed)>0n)&&(!unit||BigInt(unit)>0n)&&(!cap||BigInt(cap)>0n),'광고비와 상한은 양수여야 합니다');
  requireValue(!cap||!fixed||BigInt(cap)>=BigInt(fixed),'광고비 상한은 고정 광고비 이상이어야 합니다');
  const uses=basis==='validated_coupon'?integer(body.projectedCouponUses,0,2147483647,'예상 실사용 건수',true):null;
  const purchases=basis==='validated_purchase'?amount(body.projectedPurchase,'예상 확인 구매액'):null;
  const start=dateOnly(body.contractStart),end=dateOnly(body.contractEnd);
  requireValue(start<=end,'계약 기간을 확인하세요');
  let estimate=null;
  if(!hasPerformance||uses!==null||purchases!==null){
    estimate=BigInt(fixed||0);
    if(uses!==null)estimate+=BigInt(unit)*BigInt(uses);
    if(purchases!==null)estimate+=(BigInt(purchases)*BigInt(rate)+5000n)/10000n;
    if(cap!==null&&estimate>BigInt(cap))estimate=BigInt(cap);
    requireValue(estimate<=maxMoney,'예상 광고비가 저장 가능한 최대 범위를 넘습니다');
    estimate=estimate.toString();
  }
  const capScope=allowed(body.capScope??'campaign',['campaign','period'],'상한 적용 범위');
  const evidence=allowed(body.evidenceLevel??(basis==='validated_purchase'?'external':'store'),['store','external'],'정산 증빙');
  requireValue(basis!=='validated_purchase'||evidence==='external','구매액 수수료에는 외부 증빙이 필요합니다');
  const vatRate=integer(body.vatRateBps??1000,0,3000,'VAT 세율');
  return {cap_scope:capScope,evidence_level:evidence,vat_rate_bps:vatRate,billing_mode:mode,performance_basis:basis,fixed_fee_krw:fixed,unit_fee_krw:unit,purchase_rate_bps:rate,cap_krw:cap,
    projected_coupon_uses:uses,projected_purchase_krw:purchases,estimate_krw:estimate,contract_start:start,contract_end:end,
    discount_payer:allowed(body.discountPayer,['advertiser','platform','shared','none'],'할인 부담 주체'),
    vat_mode:allowed(body.vatMode,['exclusive','inclusive','exempt'],'VAT 처리'),
    settlement_cycle:allowed(body.settlementCycle,['end_of_campaign','monthly','weekly'],'정산 주기')};
}

module.exports={id,integer,lead,pkg,rule,proposal,contract};
