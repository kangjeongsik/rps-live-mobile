const {randomUUID}=require('node:crypto');
const terminal=new Set(['finished','cancelled','expired']);
const openForEntry=row=>row&&['scheduled','open'].includes(row.status);
const dayExpression="(\$1::timestamptz AT TIME ZONE 'Asia/Seoul')::date";

function createDaily(store,initialSnapshot){
  const tx=store.transaction;
  async function occurrence(client,id){
    const {rows}=await client.query('SELECT *, service_date::text AS date_key FROM daily_occurrences WHERE event_id=$1',[id]);
    return rows[0];
  }

  async function ensure(client,schedule,date,now){
    const find=async()=>(await client.query(
      'SELECT event_id,status FROM daily_occurrences WHERE schedule_id=$1 AND service_date=$2',
      [schedule.id,date])).rows[0];
    const existing=await find();
    if(existing)return existing;
    if(!schedule.enabled||schedule.game_type!=='rps_tournament')return null;
    // Recheck under the schedule/date lock before creating its engine event.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",['daily:'+schedule.id,date]);
    const concurrent=await find();
    if(concurrent)return concurrent;
    const event=await store.create(client,initialSnapshot('nickname'));
    await client.query(`INSERT INTO daily_occurrences(event_id,schedule_id,service_date,game_type,
       scheduled_at,min_players,preparation_seconds,wait_minutes,updated_at)
       VALUES ($1,$2,$3,$4,($3::date+$5::time) AT TIME ZONE 'Asia/Seoul',$6,$7,$8,$9)`,
    [event.id,schedule.id,date,schedule.game_type,schedule.start_time,schedule.min_players,
      schedule.preparation_seconds,schedule.wait_minutes,now]);
    await log(client,event.id,'create',now,'create');
    return {event_id:event.id,status:'scheduled'};
  }

  async function log(client,id,action,now,key){
    await client.query(`INSERT INTO daily_execution_log(event_id,execution_key,action,executed_at)
      VALUES($1,$2,$3,$4) ON CONFLICT(execution_key) DO NOTHING`,
    [id,id+':'+key,action,now]);
  }

  async function ensureNext(client,row,now){
    const {rows:[schedule]}=await client.query(
      'SELECT *, ($2::date+1)::text AS next_date FROM daily_schedules WHERE id=$1',
      [row.schedule_id,row.date_key]);
    return ensure(client,schedule,schedule.next_date,now);
  }

  async function recover(now){
    return tx(async client=>{
      const {rows}=await client.query(`SELECT *,
        ${dayExpression}::text AS today, (${dayExpression}+1)::text AS tomorrow
        FROM daily_schedules WHERE enabled ORDER BY id`,[now]);
      for(const schedule of rows){
        const today=await ensure(client,schedule,schedule.today,now);
        if(today&&terminal.has(today.status))await ensure(client,schedule,schedule.tomorrow,now);
      }
      const due=await client.query(`SELECT d.event_id FROM daily_occurrences d
        LEFT JOIN daily_schedules s ON s.id=d.schedule_id
        WHERE s.enabled AND ((d.status='scheduled' AND d.scheduled_at <= $1)
        OR (d.status='open' AND d.wait_until <= $1)
        OR (d.status='open' AND d.ready_at <= $1 AND
          (SELECT count(*) FROM jsonb_array_elements(
            coalesce((SELECT snapshot->'players' FROM rps_event_runtime WHERE event_id=d.event_id),'[]'))) >= d.min_players))
        ORDER BY d.scheduled_at LIMIT 50`,[now]);
      return due.rows.map(row=>row.event_id);
    });
  }

  async function transition(client,row,status,now,source){
    const {rows:[fresh]}=await client.query(`UPDATE daily_occurrences SET status=$2,updated_at=$3,
      opened_at=CASE WHEN $2='open' THEN $3 ELSE opened_at END,
      ready_at=CASE WHEN $2='open' THEN $3::timestamptz + (preparation_seconds * interval '1 second') ELSE ready_at END,
      wait_until=CASE WHEN $2='open' THEN
        CASE WHEN $4='schedule' THEN scheduled_at ELSE $3 END + (wait_minutes * interval '1 minute')
        ELSE wait_until END,
      started_at=CASE WHEN $2='playing' THEN $3 ELSE started_at END,
      ended_at=CASE WHEN $2='scheduled' OR $2='open' THEN NULL
        WHEN $2 IN ('finished','cancelled','expired') THEN $3 ELSE ended_at END
      WHERE event_id=$1 RETURNING *, service_date::text AS date_key`,[row.event_id,status,now,source]);
    await log(client,row.event_id,status,now,status+':'+randomUUID());
    if(status==='open')await enqueue(client,row.event_id,now);
    if(status==='cancelled')await client.query(
      'UPDATE rps_event_runtime SET next_action_at=NULL WHERE event_id=$1',[row.event_id]);
    if(terminal.has(status))await ensureNext(client,fresh,now);
    return fresh;
  }

  async function enqueue(client,eventId,now,deviceHash=null){
    await client.query(`INSERT INTO daily_notification_jobs(event_id,device_hash,next_attempt_at)
      SELECT r.event_id,r.device_hash,$2 FROM daily_reservations r
      JOIN daily_notification_preferences p ON p.device_hash=r.device_hash AND p.daily_start
      WHERE r.event_id=$1 AND r.status='reserved' AND r.notify AND ($3::text IS NULL OR r.device_hash=$3)
      ON CONFLICT(event_id,device_hash,kind) DO UPDATE SET status='pending',next_attempt_at=$2,last_error=NULL
      WHERE daily_notification_jobs.status='skipped' AND daily_notification_jobs.attempts=0
      `,[eventId,now,deviceHash]);
  }

  async function reservation(client,row,deviceHash,now,cancel,notify){
    if(!openForEntry(row))return {error:'예약이 마감되었습니다'};
    if(cancel){
      await client.query(`UPDATE daily_reservations SET status='cancelled',cancelled_at=$3
        WHERE event_id=$1 AND device_hash=$2 AND status='reserved'`,[row.event_id,deviceHash,now]);
      return {status:'cancelled'};
    }
    const {rows:[reservation]}=await client.query(`INSERT INTO daily_reservations
      (id,event_id,device_hash,reserved_at,status,notify,participant_id,joined_at)
      VALUES($1,$2,$3,$4,'reserved',$5,
        (SELECT participant_id FROM daily_participations WHERE event_id=$2 AND device_hash=$3),
        (SELECT joined_at FROM daily_participations WHERE event_id=$2 AND device_hash=$3))
      ON CONFLICT(event_id,device_hash) DO UPDATE SET status='reserved',cancelled_at=NULL,
        reserved_at=CASE WHEN daily_reservations.status='cancelled' THEN excluded.reserved_at
          ELSE daily_reservations.reserved_at END,notify=excluded.notify
      RETURNING id,status,reserved_at`,[randomUUID(),row.event_id,deviceHash,now,notify]);
    if(row.status==='open')await enqueue(client,row.event_id,now,deviceHash);
    return reservation;
  }

  async function participant(client,row,deviceHash,id,now){
    await client.query(`INSERT INTO daily_participations(event_id,device_hash,participant_id,joined_at)
      VALUES($1,$2,$3,$4) ON CONFLICT(event_id,device_hash) DO UPDATE SET participant_id=$3`,
    [row.event_id,deviceHash,id,now]);
    await client.query(`UPDATE daily_reservations SET participant_id=$3,joined_at=coalesce(joined_at,$4)
      WHERE event_id=$1 AND device_hash=$2`,[row.event_id,deviceHash,id,now]);
  }

  return {occurrence,recover,transition,ensure,ensureNext,reservation,participant,enqueue};
}
module.exports={createDaily,openForEntry,terminal};
