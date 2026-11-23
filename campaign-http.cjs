const {CampaignError,isUUID,requireValue}=require('./campaign-validation.cjs');
function createCampaignHTTP({campaigns,publish,authorized,send,serve,readBody,deviceHash,validDevice,routeError,clock}){
  const {tx,query}=campaigns;
  const assets={
    '/campaigns.js':['campaigns.js','application/javascript; charset=utf-8'],
    '/campaign-admin.js':['campaign-admin.js','application/javascript; charset=utf-8'],
    '/campaign-ui.js':['campaign-ui.js','application/javascript; charset=utf-8'],
    '/campaign.css':['campaign.css','text/css; charset=utf-8']
  };
  const commands=new Set(['publish','pause','resume','complete','cancel']);
  return function handle(req,res,url){
    const {pathname}=url;
    if(req.method==='GET'){
      if(Object.hasOwn(assets,pathname)){serve(res,...assets[pathname]);return true}
      if(/^\/campaigns\/[0-9a-f-]+$/i.test(pathname)){serve(res,'campaign.html');return true}
      if(pathname==='/admin/campaigns'){
        if(authorized(req))serve(res,'campaign-admin.html');
        else{
          res.writeHead(302,{Location:'/admin-login?next=%2Fadmin%2Fcampaigns','Cache-Control':'no-store'});
          res.end();
        }
        return true;
      }
    }
    const adminPath=/^\/api\/v1\/admin\/(companies|campaigns)(?:\/([^/]+))?(?:\/(commands))?$/.exec(pathname);
    const publicPath=/^\/api\/v1\/campaigns(?:\/([^/]+)(?:\/(join|quiz\/submit|my-progress|results|missions\/([0-9]+)\/submit))?)?$/.exec(pathname);
    const preferencePath=pathname==='/api/v1/me/campaign-notification-preferences';
    if(!adminPath&&!publicPath&&!preferencePath)return false;
    const admin=!!adminPath;
    if(admin&&!authorized(req)){send(res,401,{error:'관리자 인증이 필요합니다'});return true}
    const id=admin?adminPath[2]:publicPath?.[1];
    if(id&&!isUUID(id)){send(res,400,{error:'이벤트 또는 기업 ID를 확인하세요'});return true}
    const token=req.headers['x-rps-device'];
    const hash=validDevice(token)?deviceHash(token):null;
    const route=publicPath?.[2];
    const method=req.method;
    async function dispatch(body={}){
      const at=clock();
      let result,status=200;
      if(admin){
        const [,resource,,suffix]=adminPath;
        if(!id&&method==='GET'){
          result=resource==='companies'
            ?{companies:await tx(client=>query(client,'SELECT * FROM sponsor_companies ORDER BY created_at DESC'))}
            :{campaigns:await tx(client=>query(client,`SELECT c.*,b.brand FROM sponsor_campaigns c
              JOIN sponsor_companies b ON b.id=c.company_id ORDER BY c.created_at DESC LIMIT 200`))};
        }else if(resource==='companies'&&!suffix&&((!id&&method==='POST')||(id&&method==='PUT'))){
          result={company:await campaigns.saveCompany(id,body)};
          status=id?200:201;
        }else if(resource==='campaigns'&&!suffix&&((!id&&method==='POST')||(id&&method==='PUT'))){
          result={campaign:await campaigns.saveCampaign(id,body)};
          status=id?200:201;
        }else if(resource==='campaigns'&&id&&!suffix&&method==='GET'){
          result=await tx(client=>campaigns.management(client,id));
        }else if(resource==='campaigns'&&id&&suffix&&method==='POST'){
          requireValue(commands.has(body.command),'운영 명령을 확인하세요');
          const action=await campaigns.command(id,body.command,at);
          publish(action?.update);
          if(action?.error)return send(res,409,{error:action.error});
          result={campaign:action.campaign};
        }
      }else if(preferencePath&&['GET','PUT'].includes(method)){
        requireValue(hash,'브라우저 참가 식별자가 필요합니다');
        if(method==='PUT')requireValue(typeof body.eventUpdates==='boolean'&&typeof body.advertising==='boolean',
          '두 알림 설정을 확인하세요');
        result=await tx(client=>campaigns.preferences(client,hash,method==='PUT'?body:undefined));
      }else if(!id&&method==='GET'){
        result=await tx(client=>campaigns.listings(client,hash,at));
      }else if(id&&!route&&method==='GET'){
        result=await campaigns.detail(id,hash,at);
      }else if(route==='results'&&method==='GET'){
        result=await tx(async client=>{
          const row=await campaigns.find(client,id);
          requireValue(campaigns.isPublic(row),'이벤트를 찾을 수 없습니다',404);
          requireValue(row.status==='completed','종료 후 결과를 볼 수 있습니다',409);
          return {results:await campaigns.results(client,row)};
        });
      }else if(route==='my-progress'&&method==='GET'){
        requireValue(hash,'브라우저 참가 식별자가 필요합니다');
        result=(await campaigns.detail(id,hash,at)).progress;
      }else if(route&&method==='POST'){
        requireValue(hash,'브라우저 참가 식별자가 필요합니다');
        if(route==='join')result=await campaigns.join(id,hash,body,at);
        else if(route==='quiz/submit')result=await campaigns.submitQuiz(id,hash,body,at);
        else if(publicPath[3])result=await campaigns.submitMission(id,Number(publicPath[3]),hash,body,at);
      }
      return result===undefined?send(res,404,{error:'찾을 수 없습니다'}):send(res,status,result);
    }
    const respond=body=>dispatch(body).catch(error=>{
      if(error instanceof CampaignError)return send(res,error.status,{error:error.message});
      routeError(res,error);
    });
    if(['PUT','POST'].includes(method))readBody(req,res,respond,256*1024);
    else respond();
    return true;
  };
}
module.exports={createCampaignHTTP};
