const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const {timingSafeEqual}=require('node:crypto');

function createDailyHTTP({store,daily,dailyMutation,runDailySchedule,authorized,send,serve,
  readBody,deviceHash,validDevice,routeError,vapidPublicKey,schedulerToken}){
  const tx=store.transaction;
  const publicRows=`SELECT d.event_id,d.service_date::text AS service_date,d.game_type,d.status,
    d.scheduled_at,d.opened_at,d.started_at,d.ended_at,d.wait_until,e.join_code,
    (SELECT count(*)::int FROM daily_reservations WHERE event_id=d.event_id AND status='reserved') AS reservations,
    (SELECT count(*)::int FROM daily_participations WHERE event_id=d.event_id) AS participants
    FROM daily_occurrences d JOIN rps_events e ON e.id=d.event_id`;

  async function dashboard(client,hash){
    const {rows:dailyRows}=await client.query(`SELECT d.*,r.status AS reservation_status,r.notify,
      (p.device_hash IS NOT NULL) AS joined
      FROM (${publicRows}) d LEFT JOIN daily_reservations r
        ON r.event_id=d.event_id AND r.device_hash=$1
      LEFT JOIN daily_participations p ON p.event_id=d.event_id AND p.device_hash=$1
      WHERE d.service_date >= (now() AT TIME ZONE 'Asia/Seoul')::date::text
      ORDER BY d.service_date LIMIT 7`,[hash]);
    const {rows:[{today}]}=await client.query(
      "SELECT ((now() AT TIME ZONE 'Asia/Seoul')::date)::text AS today");
    const events=await client.query(`SELECT e.id AS event_id,e.join_code,
        coalesce(d.status,e.status) AS status,d.service_date::text AS service_date,
        (d.event_id IS NOT NULL) AS daily,r.snapshot#>>'{game,round}' AS round,
        r.snapshot->'game'->'champion'=to_jsonb(m.value->>0) AS won
      FROM rps_events e JOIN rps_event_runtime r ON r.event_id=e.id
      LEFT JOIN daily_occurrences d ON d.event_id=e.id
      LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(coalesce(r.snapshot->'players','[]'))
        WHERE value->1->>'deviceHash'=$1 AND coalesce(value->1->>'left','false')<>'true' LIMIT 1) m ON true
      WHERE r.retired_at IS NULL AND NOT EXISTS (SELECT 1 FROM sponsor_campaigns WHERE event_id=e.id) AND (m.value IS NOT NULL OR EXISTS (
        SELECT 1 FROM daily_reservations WHERE event_id=e.id AND device_hash=$1 AND status='reserved'))
      ORDER BY e.created_at DESC LIMIT 30`,[hash]);
    const available=await client.query(`SELECT e.id AS event_id,e.join_code,e.status,
      r.snapshot#>>'{game,round}' AS round
      FROM rps_events e JOIN rps_event_runtime r ON r.event_id=e.id
      LEFT JOIN daily_occurrences d ON d.event_id=e.id
      WHERE d.event_id IS NULL AND r.listed AND r.retired_at IS NULL
      AND coalesce(r.snapshot#>>'{game,mode}','nickname')<>'verified'
      AND e.status IN ('lobby','ready','playing') ORDER BY e.created_at DESC LIMIT 30`);
    const history=await client.query(`SELECT d.event_id,d.service_date::text AS service_date,d.status,
      (r.snapshot#>>'{game,champion}'=p.participant_id) AS won
      FROM daily_participations p JOIN daily_occurrences d ON d.event_id=p.event_id
      JOIN rps_event_runtime r ON r.event_id=d.event_id WHERE p.device_hash=$1
      ORDER BY d.service_date DESC LIMIT 15`,[hash]);
    const totals=await client.query(`SELECT count(*)::int AS joined,
      count(*) FILTER (WHERE r.snapshot#>>'{game,champion}'=p.participant_id)::int AS wins
      FROM daily_participations p JOIN rps_event_runtime r ON r.event_id=p.event_id
      WHERE p.device_hash=$1`,[hash]);
    return {today:dailyRows.find(row=>row.service_date===today)||null,
      next:dailyRows.find(row=>row.service_date>today)||null,events:events.rows,
      available:available.rows,history:history.rows,totals:totals.rows[0]};
  }

  async function adminDashboard(client){
    const schedules=await client.query('SELECT * FROM daily_schedules ORDER BY id');
    const occurrences=await client.query(publicRows+
      ' ORDER BY service_date DESC LIMIT 14');
    const executions=await client.query(`SELECT event_id,action,executed_at
      FROM daily_execution_log ORDER BY id DESC LIMIT 25`);
    const notifications=await client.query(`SELECT event_id,status,count(*)::int AS count
      FROM daily_notification_jobs WHERE event_id IN
      (SELECT event_id FROM daily_occurrences ORDER BY service_date DESC LIMIT 14)
      GROUP BY event_id,status ORDER BY event_id,status`);
    return {schedules:schedules.rows,occurrences:occurrences.rows,executions:executions.rows,
      notifications:notifications.rows};
  }

  async function preferences(client,hash,value){
    if(value!==undefined)await client.query(`INSERT INTO daily_notification_preferences(device_hash,daily_start)
      VALUES($1,$2) ON CONFLICT(device_hash) DO UPDATE SET daily_start=$2`,[hash,value]);
    if(value){
      const now=new Date();
      const {rows}=await client.query(`SELECT d.event_id FROM daily_occurrences d
        JOIN daily_reservations r ON r.event_id=d.event_id AND r.device_hash=$1
        WHERE d.status IN ('open','playing') AND d.opened_at >= $2::timestamptz-interval '5 minutes'
          AND r.status='reserved' AND r.notify`,[hash,now]);
      for(const row of rows)await daily.enqueue(client,row.event_id,now,hash);
    }
    const {rows:[row]}=await client.query(`SELECT
      exists(SELECT 1 FROM daily_notification_preferences WHERE device_hash=$1 AND daily_start) AS daily_start,
      exists(SELECT 1 FROM rps_push_subscriptions WHERE device_hash=$1) AS subscribed`,[hash]);
    return {...row,vapidPublicKey};
  }

  return function handle(req,res,url){
    const pathname=url.pathname;
    const assets={'/live.css':['live.css','text/css; charset=utf-8'],
      '/live.js':['live.js','application/javascript; charset=utf-8'],
      '/daily-admin.js':['daily-admin.js','application/javascript; charset=utf-8']};
    if(Object.hasOwn(assets,pathname)&&req.method==='GET'){serve(res,...assets[pathname]);return true}
    if(pathname==='/live'&&req.method==='GET'){serve(res,'live.html');return true}
    if(pathname==='/admin/daily'&&req.method==='GET'){
      if(authorized(req))serve(res,'daily-admin.html');
      else{
        res.writeHead(302,{Location:'/admin-login?next=%2Fadmin%2Fdaily','Cache-Control':'no-store'});
        res.end();
      }
      return true;
    }
    if(pathname==='/api/v1/daily/run'&&req.method==='POST'){
      const expected=Buffer.from(schedulerToken||'');
      const provided=Buffer.from(req.headers.authorization||'');
      const key=Buffer.concat([Buffer.from('Bearer '),expected]);
      if(!expected.length||key.length!==provided.length||!timingSafeEqual(key,provided)){
        send(res,401,{error:'스케줄러 인증이 필요합니다'});
      }else runDailySchedule().then(value=>send(res,200,value)).catch(error=>routeError(res,error));
      return true;
    }
    const isAdmin=pathname.startsWith('/api/v1/admin/daily');
    if(!isAdmin&&!pathname.startsWith('/api/v1/daily/')&&!pathname.startsWith('/api/v1/me/'))return false;
    if(isAdmin&&!authorized(req)){send(res,401,{error:'관리자 로그인이 필요합니다'});return true}
    const device=req.headers['x-rps-device'];
    const hash=validDevice(device)?deviceHash(device):null;
    const self=pathname.startsWith('/api/v1/me/');
    const reservationPath=/^\/api\/v1\/daily\/([^/]+)\/reservations(\/me)?$/.exec(pathname);
    const commandPath=/^\/api\/v1\/admin\/daily\/([^/]+)\/commands$/.exec(pathname);
    if((self||reservationPath)&&!hash){send(res,400,{error:'브라우저 참가 식별자가 필요합니다'});return true}
    if((reservationPath&&!uuid.test(reservationPath[1]))||(commandPath&&!uuid.test(commandPath[1]))){
      send(res,400,{error:'잘못된 이벤트 ID입니다'});return true;
    }
    async function dispatch(body={}){
      let value;
      const method=req.method;
      if(method==='GET'&&pathname==='/api/v1/admin/daily/schedules'){
        value=await tx(adminDashboard);
      }else if(method==='POST'&&pathname==='/api/v1/admin/daily/run'){
        value=await runDailySchedule();
      }else if(method==='PUT'&&pathname==='/api/v1/admin/daily/schedules'){
        const {minPlayers,preparationSeconds,waitMinutes}=body;
        const valid=(number,min,max)=>Number.isInteger(number)&&number>=min&&number<=max;
        if(!valid(minPlayers,2,200)||!valid(preparationSeconds,1,600)||!valid(waitMinutes,1,180))
          return send(res,400,{error:'최소 인원·준비 시간·대기 제한을 확인하세요'});
        await tx(client=>client.query(`UPDATE daily_schedules SET min_players=$1,
          preparation_seconds=$2,wait_minutes=$3 WHERE id='daily-rps'`,[minPlayers,preparationSeconds,waitMinutes]));
        value={ok:true};
      }else if(method==='POST'&&commandPath){
        if(!['start','cancel','resume'].includes(body.command))return send(res,400,{error:'잘못된 명령입니다'});
        const result=await dailyMutation(commandPath[1],async (_client,_row,game)=>{
          const obj=await game.dailyCommand(body.command,new Date());
          return {status:obj.error?409:200,obj};
        });
        return send(res,result.status,result.obj);
      }else if(reservationPath&&((method==='POST'&&!reservationPath[2])||(method==='DELETE'&&reservationPath[2]))){
        const result=await dailyMutation(reservationPath[1],async (client,row)=>{
          const obj=await daily.reservation(client,row,hash,new Date(),method==='DELETE',body.notify===true);
          return {status:obj.error?409:200,obj};
        });
        return send(res,result.status,result.obj);
      }else if(pathname==='/api/v1/me/notification-preferences'&&['GET','PUT'].includes(method)){
        if(method==='PUT'&&typeof body.dailyStart!=='boolean')return send(res,400,{error:'알림 설정을 확인하세요'});
        value=await tx(client=>preferences(client,hash,method==='PUT'?body.dailyStart:undefined));
      }else if(method==='GET'&&['/api/v1/daily/today','/api/v1/daily/next','/api/v1/me/events',
        '/api/v1/me/daily-history','/api/v1/me/home'].includes(pathname)){
        const home=await tx(client=>dashboard(client,hash));
        const values={'/api/v1/daily/today':{event:home.today},'/api/v1/daily/next':{event:home.next},
          '/api/v1/me/events':{events:home.events,available:home.available},
          '/api/v1/me/daily-history':{history:home.history,totals:home.totals}};
        value=values[pathname]||home;
      }else return send(res,404,{error:'찾을 수 없습니다'});
      return send(res,200,value);
    }
    if(['POST','PUT'].includes(req.method))readBody(req,res,dispatch);
    else dispatch().catch(error=>routeError(res,error));
    return true;
  };
}
module.exports={createDailyHTTP};
