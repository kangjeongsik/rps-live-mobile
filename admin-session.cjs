const crypto=require('node:crypto');
const secret=crypto.createHash('sha256')
  .update('rps-session-v1:'+String(process.env.ADMIN_PASSWORD||'')+':'+String(process.env.ADMIN_USER||'admin')).digest();
const lifetime=7*24*60*60;
const attempts=new Map();
const checked=new WeakMap();
function signature(value){return crypto.createHmac('sha256',secret).update(value).digest('hex')}
function equal(a,b){
  const left=Buffer.from(a),right=Buffer.from(b);
  return left.length===right.length&&crypto.timingSafeEqual(left,right);
}
function isAdminSession(req){
  const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('rps_admin='))?.slice(10);
  if(!token)return false;
  const parts=token.split('.');
  const [expires,proof]=parts;
  return parts.length===2&&/^\d{13}$/.test(expires)&&Number(expires)>Date.now()&&
    Number(expires)<=Date.now()+lifetime*1000&&/^[a-f0-9]{64}$/.test(proof||'')&&equal(proof,signature(expires));
}
function session(res,value,maxAge){
  res.setHeader('Set-Cookie','rps_admin='+value+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age='+maxAge);
}
function createAdminSession(res){
  const expiry=String(Date.now()+lifetime*1000);
  session(res,expiry+'.'+signature(expiry),lifetime);
}
function clearAdminSession(res){session(res,'',0)}
function loginResult(req,user,password){
  const key=req.socket.remoteAddress||'unknown';
  const now=Date.now();
  if(attempts.size>1024)for(const [key,entry] of attempts)if(entry.until<=now)attempts.delete(key);
  const current=attempts.get(key);
  const entry=current?.until>now?current:{count:0,until:now+10*60000};
  if(entry.count>=12||(!current&&attempts.size>=4096))return 429;
  const pass=process.env.ADMIN_PASSWORD||'';
  if(pass.length>=12&&typeof user==='string'&&typeof password==='string'&&
    equal(user,process.env.ADMIN_USER||'admin')&&equal(password,pass))return 200;
  entry.count++;
  attempts.set(key,entry);
  return 401;
}
function authorized(req){
  if(isAdminSession(req))return true;
  if(checked.has(req))return checked.get(req);
  const auth=req.headers.authorization||'';
  if(!auth.startsWith('Basic '))return false;
  const decoded=Buffer.from(auth.slice(6),'base64').toString('utf8');
  const end=decoded.indexOf(':');
  const status=loginResult(req,end>=0?decoded.slice(0,end):'',end>=0?decoded.slice(end+1):'');
  const ok=status===200;
  checked.set(req,ok);
  return ok;
}
module.exports={isAdminSession,createAdminSession,clearAdminSession,loginResult,authorized};
