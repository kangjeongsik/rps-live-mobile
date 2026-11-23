const {CampaignError,requireValue}=require('./campaign-validation.cjs');
const {uid,secret,validToken}=require('./coupon-store.cjs');
const {csv}=require('./settlement-store.cjs');
const QRCode=require('qrcode');
const cookie=(req,name)=>req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1);
const cookieValue=(name,value,age)=>name+'='+value+'; Path=/api/v1; HttpOnly; Secure; SameSite=Strict; Max-Age='+age;
const actor=()=>process.env.ADMIN_USER||'admin';

function createCouponHTTP({store,settlements,authorized,send,serve,readBody,validDevice,deviceHash,clock}){
  const assets={
    '/coupons.js':['coupons.js','application/javascript; charset=utf-8'],
    '/store-coupons.js':['store-coupons.js','application/javascript; charset=utf-8'],
    '/coupon-admin.js':['coupon-admin.js','application/javascript; charset=utf-8'],
    '/coupons.css':['coupons.css','text/css; charset=utf-8']
  };
  return function handle(req,res,url){
    const {pathname}=url;
    if(req.method==='GET'){
      if(Object.hasOwn(assets,pathname)){serve(res,...assets[pathname]);return true}
      if(pathname==='/store/coupons'){serve(res,'store-coupons.html');return true}
      if(pathname==='/admin/coupons'){
        if(authorized(req))serve(res,'coupon-admin.html');
        else{
          res.writeHead(302,{Location:'/admin-login?next=%2Fadmin%2Fcoupons','Cache-Control':'no-store'});
          res.end();
        }
        return true;
      }
    }
    const admin=/^\/api\/v1\/admin\/coupons(?:\/([a-z-]+))?(?:\/([^/]+))?(?:\/([a-z-]+))?$/.exec(pathname);
    const member=/^\/api\/v1\/me\/coupons(?:\/([^/]+))?(?:\/(present|confirm))?$/.exec(pathname);
    const staff=/^\/api\/v1\/store(?:\/([a-z-]+))(?:\/([^/]+))?(?:\/([a-z-]+))?$/.exec(pathname);
    if(!admin&&!member&&!staff)return false;
    if(admin&&!authorized(req)){send(res,401,{error:'관리자 인증이 필요합니다'});return true}
    const method=req.method;
    if(['POST','PUT'].includes(method)&&!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')){
      send(res,415,{error:'JSON 요청이 필요합니다'});return true;
    }
    async function dispatch(body={}){
      const now=clock();
      let result,status=200;
      if(member){
        const id=member[1]?uid(member[1]):null,command=member[2];
        const token=req.headers['x-rps-device'];
        requireValue(validDevice(token),'브라우저 참가 식별자가 필요합니다');
        const hash=deviceHash(token);
        if(method==='GET'&&!command)result=id?{coupon:(await store.wallet(hash,id,now))[0]}:{coupons:await store.wallet(hash,null,now)};
        if(id&&method==='POST'){
          let owner=cookie(req,'rps_coupon_owner');
          if(command==='present'){
            if(!validToken(owner)){
              owner=secret();res.setHeader('Set-Cookie',cookieValue('rps_coupon_owner',owner,31536000));
            }
            result=await store.present(id,hash,owner,now);
            result.qrPNG=await QRCode.toDataURL(result.code,{width:224,margin:4,errorCorrectionLevel:'M'});
          }
          if(command==='confirm'){
            result=await store.confirmOwner(id,hash,owner,body,now);
            if(result.error)return send(res,result.status,{error:result.error});
          }
        }
      }
      if(staff){
        const [,resource,part,command]=staff;
        const token=cookie(req,'rps_store');
        if(resource==='login'&&method==='POST'&&!part){
          const session=await store.login(req.socket.remoteAddress||'unknown',body);
          res.setHeader('Set-Cookie',cookieValue('rps_store',session,28800));result={ok:true};
        }else if(resource==='logout'&&method==='POST'&&!part){
          await store.logout(token);res.setHeader('Set-Cookie',cookieValue('rps_store','',0));result={ok:true};
        }else if(resource==='session'&&method==='GET'&&!part){
          result={staff:await store.withStaff(token,(_client,account)=>({
            displayName:account.display_name,storeName:account.store_name,canRequestCancel:account.can_request_cancel
          }))};
        }else if(resource==='coupons'&&method==='POST'&&!command){
          if(part==='verify')result=await store.verify(token,body,now);
          if(part==='redeem')result={transaction:await store.redeem(token,body,now)};
        }else if(resource==='redemptions'){
          if(!part&&method==='GET')result={redemptions:await store.history(token)};
          if(part&&command==='cancel-request'&&method==='POST')result={request:await store.requestCancel(token,uid(part),body)};
        }
      }
      if(admin){
        const [,resource,part,command]=admin;
        const id=part?uid(part):null;
        const company=url.searchParams.get('companyId');
        if(company)uid(company,'기업');
        if(resource==='dashboard'&&!id&&method==='GET')result=await store.dashboard(company);
        if(resource==='settlements'&&method==='GET'){
          if(!id&&company)result=await settlements.list(company);
          if(id&&!command)result={settlement:await settlements.get(id)};
          if(id&&command==='csv'){
            const row=await settlements.get(id);
            res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Cache-Control':'no-store',
              'Content-Disposition':'attachment; filename="settlement-'+id+'.csv"'});
            return res.end(csv(row));
          }
        }
        if(!command&&((!id&&method==='POST')||(id&&method==='PUT'))){
          if(resource==='policies')result={policy:await store.savePolicy(id,body)};
          if(resource==='stores')result={store:await store.saveLocation(id,body)};
          if(resource==='staff')result={staff:await store.saveStaff(id,body)};
          if(result&&!id)status=201;
        }
        if(id&&method==='POST'){
          if(resource==='issuances'&&command==='status')result={issuance:await store.setCouponStatus(id,body.status)};
          if(resource==='redemptions'&&command==='evidence')result=await store.evidence(id,body,now);
          if(resource==='redemptions'&&command==='refund')result={adjustment:await store.decide(id,body,now,actor(),true)};
          if(resource==='adjustments'&&command==='decision')result={adjustment:await store.decide(id,body,now,actor())};
          if(resource==='contracts'&&['collect','review','finalize'].includes(command))
            result={settlement:await settlements.run(id,command,now,actor(),command==='collect'?null:uid(body.settlementId,'정산서'))};
        }
      }
      return result===undefined?send(res,404,{error:'찾을 수 없습니다'}):send(res,status,result);
    }
    const respond=body=>dispatch(body).catch(error=>{
      if(error instanceof CampaignError)return send(res,error.status,{error:error.message});
      if(error.code==='23505')return send(res,409,{error:'이미 등록된 항목입니다'});
      console.error('Coupons:',error.code||error.name);
      if(res.headersSent)return res.end();
      send(res,503,{error:'쿠폰·정산 DB 연결과 Phase 5 마이그레이션 상태를 확인하세요'});
    });
    if(['POST','PUT'].includes(method))readBody(req,res,respond,32768);
    else respond();
    return true;
  };
}
module.exports={createCouponHTTP};
