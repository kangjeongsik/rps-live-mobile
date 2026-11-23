const {CampaignError,requireValue}=require('./campaign-validation.cjs');
const {id:validateId,contract:validateContract}=require('./advertising-validation.cjs');

function createAdvertisingHTTP({service,authorized,send,serve,readBody,routeError}){
  const prefix='/api/v1/admin/advertising';
  const assets={
    '/advertising.js':['advertising.js','application/javascript; charset=utf-8'],
    '/advertising.css':['advertising.css','text/css; charset=utf-8']
  };
  return function handle(req,res,url){
    const {pathname}=url;
    if(pathname==='/admin/advertising'&&req.method==='GET'){
      if(authorized(req))serve(res,'advertising.html');
      else{
        res.writeHead(302,{Location:'/admin-login?next=%2Fadmin%2Fadvertising','Cache-Control':'no-store'});
        res.end();
      }
      return true;
    }
    if(Object.hasOwn(assets,pathname)&&req.method==='GET'){serve(res,...assets[pathname]);return true}
    if(pathname!==prefix&&!pathname.startsWith(prefix+'/'))return false;
    if(!authorized(req)){send(res,401,{error:'관리자 인증이 필요합니다'});return true}
    const route=/^\/([a-z]+)(?:\/([^/]+))?(?:\/([a-z-]+))?$/.exec(pathname.slice(prefix.length));
    if(!route){send(res,404,{error:'찾을 수 없습니다'});return true}
    async function dispatch(body={}){
      const [,resource,item,command]=route;
      const id=item?validateId(item,'항목 ID'):null;
      const company=url.searchParams.get('companyId');
      if(company!==null)validateId(company,'기업 ID');
      let result,status=200;
      const method=req.method;
      if(resource==='dashboard'&&!id&&method==='GET')result=await service.dashboard(company);
      else if(resource==='packages'&&!id&&method==='GET')result=await service.tx(service.catalog);
      else if(resource==='recommend'&&!id&&method==='POST')result=await service.recommend(body);
      else if(resource==='estimate'&&!id&&method==='POST'){
        const estimate=validateContract(body);
        result={estimate:estimate.estimate_krw,fixedFee:estimate.fixed_fee_krw,vatMode:estimate.vat_mode,
          actualSettlement:null};
      }
      else if(resource==='packages'&&id&&!command&&method==='PUT')result={package:await service.savePackage(id,body)};
      else if(resource==='rules'&&!command&&((id&&method==='PUT')||(!id&&method==='POST'))){
        result={rule:await service.saveRule(id,body)};
        status=id?200:201;
      }else if(['leads','proposals','contracts'].includes(resource)&&!command){
        if(method==='GET'&&!id){
          requireValue(company,'기업을 선택하세요');
          result={[resource]:(await service.dashboard(company))[resource]};
        }else if((!id&&method==='POST')||(id&&method==='PUT')){
          const save={leads:service.saveLead,proposals:service.saveProposal,contracts:service.saveContract};
          result={[resource.slice(0,-1)]:await save[resource](body,id)};
          status=id?200:201;
        }
      }else if(resource==='proposals'&&id&&method==='POST'&&command==='create-campaign'){
        result=await service.createDraft(id);
        status=result.created?201:200;
      }else if(id&&method==='POST'&&command==='commands'){
        if(resource==='proposals')result={proposal:await service.proposalCommand(id,body)};
        if(resource==='contracts')result={contract:await service.contractCommand(id,body)};
      }
      return result===undefined?send(res,404,{error:'찾을 수 없습니다'}):send(res,status,result);
    }
    const respond=body=>dispatch(body).catch(error=>{
      if(error instanceof CampaignError)return send(res,error.status,{error:error.message});
      routeError(res,error);
    });
    if(['PUT','POST'].includes(req.method))readBody(req,res,respond,64*1024);
    else respond();
    return true;
  };
}
module.exports={createAdvertisingHTTP};
