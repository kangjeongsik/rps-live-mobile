function createDailyPush({store,sender}){
  async function deliver(now,limit=10){
    if(!sender)return 0;
    let count=0;
    for(;count<limit;count++){
      const claimed=await store.transaction(async client=>{
        const {rows:[job]}=await client.query(`SELECT j.id,j.event_id,j.device_hash,j.attempts,e.join_code,
          d.status AS event_status,d.opened_at,r.status AS reserved,r.notify,p.daily_start,s.subscription
          FROM daily_notification_jobs j JOIN daily_occurrences d ON d.event_id=j.event_id
          JOIN rps_events e ON e.id=j.event_id
          LEFT JOIN daily_reservations r ON r.event_id=j.event_id AND r.device_hash=j.device_hash
          LEFT JOIN daily_notification_preferences p ON p.device_hash=j.device_hash
          LEFT JOIN rps_push_subscriptions s ON s.device_hash=j.device_hash
          WHERE j.status IN ('pending','retry') AND j.next_attempt_at<=$1
          ORDER BY j.next_attempt_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,[now]);
        if(!job)return false;
        const eligible=['open','playing'].includes(job.event_status)
          && job.opened_at && now.getTime()-job.opened_at.getTime()<=300000;
        if(!eligible||job.reserved!=='reserved'||!job.notify||!job.daily_start||!job.subscription){
          await client.query("UPDATE daily_notification_jobs SET status='skipped',last_error='not_eligible' WHERE id=$1",[job.id]);
          return true;
        }
        const attempts=job.attempts+1;
        try{
          // Push providers may accept a request before a connection fails. A stable browser tag
          // coalesces any display duplicates following an ambiguous delivery attempt.
          await sender(job.subscription,{title:'DAILY 가위바위보 참가 시작',
            body:job.event_status==='open'?'첫 라운드가 시작되기 전까지 참가할 수 있습니다.'
              :'첫 라운드가 시작되었습니다. 대회 화면에서 진행 상황을 확인하세요.',
            url:'/tournament/join/'+job.join_code,tag:'daily-start-'+job.event_id});
        }catch(error){
          const gone=[404,410].includes(error.statusCode);
          const status=gone||attempts>=4?'failed':'retry';
          await client.query(`UPDATE daily_notification_jobs SET status=$2,attempts=$3,
            next_attempt_at=$4,last_error=$5 WHERE id=$1`,[job.id,status,attempts,
            new Date(now.getTime()+15000*2**(attempts-1)),gone?'expired_subscription':'delivery_failed']);
          return true;
        }
        await client.query(`UPDATE daily_notification_jobs SET status='sent',attempts=$2,
          sent_at=$3,last_error=NULL WHERE id=$1`,[job.id,attempts,now]);
        return true;
      });
      if(!claimed)break;
    }
    return count;
  }
  return {deliver,enabled:Boolean(sender)};
}
module.exports={createDailyPush};
