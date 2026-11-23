'use strict';
const {get,node,button,api,fmt}=CampaignUI;
const route=(path,method='GET',body)=>api('/store'+path,method,body,true);
const notice=message=>{get('feedback').textContent=message};
const money=value=>new Intl.NumberFormat('ko-KR').format(BigInt(value))+'원';
const states={approved:'승인 완료',cancelled:'취소',refunded:'전액 환불',partially_refunded:'부분 환불'};
let staff,verified,requestId,code='',media;
function submit(id,work){
  get(id).onsubmit=async event=>{
    event.preventDefault();
    const btn=event.submitter;
    if(btn)btn.disabled=true;
    try{await work(Object.fromEntries(new FormData(event.currentTarget)))}
    catch(error){notice(error.message);if(error.status===401&&id!=='storeLogin')showLogin()}
    finally{if(btn)btn.disabled=false}
  };
}
function showLogin(){
  staff=null;get('loginPanel').hidden=false;get('storePanel').hidden=true;
}
async function session(){
  const result=await route('/session');
  staff=result.staff;get('storeName').textContent=staff.storeName+' · '+staff.displayName;
  get('loginPanel').hidden=true;get('storePanel').hidden=false;
  await history();
}
async function history(){
  const {redemptions}=await route('/redemptions');
  get('storeHistory').replaceChildren(...(redemptions.length?redemptions.map(row=>{
    const item=node('article');
    item.append(node('p',fmt(row.approved_at)+' · '+states[row.status]),
      node('p','할인 전 '+money(row.before_discount_krw)+' · 할인 '+money(row.discount_krw)+
        ' · 매장 확인 결제액 '+money(row.paid_krw)));
    if(row.pending)item.append(node('p','관리자 취소 검토 중'));
    else if(staff.canRequestCancel&&['approved','partially_refunded'].includes(row.status)){
      item.append(button('취소 요청',async()=>{
        const reason=prompt('취소 사유를 입력하세요.');
        if(!reason)return;
        await route('/redemptions/'+row.id+'/cancel-request','POST',{reason});
        notice('관리자에게 취소를 요청했습니다.');await history();
      }));
    }
    return item;
  }):[node('p','승인 내역이 없습니다.')]));
}
async function check(value,newChallenge=false){
  const previous=code===value?verified?.challenge:null;
  const data=await route('/coupons/verify','POST',{code:value,newChallenge});
  verified={...data,challenge:data.challenge||previous};
  if(code!==value){requestId=null;get('redeemForm').reset()}
  code=value;
  const target=get('verification');
  target.replaceChildren(node('h3',data.name),node('p','최소 구매액 '+money(data.minimum)+' · 정액 할인 '+money(data.discount)),
    node('p',data.terms),node('p',data.exclusions));
  if(data.ownerConfirmed)target.append(node('p','참가자 확인 완료'));
  else{
    target.append(node('p',verified.challenge?'고객에게 확인 번호 '+verified.challenge+'를 알려주세요.':'고객 확인 번호가 필요합니다.'),
      button('참가자 확인 갱신',()=>check(code)),button('확인 번호 다시 만들기',()=>check(code,true)));
  }
  get('redeemForm').hidden=!data.ownerConfirmed;
}
submit('storeLogin',async body=>{
  await route('/login','POST',body);get('storeLogin').reset();await session();
});
submit('verifyForm',body=>check(body.code.trim()));
submit('redeemForm',async body=>{
  requestId??=crypto.randomUUID();
  await route('/coupons/redeem','POST',{...body,code,requestId});
  notice('쿠폰 사용을 승인했습니다.');get('redeemForm').hidden=true;
  get('verification').replaceChildren(node('p','사용 완료'));get('verifyForm').reset();
  verified=null;code='';requestId=null;await history();
});
get('storeLogout').onclick=async()=>{
  try{await route('/logout','POST',{});showLogin();notice('로그아웃했습니다.')}
  catch(error){notice(error.message)}
};
function stop(){
  if(media)for(const track of media.getTracks())track.stop();
  media=null;get('scanner').hidden=true;
}
if('BarcodeDetector' in window&&navigator.mediaDevices?.getUserMedia){
  get('scan').hidden=false;
  get('scan').onclick=async()=>{
    try{
      stop();
      const detector=new BarcodeDetector({formats:['qr_code']});
      media=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}});
      const video=get('scanner');video.srcObject=media;video.hidden=false;await video.play();
      for(let tick=0;media&&tick<120;tick++){
        const [match]=await detector.detect(video);
        if(match){
          const value=match.rawValue.trim();
          if(!/^[\w-]{32}$/.test(value))throw Error('LIVE 쿠폰 형식을 확인하세요.');
          stop();get('verifyForm').elements.code.value=value;await check(value);return;
        }
        await new Promise(done=>setTimeout(done,250));
      }
      stop();notice('쿠폰 코드를 직접 입력할 수 있습니다.');
    }catch{stop();notice('카메라를 사용하기 어렵습니다. 쿠폰 코드를 직접 입력하세요.')}
  };
}
window.addEventListener('pagehide',stop);
session().catch(error=>{if(error.status!==401)notice(error.message);showLogin()});
