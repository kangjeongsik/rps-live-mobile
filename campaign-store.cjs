const {requireValue,isUUID,publicStates,entryStates,currentDay,dateIndex,text,companyInput,campaignInput}=require('./campaign-validation.cjs');
const statesForContent=new Set(['active','paused','completed','cancelled']);
const terminal=new Set(['completed','cancelled']);

function createCampaigns(store,makeSnapshot,engineView,issueCoupon=async()=>{}){
  const tx=store.transaction;
  const now=()=>new Date();
  const query=(client,sql,args)=>client.query(sql,args).then(result=>result.rows);
  const one=async(client,sql,args)=>(await query(client,sql,args))[0];
  const find=(client,id)=>one(client,'SELECT * FROM sponsor_campaigns WHERE id=$1',[id]);
  const affiliate=`SELECT c.*, b.name AS company_name,b.brand,b.logo_url,b.image_url AS company_image,
    b.description AS company_description,b.website_url,e.join_code,r.snapshot#>>'{game,phase}' AS rps_phase
    FROM sponsor_campaigns c JOIN sponsor_companies b ON b.id=c.company_id
    LEFT JOIN rps_events e ON e.id=c.event_id LEFT JOIN rps_event_runtime r ON r.event_id=c.event_id`;
  const findByEvent=(client,id)=>one(client,affiliate+' WHERE c.event_id=$1',[id]);
  const log=(client,id,action,source,at,detail='')=>query(client,`INSERT INTO campaign_activity_logs
    (campaign_id,action,source,occurred_at,detail) VALUES($1,$2,$3,$4,$5)`,[id,action,source,at,detail]);

  async function withLocked(id,work){
    return tx(async client=>{
      const initial=await find(client,id);
      requireValue(initial,'이벤트를 찾을 수 없습니다',404);
      const runtime=initial.event_id?await store.load(client,{eventId:initial.event_id}):null;
      const row=await one(client,'SELECT * FROM sponsor_campaigns WHERE id=$1 FOR UPDATE',[id]);
      return work(client,row,runtime);
    });
  }

  const effective=(row,at)=>at>=row.ends_at?'completed':at>=row.starts_at?'active':
    at>=row.opens_at?'open':'scheduled';
  const isActive=(row,at)=>row.status==='active'&&at>=row.starts_at&&at<row.ends_at;
  const isPublic=row=>row?.published_at&&publicStates.has(row.status);
  const canEnter=(row,at)=>entryStates.has(row.status)&&at>=row.opens_at&&at<row.ends_at;
  const getParticipant=(client,id,hash)=>one(client,
    'SELECT * FROM campaign_participants WHERE campaign_id=$1 AND device_hash=$2',[id,hash]);

  async function enroll(client,row,hash,displayName,at,engineId=null){
    const record=await one(client,`INSERT INTO campaign_participants
      (campaign_id,device_hash,display_name,joined_at,engine_player_id) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(campaign_id,device_hash) DO UPDATE SET engine_player_id=coalesce(excluded.engine_player_id,campaign_participants.engine_player_id),
      display_name=CASE WHEN excluded.engine_player_id IS NULL THEN campaign_participants.display_name ELSE excluded.display_name END
      RETURNING *`,[row.id,hash,displayName,at,engineId]);
    return record;
  }

  async function saveCompany(id,body){
    const values=companyInput(body);
    return tx(async client=>{
      const fields=['name','brand','industry','contact_name','contact_info','description','logo_url',
        'image_url','website_url','enabled','internal_note'];
      const placeholders=values.map((_,index)=>'$'+(index+1));
      const row=id?await one(client,`UPDATE sponsor_companies SET
        ${fields.map((field,index)=>field+'='+placeholders[index]).join(',')},updated_at=now()
        WHERE id=$12 RETURNING *`,[...values,id]):await one(client,
        `INSERT INTO sponsor_companies(${fields.join(',')}) VALUES(${placeholders.join(',')}) RETURNING *`,values);
      requireValue(row,'기업을 찾을 수 없습니다',404);
      return row;
    });
  }

  async function saveCampaign(id,body,options={}){
    const fields=['company_id','type','title','description','image_url','join_terms','ad_goal',
      'estimated_reach','opens_at','starts_at','ends_at','allow_retry'];
    async function save(client,old){
      const linked=Boolean(options.advertising||old?.advertising_plan);
      const input=campaignInput(body,{advertising:linked});
      const placeholders=input.values.map((_,index)=>'$'+(index+1));
      const business=await one(client,'SELECT id FROM sponsor_companies WHERE id=$1',[body.companyId]);
      requireValue(business,'기업을 찾을 수 없습니다',404);
      if(old){
        requireValue(old.status==='draft','게시 전 초안만 수정할 수 있습니다',409);
        requireValue(old.type===body.type,'기존 초안의 이벤트 유형은 바꿀 수 없습니다',409);
        requireValue(!linked||old.company_id===body.companyId,'광고 제안에서 만든 캠페인의 기업은 유지해야 합니다',409);
      }
      const runtime=!old&&body.type==='rps'?await store.create(client,makeSnapshot('nickname')):null;
      let row=old?await one(client,`UPDATE sponsor_campaigns SET
        ${fields.map((field,index)=>field+'='+placeholders[index]).join(',')},updated_at=now()
        WHERE id=$13 RETURNING *`,[...input.values,id]):await one(client,
        `INSERT INTO sponsor_campaigns(${fields.join(',')},event_id)
         VALUES(${placeholders.join(',')},$13) RETURNING *`,[...input.values,runtime?.id||null]);
      if(old){
        await query(client,'DELETE FROM campaign_quiz_questions WHERE campaign_id=$1',[id]);
        await query(client,'DELETE FROM campaign_missions WHERE campaign_id=$1',[id]);
      }
      for(const [index,q] of input.questions.entries())await query(client,
        `INSERT INTO campaign_quiz_questions(campaign_id,position,prompt,choices,correct_index,points)
        VALUES($1,$2,$3,$4,$5,$6)`,[row.id,index+1,q.prompt,JSON.stringify(q.options),q.correctIndex,q.points]);
      for(const [index,m] of input.missions.entries())await query(client,
        `INSERT INTO campaign_missions(campaign_id,day,title,description,kind,content,prompt,choices,correct_index)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[row.id,index+1,m.title,m.description,m.kind,m.content,
        m.prompt,JSON.stringify(m.options),m.correctIndex]);
      if(options.advertising){
        const plan=options.advertising;
        row=await one(client,`UPDATE sponsor_campaigns SET ad_product_id=$2,coupon_policy_id=$3,
          advertising_plan=$4,advertising_review_required=true WHERE id=$1 RETURNING *`,
          [row.id,plan.packageId,plan.couponPolicyId,JSON.stringify({activities:plan.activities,benefitNotes:plan.benefitNotes})]);
      }else if(old?.advertising_review_required&&body.advertisingReviewed===true){
        row=await one(client,`UPDATE sponsor_campaigns SET advertising_review_required=false
          WHERE id=$1 RETURNING *`,[row.id]);
      }
      await log(client,row.id,old?'edit':'create','admin',now());
      return row;
    }
    return id?withLocked(id,save):options.client?save(options.client,null):tx(client=>save(client,null));
  }

  async function status(client,row,value,source,at,runtime){
    if(row.status===value)return null;
    const previous=row.status;
    const fresh=await one(client,`UPDATE sponsor_campaigns SET status=$2,
      published_at=CASE WHEN $4 THEN $3::timestamptz ELSE published_at END,
      paused_at=CASE WHEN $2='paused' THEN $3::timestamptz ELSE NULL END,
      completed_at=CASE WHEN $2 IN ('completed','cancelled') THEN $3::timestamptz ELSE NULL END,
      updated_at=$3 WHERE id=$1 RETURNING *`,[row.id,value,at,previous==='draft'&&value!=='cancelled']);
    await log(client,row.id,value,source,at);
    if(!runtime)return {campaign:fresh};
    const snapshot=runtime.snapshot;
    let nextAt=null;
    if(value==='open'||value==='active'){
      const shift=previous==='paused'?Math.max(0,+at-+row.paused_at):0;
      if(snapshot.game?.phase==='playing'){
        snapshot.game.deadline+=shift;
        nextAt=new Date(snapshot.game.deadline-(snapshot.revealed?0:10000));
      }else if(snapshot.game?.phase==='ready'&&snapshot.autoMode&&snapshot.autoNextAt){
        snapshot.autoNextAt+=shift;
        nextAt=new Date(snapshot.autoNextAt);
      }
    }
    const {revision}=await one(client,`UPDATE rps_event_runtime SET snapshot=$2,next_action_at=$3,
      revision=revision+1 WHERE event_id=$1 RETURNING revision`,[runtime.id,snapshot,nextAt]);
    const changed={...runtime,snapshot,campaign:await findByEvent(client,runtime.id),revision};
    return {campaign:fresh,update:{row:changed,state:engineView(changed,client),revision}};
  }

  async function command(id,action,at=now()){
    return withLocked(id,async(client,row,runtime)=>{
      let target;
      if(action==='publish'&&row.status==='draft'){
        requireValue(!row.advertising_review_required,'광고 제안으로 만든 초안은 콘텐츠를 검토하고 편집 화면에서 확인해야 합니다',409);
        requireValue(at<row.ends_at,'종료 시각이 이미 지났습니다',409);
        const company=await one(client,'SELECT enabled FROM sponsor_companies WHERE id=$1 FOR SHARE',[row.company_id]);
        requireValue(company?.enabled,'활성 기업만 새 이벤트를 게시할 수 있습니다',409);
        if(row.type==='quiz'){
          const count=await one(client,'SELECT count(*)::int AS count FROM campaign_quiz_questions WHERE campaign_id=$1',[id]);
          requireValue(count.count>0,'퀴즈 문제를 한 개 이상 작성하세요',409);
        }
        if(row.type==='mission'){
          const count=await one(client,'SELECT count(*)::int AS count FROM campaign_missions WHERE campaign_id=$1',[id]);
          requireValue(count.count===dateIndex(new Date(+row.ends_at-1))-dateIndex(row.starts_at)+1,
            '운영 기간의 모든 날짜에 미션을 작성하세요',409);
        }
        target=effective(row,at);
      }else if(action==='pause'&&entryStates.has(row.status)&&at<row.ends_at)target='paused';
      else if(action==='resume'&&row.status==='paused'&&at<row.ends_at)target=effective(row,at);
      else if(action==='complete'&&['open','active','paused'].includes(row.status))target='completed';
      else if(action==='cancel'&&!terminal.has(row.status))target='cancelled';
      else if((action==='publish'&&['scheduled','open','active'].includes(row.status))||
        (action==='pause'&&row.status==='paused')||(action==='resume'&&entryStates.has(row.status))||
        (action==='complete'&&row.status==='completed')||(action==='cancel'&&row.status==='cancelled')){
        return {campaign:row};
      }else{
        await log(client,id,'rejected','admin',at,action);
        return {error:'현재 상태에서는 이 명령을 실행할 수 없습니다',campaign:row};
      }
      return status(client,row,target,'admin',at,runtime);
    });
  }

  async function advance(at,publish){
    const due=await tx(client=>query(client,`SELECT id FROM sponsor_campaigns WHERE
      (status='scheduled' AND opens_at<=$1) OR (status='open' AND starts_at<=$1)
      OR (status IN ('active','paused') AND ends_at<=$1)
      ORDER BY ends_at,id LIMIT 75`,[at]));
    let processed=0;
    for(const {id} of due){
      const result=await withLocked(id,async(client,row,runtime)=>{
        if(!['scheduled','open','active','paused'].includes(row.status)||
          (row.status==='paused'&&at<row.ends_at))return null;
        return status(client,row,effective(row,at),'schedule',at,runtime);
      });
      if(result){processed++;publish(result.update)}
    }
    return {processed};
  }

  async function finishEngine(client,row,at){
    if(row.status!=='active')return row;
    const result=await status(client,row,'completed','engine',at,null);
    return result.campaign;
  }

  const publicCard=(row,at)=>({id:row.id,type:row.type,status:row.status,title:row.title,
    description:row.description,adQuiz:row.type==='quiz'&&!!row.advertising_plan,imageURL:row.image_url||row.company_image,joinTerms:row.join_terms,
    opensAt:row.opens_at,startsAt:row.starts_at,endsAt:row.ends_at,
    canJoin:canEnter(row,at)&&(!row.event_id||row.rps_phase==='lobby'),company:{name:row.company_name,brand:row.brand,logoURL:row.logo_url,description:row.company_description,
      websiteURL:row.website_url},gameURL:row.join_code&&!['scheduled','draft'].includes(row.status)
        ?'/tournament/join/'+row.join_code:null});

  async function listings(client,hash,at){
    const rows=await query(client,affiliate+` WHERE c.published_at IS NOT NULL AND c.status IN ('scheduled','open','active','paused')
      AND c.ends_at>$1 ORDER BY c.starts_at,c.id LIMIT 60`,[at]);
    const mine=hash?await query(client,affiliate+` JOIN campaign_participants p ON p.campaign_id=c.id
      AND p.device_hash=$1 WHERE c.published_at IS NOT NULL ORDER BY p.joined_at DESC LIMIT 50`,[hash]):[];
    const mineCards=[];
    for(const row of mine){
      const member=await getParticipant(client,row.id,hash);
      mineCards.push({...publicCard(row,at),progress:await progress(client,row,member,at)});
    }
    return {available:rows.map(row=>publicCard(row,at)),mine:mineCards};
  }

  const quiz=(client,id,privateData=false)=>query(client,
    `SELECT position,prompt,choices,points${privateData?',correct_index':''}
      FROM campaign_quiz_questions WHERE campaign_id=$1 ORDER BY position`,[id]);
  const missions=(client,id,privateData=false)=>query(client,
    `SELECT day,title,description,kind,content,prompt,choices${privateData?',correct_index':''}
      FROM campaign_missions WHERE campaign_id=$1 ORDER BY day`,[id]);

  function streaks(days,today){
    let length=0,longest=0,prev=-10;
    for(const day of days){
      length=day===prev+1?length+1:1;
      longest=Math.max(length,longest);prev=day;
    }
    return {longestStreak:longest,currentStreak:prev>=today-1?length:0};
  }
  async function progress(client,row,member,at){
    const result={joined:Boolean(member),canSubmit:!!member&&isActive(row,at)};
    if(!member)return result;
    if(row.type==='quiz'){
      const score=await one(client,`SELECT count(*)::int AS attempts,max(score) AS best_score
        FROM campaign_quiz_submissions WHERE campaign_id=$1 AND participant_id=$2`,[row.id,member.id]);
      return {...result,attempts:score.attempts,score:score.best_score,completed:score.attempts>0,
        canSubmit:result.canSubmit&&(row.allow_retry||!score.attempts)};
    }
    if(row.type==='mission'){
      const completed=await query(client,`SELECT day FROM campaign_mission_progress
        WHERE campaign_id=$1 AND participant_id=$2 ORDER BY day`,[row.id,member.id]);
      const {count}=await one(client,'SELECT count(*)::int AS count FROM campaign_missions WHERE campaign_id=$1',[row.id]);
      const days=completed.map(value=>value.day);
      return {...result,days,total:count,completed:count>0&&days.length===count,
        completionPercent:count?Math.floor(days.length*100/count):0,...streaks(days,currentDay(row,at))};
    }
    const engine=await one(client,`SELECT snapshot#>>'{game,champion}' AS champion,
      snapshot#>>'{game,round}' AS round FROM rps_event_runtime WHERE event_id=$1`,[row.event_id]);
    return {...result,round:Number(engine?.round||0),won:!!engine?.champion&&engine.champion===member.engine_player_id};
  }

  async function detail(id,hash,at){
    return tx(async client=>{
      const row=await one(client,affiliate+' WHERE c.id=$1',[id]);
      requireValue(isPublic(row),'이벤트를 찾을 수 없습니다',404);
      const member=hash?await getParticipant(client,id,hash):null;
      const result={...publicCard(row,at),allowRetry:row.allow_retry,progress:await progress(client,row,member,at)};
      if(member&&isActive(row,at)&&row.type==='quiz')result.questions=await quiz(client,id);
      if(member&&statesForContent.has(row.status)&&row.type==='mission'){
        const day=currentDay(row,at);
        result.missions=(await missions(client,id)).map(mission=>{
          const visible=mission.day===day&&isActive(row,at);
          return visible?mission:{day:mission.day,title:mission.title,description:mission.description,kind:mission.kind};
        });
      }
      return result;
    });
  }

  async function join(id,hash,body,at){
    return withLocked(id,async(client,row,runtime)=>{
      requireValue(isPublic(row),'이벤트를 찾을 수 없습니다',404);
      const existing=await getParticipant(client,id,hash);
      if(existing)return {joined:true,gameURL:runtime?'/tournament/join/'+runtime.join_code:null};
      requireValue(canEnter(row,at),'현재 참가할 수 없는 이벤트입니다',409);
      requireValue(!row.join_terms||body.termsAccepted===true,'참가 조건을 확인하세요');
      if(runtime){
        requireValue(runtime.snapshot.game?.phase==='lobby','토너먼트 참가가 마감되었습니다',409);
        return {joined:false,gameURL:'/tournament/join/'+runtime.join_code};
      }
      const supplied=text(body.nickname,20);
      requireValue(!supplied||/^[\p{L}\p{N}_ -]{2,20}$/u.test(supplied),'닉네임은 글자·숫자 2~20자로 입력하세요');
      const count=await one(client,'SELECT count(*)::int AS count FROM campaign_participants WHERE campaign_id=$1',[id]);
      await enroll(client,row,hash,supplied||'참가자 '+(count.count+1),at);
      return {joined:true};
    });
  }

  async function submitQuiz(id,hash,body,at){
    requireValue(isUUID(body.requestId),'제출 식별자를 확인하세요');
    return withLocked(id,async(client,row)=>{
      requireValue(row.type==='quiz'&&isPublic(row),'퀴즈를 찾을 수 없습니다',404);
      const member=await getParticipant(client,id,hash);
      requireValue(member,'먼저 이벤트에 참가하세요',403);
      const saved=await one(client,`SELECT score,submitted_at FROM campaign_quiz_submissions
        WHERE campaign_id=$1 AND participant_id=$2 AND request_id=$3`,[id,member.id,body.requestId]);
      if(saved)return saved;
      requireValue(isActive(row,at),'제출 가능한 시간이 아닙니다',409);
      const questions=await quiz(client,id,true);
      requireValue(Array.isArray(body.answers)&&body.answers.length===questions.length&&questions.length>0,'모든 문제에 답하세요');
      requireValue(body.answers.every((answer,index)=>Number.isInteger(answer)&&answer>=0&&
        answer<questions[index].choices.length),'답안 보기를 확인하세요');
      if(!row.allow_retry){
        const previous=await one(client,`SELECT 1 FROM campaign_quiz_submissions
          WHERE campaign_id=$1 AND participant_id=$2 LIMIT 1`,[id,member.id]);
        requireValue(!previous,'이미 퀴즈를 제출했습니다',409);
      }
      const score=questions.reduce((sum,q,index)=>sum+(q.correct_index===body.answers[index]?q.points:0),0);
      const submission=await one(client,`INSERT INTO campaign_quiz_submissions
        (campaign_id,participant_id,request_id,answers,score,submitted_at) VALUES($1,$2,$3,$4,$5,$6)
        RETURNING score,submitted_at`,[id,member.id,body.requestId,JSON.stringify(body.answers),score,at]);
      await issueCoupon(client,id,member.id,at);
      return submission;
    });
  }

  async function submitMission(id,day,hash,body,at){
    requireValue(Number.isInteger(day)&&day>=1&&day<=31&&isUUID(body.requestId),'미션 제출을 확인하세요');
    return withLocked(id,async(client,row)=>{
      requireValue(row.type==='mission'&&isPublic(row),'미션을 찾을 수 없습니다',404);
      const member=await getParticipant(client,id,hash);
      requireValue(member,'먼저 이벤트에 참가하세요',403);
      const saved=await one(client,`SELECT day,correct FROM campaign_mission_attempts
        WHERE campaign_id=$1 AND participant_id=$2 AND request_id=$3`,[id,member.id,body.requestId]);
      if(saved){
        requireValue(saved.day===day,'다른 미션에서 사용한 제출 식별자입니다',409);
        return {completed:saved.correct,day};
      }
      const finished=await one(client,`SELECT 1 FROM campaign_mission_progress
        WHERE campaign_id=$1 AND participant_id=$2 AND day=$3`,[id,member.id,day]);
      if(finished)return {completed:true,day};
      requireValue(isActive(row,at)&&currentDay(row,at)===day,'오늘 미션만 제출할 수 있습니다',409);
      const mission=await one(client,'SELECT * FROM campaign_missions WHERE campaign_id=$1 AND day=$2',[id,day]);
      requireValue(mission,'미션을 찾을 수 없습니다',404);
      requireValue(Number.isInteger(body.answer)&&body.answer>=0&&body.answer<mission.choices.length,'답안 보기를 확인하세요');
      const correct=body.answer===mission.correct_index;
      await query(client,`INSERT INTO campaign_mission_attempts
        (campaign_id,participant_id,day,request_id,correct,submitted_at) VALUES($1,$2,$3,$4,$5,$6)`,
        [id,member.id,day,body.requestId,correct,at]);
      if(!correct)return {completed:false,day};
      await query(client,`INSERT INTO campaign_mission_progress(campaign_id,participant_id,day,request_id,completed_at)
        VALUES($1,$2,$3,$4,$5)`,[id,member.id,day,body.requestId,at]);
      await issueCoupon(client,id,member.id,at);
      return {completed:true,day};
    });
  }

  async function results(client,row){
    if(row.type==='quiz')return query(client,`SELECT p.display_name,
      dense_rank() OVER(ORDER BY best.score DESC)::int AS rank,best.score
      FROM campaign_participants p JOIN LATERAL (SELECT max(score) AS score FROM campaign_quiz_submissions
        WHERE campaign_id=p.campaign_id AND participant_id=p.id HAVING count(*)>0) best ON true
      WHERE p.campaign_id=$1 ORDER BY rank,p.joined_at,p.id LIMIT 100`,[row.id]);
    if(row.type==='mission')return query(client,`SELECT p.display_name,count(m.day)::int AS days,
      (count(m.day)>0 AND count(m.day)=(SELECT count(*) FROM campaign_missions WHERE campaign_id=$1)) AS completed
      FROM campaign_participants p LEFT JOIN campaign_mission_progress m ON m.campaign_id=p.campaign_id
      AND m.participant_id=p.id WHERE p.campaign_id=$1 GROUP BY p.id
      ORDER BY days DESC,p.joined_at,p.id LIMIT 100`,[row.id]);
    return query(client,`SELECT p.display_name,1 AS rank FROM campaign_participants p
      JOIN rps_event_runtime r ON r.event_id=$2
      WHERE p.campaign_id=$1 AND p.engine_player_id=r.snapshot#>>'{game,champion}'`,[row.id,row.event_id]);
  }

  async function management(client,id){
    const row=await one(client,affiliate+' WHERE c.id=$1',[id]);
    requireValue(row,'이벤트를 찾을 수 없습니다',404);
    const counts=await one(client,`SELECT (SELECT count(*)::int FROM campaign_participants WHERE campaign_id=$1) AS participants,
      (SELECT count(DISTINCT participant_id)::int FROM campaign_quiz_submissions WHERE campaign_id=$1) AS quiz_submitters,
      (SELECT count(DISTINCT participant_id)::int FROM campaign_mission_attempts WHERE campaign_id=$1) AS mission_submitters,
      (SELECT count(*)::int FROM campaign_mission_progress WHERE campaign_id=$1) AS mission_checks,
      (SELECT count(*)::int FROM (SELECT participant_id FROM campaign_mission_progress WHERE campaign_id=$1
        GROUP BY participant_id HAVING count(*)=(SELECT count(*) FROM campaign_missions WHERE campaign_id=$1)) completed) AS mission_completed,
      (SELECT count(*)::int FROM rps_event_runtime r,
        jsonb_array_elements(coalesce(r.snapshot->'players','[]')) player
        WHERE r.event_id=$2 AND player->1->>'submittedMove'='true') AS rps_submitters,
      (SELECT jsonb_array_length(coalesce(snapshot#>'{game,history}','[]'::jsonb))
        FROM rps_event_runtime WHERE event_id=$2) AS rps_rounds`,[id,row.event_id]);
    const ranking=await results(client,row);
    const content=await (row.type==='quiz'?quiz(client,id,true):row.type==='mission'?missions(client,id,true):[]);
    const completed=row.type==='quiz'?counts.quiz_submitters:row.type==='mission'?counts.mission_completed:ranking.length;
    const logs=await query(client,`SELECT action,source,detail,occurred_at FROM campaign_activity_logs
      WHERE campaign_id=$1 ORDER BY id DESC LIMIT 40`,[id]);
    return {campaign:row,counts:{...counts,completed},ranking,content,logs};
  }

  async function preferences(client,hash,input){
    if(input)await query(client,`INSERT INTO campaign_notification_preferences(device_hash,event_updates,advertising)
      VALUES($1,$2,$3) ON CONFLICT(device_hash) DO UPDATE SET event_updates=$2,advertising=$3,updated_at=now()`,
    [hash,input.eventUpdates,input.advertising]);
    return await one(client,'SELECT event_updates,advertising FROM campaign_notification_preferences WHERE device_hash=$1',[hash])
      || {event_updates:false,advertising:false};
  }

  return {tx,query,one,find,findByEvent,withLocked,enroll,isActive,canEnter,saveCompany,saveCampaign,command,advance,
    finishEngine,isPublic,listings,detail,progress,results,management,join,submitQuiz,submitMission,preferences};
}
module.exports={createCampaigns};
