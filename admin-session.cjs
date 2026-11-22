const crypto=require('crypto');
const secret=crypto.createHash('sha256').update('rps-session-v1:'+String(process.env.ADMIN_PASSWORD||'')+':'+String(process.env.ADMIN_USER||'admin')).digest();
function sign(data){return crypto.createHmac('sha256',secret).update(data).digest('hex')}
function isAdminSession(req){const c=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('rps_admin='));if(!c)return false;const value=c.slice(10);const parts=value.split('.');if(parts.length!==2)return false;const [expires,sig]=parts;if(!/^\d+$/.test(expires)||Number(expires)<Date.now())return false;const expected=sign(expires);return sig.length===expected.length&&crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))}
function createAdminSession(res){const expires=String(Date.now()+7*24*60*60*1000);res.setHeader('Set-Cookie',`rps_admin=${expires}.${sign(expires)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`)}
function clearAdminSession(res){res.setHeader('Set-Cookie','rps_admin=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0')}
module.exports={isAdminSession,createAdminSession,clearAdminSession};
