const hostnames=['fcm.googleapis.com','android.googleapis.com','updates.push.services.mozilla.com',
  'push.services.mozilla.com','web.push.apple.com','push.apple.com','notify.windows.com'];
function approvedEndpoint(endpoint){
  if(typeof endpoint!=='string'||endpoint.length>2048)return false;
  let url;
  try{url=new URL(endpoint)}catch{return false}
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)return false;
  if(hostnames.some(host=>url.hostname===host||url.hostname.endsWith('.'+host)))return true;
  return (process.env.PUSH_ALLOWED_HOSTS||'').split(',').map(host=>host.trim().toLowerCase())
    .some(host=>host&&url.hostname===host);
}
module.exports={approvedEndpoint};
