'use strict';
(()=>{
const {get,node,button,api,fmt}=CampaignUI;
const value=amount=>new Intl.NumberFormat('ko-KR').format(BigInt(amount))+'원';
const states={available:'사용 가능',used:'사용 완료',expired:'기간 만료',cancelled:'취소',suspended:'사용 중지'};
const feedback=get('feedback');
function pairing(item,detail){
  const content=node('div');
  content.className='coupon-code';
  if(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(detail.qrPNG||'')){
    const qr=node('img');qr.src=detail.qrPNG;qr.width=224;qr.height=224;
    qr.alt='쿠폰 QR. 아래에 수동 코드도 표시됩니다.';qr.className='coupon-qr';content.append(qr);
  }
  content.append(node('strong',detail.code),node('p','코드 유효시간 '+fmt(detail.expiresAt)+'까지'),
    node('p','매장 직원에게 코드와 아래 확인 절차를 보여주세요. 직원이 알려준 6자리 번호를 입력하면 사용할 수 있습니다.'));
  const form=node('form');
  form.className='campaign-form';
  const label=node('label','매장 확인 번호');
  const input=node('input');
  Object.assign(input,{inputMode:'numeric',pattern:'[0-9]{6}',required:true,maxLength:6,autocomplete:'off'});
  label.append(input);
  form.append(label,node('button','이 매장 사용 확인'));
  form.onsubmit=async event=>{
    event.preventDefault();const submit=event.submitter||form.querySelector('button');submit.disabled=true;
    try{
      await api('/me/coupons/'+item.id+'/confirm','POST',{challenge:input.value});
      form.replaceChildren(node('p','소유 확인 완료. 매장 직원의 최종 승인을 기다려 주세요.'));
      watchApproval(item.id,Date.parse(detail.expiresAt),form);
    }catch(error){feedback.textContent=error.message;submit.disabled=false}
  };
  content.append(form);
  return content;
}
function watchApproval(id,deadline,slot){
  // Stop if the card is replaced or the participant leaves the page.
  setTimeout(async()=>{
    if(!slot.isConnected||Date.now()>deadline)return;
    try{
      const {coupon}=await api('/me/coupons/'+id);
      if(coupon.status!=='available'){await wallet();return}
    }catch{/* The manual refresh remains available during reconnect. */}
    watchApproval(id,deadline,slot);
  },1800);
}
async function wallet(){
  const {coupons}=await api('/me/coupons');
  get('walletItems').replaceChildren(...(coupons.length?coupons.map(row=>{
    const item=node('article');
    item.append(node('p',row.brand+' · '+states[row.status]),node('h3',row.name),
      node('p',value(row.minimum)+' 이상 구매 시 '+value(row.discount)+' 할인'),
      node('p','유효기간 '+fmt(row.validFrom)+' ~ '+fmt(row.validUntil)+' KST'),
      node('p','사용 매장 '+row.stores.map(store=>store.name+(store.address?' ('+store.address+')':'')).join(', ')));
    for(const field of ['description','terms','exclusions'])if(row[field])item.append(node('p',row[field]));
    if(row.usableNow){
      const slot=node('div');
      item.append(button('일회용 코드 표시',async()=>{
        const shown=await api('/me/coupons/'+row.id+'/present','POST',{});
        slot.replaceChildren(pairing(row,shown));
      }),slot);
    }
    return item;
  }):[node('p','보유한 할인쿠폰이 없습니다.')]));
}
get('walletRefresh').onclick=()=>wallet().catch(error=>{feedback.textContent=error.message});
wallet().catch(error=>{feedback.textContent=error.message});
})();
