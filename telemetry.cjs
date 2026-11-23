const events={};
function record(name,status,now=new Date(),processed){
  const entry=events[name]||{ok:0,failed:0,lastSuccess:null,lastFailure:null,lastRun:null};
  entry.lastRun=now.toISOString();
  if(status<400){entry.ok++;entry.lastSuccess=entry.lastRun}
  else{entry.failed++;entry.lastFailure=entry.lastRun}
  if(Number.isSafeInteger(processed))entry.lastProcessed=processed;
  events[name]=entry;
}
function observe(path,method,res){
  let kind;
  if(path==='/api/v1/daily/run')kind='schedulerTrigger';
  else if(path.includes('/api/v1/campaigns/')||path.startsWith('/api/v1/admin/campaigns/'))kind='campaignRequests';
  else if(path==='/api/v1/store/coupons/redeem')kind='couponRedemption';
  else if(path.startsWith('/api/v1/admin/coupons/contracts/'))kind='settlementRequests';
  if(kind)res.once('finish',()=>record(kind,res.statusCode));
}
module.exports={record,observe,metrics:()=>structuredClone(events)};
