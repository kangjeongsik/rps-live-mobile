const {randomBytes,randomInt,createHash,scrypt:derive,timingSafeEqual}=require('node:crypto');
const {promisify}=require('node:util');
const {requireValue,isUUID,text}=require('./campaign-validation.cjs');
const scrypt=promisify(derive);
const hash=value=>createHash('sha256').update(value).digest('hex');
const secret=()=>randomBytes(24).toString('base64url');
const validToken=value=>typeof value==='string'&&/^[\w-]{32}$/.test(value);
const uid=(value,label='ID')=>{requireValue(isUUID(value),label+'를 확인하세요');return value};
function money(value,positive=false){
  requireValue((typeof value==='string'||typeof value==='number')&&/^\d{1,14}$/.test(String(value)),'원 단위 금액을 확인하세요');
  const amount=BigInt(value);
  requireValue(!positive||amount>0n,'금액은 양수여야 합니다');
  return amount;
}
function when(value){
  const date=new Date(value);
  requireValue(typeof value==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(+date),'시간대가 포함된 유효한 일시를 입력하세요');
  return date;
}
const whole=(value,min,max)=>{requireValue(Number.isInteger(value)&&value>=min&&value<=max,'수량 또는 점수 범위를 확인하세요');return value};
function handleStatus(row,now){
  if(row.status!=='available')return row.status;
  if(now>=new Date(row.terms_snapshot.validUntil))return 'expired';
  if(!row.active)return 'suspended';
  return 'available';
}

function createCouponStore(eventStore){
  const tx=eventStore.transaction;
  const query=async(client,sql,args)=>(await client.query(sql,args)).rows;
  const one=async(...args)=>(await query(...args))[0];
  async function rate(client,key,max,seconds=60){
    const {hits}=await one(client,`INSERT INTO coupon_rate_limits(key,window_start,hits)
      VALUES($1,to_timestamp(floor(extract(epoch from now())/$2::integer)*$2),1)
      ON CONFLICT(key,window_start) DO UPDATE SET hits=coupon_rate_limits.hits+1 RETURNING hits`,[hash(key),seconds]);
    return hits<=max;
  }
  const audit=(client,action,info={})=>query(client,`INSERT INTO coupon_verification_logs
    (issuance_id,redemption_id,staff_id,store_id,actor,action,detail) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [info.issuance||null,info.redemption||null,info.staff?.id||null,info.staff?.store_id||null,
      info.actor||'system',action,info.detail||'']);
  async function saveLocation(id,body){
    const args=[uid(body.companyId),text(body.name,120,1),text(body.address,350),body.active!==false];
    return tx(async client=>{
      requireValue(await one(client,'SELECT id FROM sponsor_companies WHERE id=$1',[args[0]]),'기업을 찾을 수 없습니다',404);
      const row=id?await one(client,`UPDATE store_locations SET name=$2,address=$3,active=$4
        WHERE id=$5 AND company_id=$1 RETURNING *`,[...args,id]):await one(client,`INSERT INTO store_locations(company_id,name,address,active)
        VALUES($1,$2,$3,$4) RETURNING *`,args);
      requireValue(row,'매장을 찾을 수 없습니다',404);
      return row;
    });
  }
  const staffFields='id,store_id,username,display_name,active,can_request_cancel,created_at';
  async function saveStaff(id,body){
    const username=text(body.username,64,3).toLowerCase();
    requireValue(/^[a-z0-9._-]{3,64}$/.test(username),'직원 ID는 영문·숫자·점·밑줄·하이픈으로 입력하세요');
    const password=body.password?text(body.password,128,12):null;
    requireValue(id||password,'12자 이상 비밀번호가 필요합니다');
    let digest=null;
    if(password){
      const salt=randomBytes(16).toString('hex');
      digest=salt+':'+(await scrypt(password,salt,64)).toString('hex');
    }
    return tx(async client=>{
      const store=uid(body.storeId,'매장');
      requireValue(await one(client,'SELECT id FROM store_locations WHERE id=$1',[store]),'매장을 찾을 수 없습니다',404);
      const values=[store,username,text(body.displayName,120,1),digest,body.active!==false,body.canRequestCancel===true];
      const account=id?await one(client,`UPDATE store_staff_accounts SET username=$2,display_name=$3,
        password_hash=coalesce($4,password_hash),active=$5,can_request_cancel=$6 WHERE id=$7 AND store_id=$1 RETURNING ${staffFields}`,
      [...values,id]):await one(client,`INSERT INTO store_staff_accounts(store_id,username,display_name,password_hash,active,can_request_cancel)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(username) DO NOTHING RETURNING ${staffFields}`,values);
      requireValue(account,'계정 ID가 이미 사용 중이거나 매장이 다릅니다',409);
      if(id&&(digest||!account.active))await query(client,'DELETE FROM store_staff_sessions WHERE staff_id=$1',[id]);
      await audit(client,id?'staff_update':'staff_create',{actor:'admin',detail:account.id});
      return account;
    });
  }
  async function login(ip,body){
    const name=text(body.username,64,1).toLowerCase();
    const password=text(body.password,128,1);
    const found=await tx(async client=>{
      const ipOK=await rate(client,'login-ip:'+ip,30,600);
      const nameOK=await rate(client,'login-name:'+name,10,600);
      if(!ipOK||!nameOK)return {limited:true};
      return {account:await one(client,`SELECT a.*,s.active AS store_active FROM store_staff_accounts a
        JOIN store_locations s ON s.id=a.store_id WHERE a.username=$1`,[name])};
    });
    requireValue(!found.limited,'로그인 시도 한도를 초과했습니다',429);
    const account=found.account;
    const [salt,digest]=(account?.password_hash||'0'.repeat(32)+':'+'0'.repeat(128)).split(':');
    const derived=await scrypt(password,salt,64);
    const equal=timingSafeEqual(derived,Buffer.from(digest,'hex'));
    requireValue(equal&&account?.active&&account.store_active,'로그인 정보를 확인하세요',401);
    const token=secret();
    const ok=await tx(client=>one(client,`INSERT INTO store_staff_sessions(token_hash,staff_id,expires_at)
      SELECT $1,id,now()+interval '8 hours' FROM store_staff_accounts
      WHERE id=$2 AND active AND password_hash=$3 RETURNING staff_id`,[hash(token),account.id,account.password_hash]));
    requireValue(ok,'로그인 정보를 확인하세요',401);
    return token;
  }
  const staff=(client,token)=>validToken(token)?one(client,`SELECT a.id,a.store_id,a.display_name,a.can_request_cancel,
    s.name AS store_name,s.company_id FROM store_staff_sessions x JOIN store_staff_accounts a ON a.id=x.staff_id
    JOIN store_locations s ON s.id=a.store_id WHERE x.token_hash=$1 AND x.expires_at>now() AND a.active AND s.active FOR SHARE OF a,s`,[hash(token)]):null;
  async function withStaff(token,work){
    return tx(async client=>{
      const account=await staff(client,token);
      requireValue(account,'매장 로그인이 필요합니다',401);
      return work(client,account);
    });
  }
  const logout=token=>validToken(token)?tx(client=>query(client,'DELETE FROM store_staff_sessions WHERE token_hash=$1',[hash(token)])):null;

  async function savePolicy(id,body){
    const campaign=uid(body.campaignId,'캠페인');
    const stores=body.storeIds;
    requireValue(Array.isArray(stores)&&stores.length>=1&&stores.length<=30&&stores.every(isUUID),'사용할 매장을 선택하세요');
    const unique=[...new Set(stores)];
    const eligibility=body.eligibility;
    const compatible={quiz:['quiz_complete','quiz_score'],mission:['all_missions'],rps:['winner']};
    const args=[campaign,text(body.name,120,1),text(body.description,1000),text(body.terms,1000),text(body.exclusions,1000),
      money(body.minimum,true).toString(),money(body.discount,true).toString(),when(body.issueStart),when(body.issueEnd),
      when(body.validFrom),when(body.validUntil),whole(body.inventory,1,1000000),whole(body.perPerson,1,20),
      eligibility,eligibility==='quiz_score'?whole(body.minimumScore,0,30000):null,body.active===true];
    requireValue(BigInt(args[6])<=BigInt(args[5])&&args[7]<args[8]&&args[9]<args[10]&&args[8]<=args[10],
      '할인액과 발급·유효기간 범위를 확인하세요');
    return tx(async client=>{
      const linked=await one(client,'SELECT type,company_id FROM sponsor_campaigns WHERE id=$1',[campaign]);
      requireValue(linked&&compatible[linked.type].includes(eligibility),'캠페인에 맞는 보상 조건을 선택하세요');
      const match=await query(client,'SELECT id FROM store_locations WHERE company_id=$1 AND id=ANY($2::uuid[])',[linked.company_id,unique]);
      requireValue(match.length===unique.length,'같은 기업의 매장만 선택할 수 있습니다',409);
      const columns=['campaign_id','name','description','terms','exclusions','minimum_krw','discount_krw',
        'issue_starts_at','issue_ends_at','valid_from','valid_until','inventory','per_person','eligibility','minimum_score','active'];
      if(id){
        const old=await one(client,'SELECT * FROM coupon_policies WHERE id=$1 FOR UPDATE',[id]);
        requireValue(old&&old.campaign_id===campaign,'쿠폰 정책을 찾을 수 없습니다',404);
        const issued=await one(client,'SELECT count(*)::int AS n FROM coupon_issuances WHERE policy_id=$1',[id]);
        requireValue(issued.n<=args[11],'총 수량은 이미 발급한 수 이상이어야 합니다',409);
        requireValue(!issued.n||(old.eligibility===eligibility&&old.minimum_score===args[14]),'발급 후 지급 조건 변경은 새 정책에서 설정하세요',409);
      }
      const row=id?await one(client,`UPDATE coupon_policies SET ${columns.map((key,i)=>key+'=$'+(i+1)).join(',')},
        updated_at=now() WHERE id=$17 RETURNING *`,[...args,id]):await one(client,`INSERT INTO coupon_policies(${columns.join(',')})
        VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,args);
      await query(client,'DELETE FROM coupon_policy_stores WHERE policy_id=$1',[row.id]);
      await query(client,'INSERT INTO coupon_policy_stores(policy_id,store_id) SELECT $1,unnest($2::uuid[])',[row.id,unique]);
      await audit(client,id?'policy_update':'policy_create',{actor:'admin',detail:row.id});
      return row;
    });
  }
  async function issue(client,campaignId,participantId,now=new Date()){
    const policies=await query(client,`SELECT * FROM coupon_policies WHERE campaign_id=$1 AND active
      AND issue_starts_at<=$2 AND issue_ends_at>$2 ORDER BY id FOR UPDATE`,[campaignId,now]);
    for(const policy of policies){
      const result=await one(client,`SELECT p.joined_at,
        (SELECT max(score) FROM campaign_quiz_submissions WHERE campaign_id=p.campaign_id AND participant_id=p.id) AS score,
        (SELECT count(*)::int FROM campaign_mission_progress WHERE campaign_id=p.campaign_id AND participant_id=p.id) AS completed,
        (SELECT count(*)::int FROM campaign_missions WHERE campaign_id=p.campaign_id) AS missions,
        EXISTS(SELECT 1 FROM sponsor_campaigns c JOIN rps_event_runtime r ON r.event_id=c.event_id
          WHERE c.id=p.campaign_id AND r.snapshot#>>'{game,champion}'=p.engine_player_id) AS winner
        FROM campaign_participants p WHERE p.campaign_id=$1 AND p.id=$2`,[campaignId,participantId]);
      if(!result)continue;
      const eligible={quiz_complete:result.score!==null,quiz_score:result.score!==null&&result.score>=policy.minimum_score,
        all_missions:result.missions>0&&result.completed===result.missions,winner:result.winner};
      if(!eligible[policy.eligibility])continue;
      const counts=await one(client,`SELECT count(*)::int AS total,count(*) FILTER(WHERE participant_id=$2)::int AS own
        FROM coupon_issuances WHERE policy_id=$1`,[policy.id,participantId]);
      const n=Math.min(policy.inventory-counts.total,policy.per_person-counts.own);
      if(n<=0)continue;
      const stores=await query(client,'SELECT store_id FROM coupon_policy_stores WHERE policy_id=$1 ORDER BY store_id',[policy.id]);
      const terms={name:policy.name,description:policy.description,terms:policy.terms,exclusions:policy.exclusions,
        minimum:policy.minimum_krw,discount:policy.discount_krw,validFrom:policy.valid_from,validUntil:policy.valid_until,
        stores:stores.map(x=>x.store_id)};
      const created=await query(client,`INSERT INTO coupon_issuances(policy_id,campaign_id,participant_id,slot,
        eligibility_snapshot,terms_snapshot,issued_at) SELECT $1,$2,$3,generate_series($4::int,$5::int),$6,$7,$8
        ON CONFLICT(policy_id,participant_id,slot) DO NOTHING RETURNING id`,
      [policy.id,campaignId,participantId,counts.own+1,counts.own+n,
        {verified:true,condition:policy.eligibility,score:result.score,completed:result.completed,winner:result.winner},terms,now]);
      for(const row of created)await audit(client,'issued',{issuance:row.id});
    }
  }
  async function issueWinner(client,campaignId,player,now){
    const row=await one(client,'SELECT id FROM campaign_participants WHERE campaign_id=$1 AND engine_player_id=$2',[campaignId,player]);
    if(row)await issue(client,campaignId,row.id,now);
  }
  const walletRows=(client,device,id)=>query(client,`SELECT i.id,i.status,i.terms_snapshot,i.issued_at,p.active,b.brand,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('name',s.name,'address',s.address) ORDER BY s.name),'[]')
      FROM store_locations s WHERE i.terms_snapshot->'stores' ? s.id::text) AS stores
    FROM coupon_issuances i JOIN coupon_policies p ON p.id=i.policy_id
    JOIN campaign_participants cp ON cp.id=i.participant_id
    JOIN sponsor_campaigns c ON c.id=i.campaign_id JOIN sponsor_companies b ON b.id=c.company_id
    WHERE cp.device_hash=$1 AND ($2::uuid IS NULL OR i.id=$2) ORDER BY i.issued_at DESC LIMIT 150`,[device,id||null]);
  async function wallet(device,id,now){
    return tx(async client=>{
      const members=id?[]:await query(client,`SELECT cp.id,cp.campaign_id FROM campaign_participants cp
        WHERE cp.device_hash=$1 AND EXISTS(SELECT 1 FROM coupon_policies p WHERE p.campaign_id=cp.campaign_id AND p.active)
        ORDER BY cp.campaign_id LIMIT 100`,[device]);
      for(const member of members)await issue(client,member.campaign_id,member.id,now);
      const rows=await walletRows(client,device,id);
      requireValue(!id||rows.length,'쿠폰을 찾을 수 없습니다',404);
      return rows.map(row=>{
        const {stores:_,...terms}=row.terms_snapshot;
        return {id:row.id,brand:row.brand,status:handleStatus(row,now),usableNow:handleStatus(row,now)==='available'&&now>=new Date(terms.validFrom),stores:row.stores,issuedAt:row.issued_at,...terms};
      });
    });
  }
  const ownerRow=(client,id,device)=>one(client,`SELECT i.*,p.active FROM coupon_issuances i JOIN coupon_policies p ON p.id=i.policy_id
    JOIN campaign_participants cp ON cp.id=i.participant_id WHERE i.id=$1 AND cp.device_hash=$2 FOR UPDATE OF i FOR SHARE OF p`,[id,device]);
  function usable(row,now){
    requireValue(row&&handleStatus(row,now)==='available'&&now>=new Date(row.terms_snapshot.validFrom),
      '현재 사용할 수 없는 쿠폰입니다',409);
    requireValue(row.eligibility_snapshot.verified===true,'지급 조건을 확인할 수 없습니다',409);
  }
  async function present(id,device,owner,now){
    return tx(async client=>{
      const row=await ownerRow(client,id,device);
      usable(row,now);
      requireValue(validToken(owner),'쿠폰 소유 세션을 확인하세요',401);
      requireValue(!row.owner_hash||row.owner_hash===hash(owner),'처음 연결한 브라우저에서 확인하세요',403);
      if(!row.owner_hash)await query(client,'UPDATE coupon_issuances SET owner_hash=$2 WHERE id=$1',[id,hash(owner)]);
      const token=secret(),expiresAt=new Date(+now+120000);
      await query(client,`INSERT INTO coupon_presentations(issuance_id,token_hash,expires_at) VALUES($1,$2,$3)
        ON CONFLICT(issuance_id) DO UPDATE SET token_hash=$2,expires_at=$3,store_id=NULL,challenge_hash=NULL,
        failed=0,owner_confirmed_at=NULL`,[id,hash(token),expiresAt]);
      await audit(client,'presented',{issuance:id,actor:'participant'});
      return {code:token,expiresAt};
    });
  }
  async function confirmOwner(id,device,owner,body,now){
    return tx(async client=>{
      const row=await ownerRow(client,id,device);
      usable(row,now);
      requireValue(validToken(owner)&&row.owner_hash===hash(owner),'쿠폰 소유 세션을 확인하세요',403);
      const shown=await one(client,`SELECT * FROM coupon_presentations WHERE issuance_id=$1 FOR UPDATE`,[id]);
      requireValue(shown?.challenge_hash&&shown.expires_at>now&&shown.failed<5,'매장 확인 요청을 다시 받으세요',409);
      const digits=String(body.challenge||'');
      if(!/^\d{6}$/.test(digits)||hash(shown.token_hash+digits)!==shown.challenge_hash){
        await query(client,'UPDATE coupon_presentations SET failed=failed+1 WHERE issuance_id=$1',[id]);
        return {error:'매장에서 받은 6자리 번호를 확인하세요',status:400};
      }
      await query(client,'UPDATE coupon_presentations SET owner_confirmed_at=$2 WHERE issuance_id=$1',[id,now]);
      await audit(client,'owner_confirmed',{issuance:id,actor:'participant',detail:shown.store_id});
      return {confirmed:true};
    });
  }
  async function presented(client,code,now,account){
    requireValue(validToken(code),'쿠폰 코드를 확인하세요');
    const digest=hash(code);
    const ref=await one(client,'SELECT issuance_id FROM coupon_presentations WHERE token_hash=$1',[digest]);
    requireValue(ref,'쿠폰 코드를 확인하세요',404);
    const row=await one(client,`SELECT i.*,p.active,c.company_id FROM coupon_issuances i JOIN coupon_policies p ON p.id=i.policy_id
      JOIN sponsor_campaigns c ON c.id=i.campaign_id WHERE i.id=$1 FOR UPDATE OF i FOR SHARE OF p`,[ref.issuance_id]);
    usable(row,now);
    const token=await one(client,'SELECT * FROM coupon_presentations WHERE issuance_id=$1 FOR UPDATE',[row.id]);
    requireValue(token.token_hash===digest&&token.expires_at>now,'만료된 코드입니다',409);
    requireValue(row.company_id===account.company_id&&row.terms_snapshot.stores.includes(account.store_id),
      '이 매장에서 사용할 수 없는 쿠폰입니다',403);
    requireValue(!token.store_id||token.store_id===account.store_id,'다른 매장에서 확인 중입니다',409);
    return {row,token};
  }
  async function verify(token,body,now){
    // Keep rate-limit and denied-attempt history outside the validation transaction.
    const allowed=await withStaff(token,(client,account)=>rate(client,'verify:'+account.id,30));
    requireValue(allowed,'쿠폰 조회 시도 한도를 초과했습니다',429);
    try{
      return await withStaff(token,async(client,account)=>{
        const found=await presented(client,body.code,now,account);
        const {row,token:shown}=found;
        let challenge=null;
        if(!shown.owner_confirmed_at&&(!shown.challenge_hash||body.newChallenge===true)){
          challenge=String(randomInt(0,1000000)).padStart(6,'0');
          await query(client,`UPDATE coupon_presentations SET store_id=$2,challenge_hash=$3,failed=0 WHERE issuance_id=$1`,
            [row.id,account.store_id,hash(shown.token_hash+challenge)]);
        }
        await audit(client,'verified',{issuance:row.id,staff:account,actor:'staff'});
        return {name:row.terms_snapshot.name,minimum:row.terms_snapshot.minimum,discount:row.terms_snapshot.discount,
          terms:row.terms_snapshot.terms,exclusions:row.terms_snapshot.exclusions,challenge,
          ownerConfirmed:!!shown.owner_confirmed_at,expiresAt:shown.expires_at};
      });
    }catch(error){
      if(error.status)await withStaff(token,(client,account)=>audit(client,'verify_denied',{staff:account,actor:'staff',detail:String(error.status)}));
      throw error;
    }
  }
  const storeFields='id,store_id,before_discount_krw,paid_krw,discount_krw,approved_at,status';
  async function redeem(token,body,now){
    const request=uid(body.requestId,'승인 요청');
    requireValue(validToken(body.code),'쿠폰 코드를 확인하세요');
    const gross=money(body.beforeDiscount,true),paid=money(body.paid);
    const allowed=await withStaff(token,(client,account)=>rate(client,'redeem:'+account.id,30));
    requireValue(allowed,'승인 시도 한도를 초과했습니다',429);
    return withStaff(token,async(client,account)=>{
      await query(client,'SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[account.store_id,request]);
      const saved=await one(client,`SELECT ${storeFields},staff_id,
        (SELECT token_hash FROM coupon_presentations WHERE issuance_id=coupon_redemptions.issuance_id) AS token_hash
        FROM coupon_redemptions WHERE store_id=$1 AND request_id=$2`,[account.store_id,request]);
      if(saved){
        requireValue(saved.staff_id===account.id&&saved.token_hash===hash(body.code)&&saved.before_discount_krw===gross.toString()&&saved.paid_krw===paid.toString(),
          '기존 승인 요청과 일치하지 않습니다',409);
        const {staff_id:_,token_hash:__,...result}=saved;return result;
      }
      const {row,token:shown}=await presented(client,body.code,now,account);
      requireValue(shown.store_id===account.store_id&&shown.owner_confirmed_at,'참가자가 매장 확인 번호를 승인해야 합니다',409);
      const discount=BigInt(row.terms_snapshot.discount);
      requireValue(gross>=BigInt(row.terms_snapshot.minimum)&&gross===paid+discount,'최소 구매액 및 할인 전·후 금액을 확인하세요',409);
      const transaction=await one(client,`INSERT INTO coupon_redemptions
        (issuance_id,company_id,campaign_id,store_id,staff_id,request_id,before_discount_krw,paid_krw,discount_krw,approved_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${storeFields}`,
        [row.id,row.company_id,row.campaign_id,account.store_id,account.id,request,gross.toString(),paid.toString(),discount.toString(),now]);
      await query(client,"UPDATE coupon_issuances SET status='used' WHERE id=$1",[row.id]);
      await audit(client,'redeemed',{issuance:row.id,redemption:transaction.id,staff:account,actor:'staff'});
      return transaction;
    });
  }
  const history=token=>withStaff(token,(client,account)=>query(client,`SELECT ${storeFields},
    EXISTS(SELECT 1 FROM coupon_redemption_adjustments WHERE redemption_id=r.id AND status='pending') AS pending
    FROM coupon_redemptions r WHERE r.store_id=$1 ORDER BY approved_at DESC LIMIT 100`,[account.store_id]));

  async function requestCancel(token,id,body){
    return withStaff(token,async(client,account)=>{
      requireValue(account.can_request_cancel,'승인 취소 요청 권한이 없습니다',403);
      const row=await one(client,'SELECT id,status FROM coupon_redemptions WHERE id=$1 AND store_id=$2 FOR UPDATE',[id,account.store_id]);
      requireValue(row,'매장 거래를 찾을 수 없습니다',404);
      requireValue(['approved','partially_refunded'].includes(row.status),'이미 종료된 거래입니다',409);
      const pending=await one(client,"SELECT id,status FROM coupon_redemption_adjustments WHERE redemption_id=$1 AND status='pending'",[id]);
      if(pending)return pending;
      const request=await one(client,`INSERT INTO coupon_redemption_adjustments(redemption_id,requested_by,kind,reason)
        VALUES($1,$2,'cancel',$3) RETURNING id,status`,[id,account.id,text(body.reason,1000,2)]);
      await audit(client,'cancel_requested',{redemption:id,staff:account,actor:'staff'});
      return request;
    });
  }
  async function evidence(id,body,now){
    const reference=text(body.reference,240,3);
    const amount=money(body.amount).toString();
    return tx(async client=>{
      const row=await one(client,'SELECT * FROM coupon_redemptions WHERE id=$1 FOR UPDATE',[id]);
      requireValue(row,'거래를 찾을 수 없습니다',404);
      if(row.external_verified_at&&row.external_reference===reference&&row.external_amount_krw===amount)return {verified:true};
      requireValue(!row.external_verified_at&&amount===row.paid_krw&&['approved','partially_refunded'].includes(row.status),
        '할인 후 원결제액과 일치하는 외부 증빙이 필요합니다',409);
      const duplicate=await one(client,'SELECT 1 FROM coupon_redemptions WHERE company_id=$1 AND external_reference=$2',[row.company_id,reference]);
      requireValue(!duplicate,'이미 사용한 증빙 참조입니다',409);
      await query(client,'UPDATE coupon_redemptions SET external_reference=$2,external_amount_krw=$3,external_verified_at=$4 WHERE id=$1',
        [id,reference,amount,now]);
      await audit(client,'external_evidence_confirmed',{redemption:id,actor:'admin'});
      return {verified:true};
    });
  }
  async function decide(id,body,now,actor,direct=false){
    return tx(async client=>{
      const pending=direct?null:await one(client,'SELECT redemption_id FROM coupon_redemption_adjustments WHERE id=$1',[id]);
      requireValue(direct||pending,'취소 요청을 찾을 수 없습니다',404);
      const redemptionId=direct?id:pending.redemption_id;
      const trade=await one(client,'SELECT * FROM coupon_redemptions WHERE id=$1 FOR UPDATE',[redemptionId]);
      requireValue(trade,'거래를 찾을 수 없습니다',404);
      const request=direct?null:await one(client,'SELECT * FROM coupon_redemption_adjustments WHERE id=$1 FOR UPDATE',[id]);
      if(request?.status!=='pending'&&request)return request;
      requireValue(direct||['approve','reject'].includes(body.command),'승인·거절을 선택하세요');
      if(!direct&&body.command==='reject'){
        const rejected=await one(client,`UPDATE coupon_redemption_adjustments SET status='rejected',decided_at=$2,decided_by=$3
          WHERE id=$1 RETURNING *`,[id,now,actor]);
        await audit(client,'cancel_rejected',{redemption:redemptionId,actor});
        return rejected;
      }
      const reference=direct?text(body.reference,240,3):text(body.reference,240);
      if(direct){
        const replay=await one(client,`SELECT * FROM coupon_redemption_adjustments WHERE redemption_id=$1
          AND kind='refund' AND status='approved' AND evidence_reference=$2`,[id,reference]);
        if(replay){
          requireValue(replay.refund_krw===money(body.refund,true).toString(),'이미 등록한 환불 증빙과 금액이 다릅니다',409);
          return replay;
        }
      }
      requireValue(['approved','partially_refunded'].includes(trade.status),'이미 취소 또는 전액 환불했습니다',409);
      const sum=await one(client,`SELECT coalesce(sum(refund_krw),0) AS refunded FROM coupon_redemption_adjustments
        WHERE redemption_id=$1 AND status='approved'`,[redemptionId]);
      const available=BigInt(trade.paid_krw)-BigInt(sum.refunded);
      const kind=direct?'refund':'cancel';
      const refund=direct?money(body.refund,true):available;
      requireValue(refund<=available,'환불액은 남은 할인 후 결제금액 이하여야 합니다',409);
      const full=refund===available;
      const result=direct?await one(client,`INSERT INTO coupon_redemption_adjustments
        (redemption_id,kind,reason,evidence_reference,refund_krw,full_reversal,status,decided_at,decided_by)
        VALUES($1,'refund',$2,$3,$4,$5,'approved',$6,$7) RETURNING *`,
      [id,text(body.reason,1000,2),reference,refund.toString(),full,now,actor]):await one(client,`UPDATE coupon_redemption_adjustments
        SET status='approved',refund_krw=$2,full_reversal=true,evidence_reference=$3,decided_at=$4,decided_by=$5
        WHERE id=$1 RETURNING *`,[id,refund.toString(),reference,now,actor]);
      await query(client,'UPDATE coupon_redemptions SET status=$2 WHERE id=$1',
        [redemptionId,kind==='cancel'?'cancelled':full?'refunded':'partially_refunded']);
      if(full)await query(client,"UPDATE coupon_issuances SET status='cancelled' WHERE id=$1",[trade.issuance_id]);
      await audit(client,kind==='cancel'?'cancel_approved':'refund_approved',{redemption:redemptionId,actor,detail:result.id});
      return result;
    });
  }
  async function setCouponStatus(id,status){
    requireValue(['suspended','available','cancelled'].includes(status),'쿠폰 상태를 확인하세요');
    return tx(async client=>{
      const row=await one(client,`UPDATE coupon_issuances SET status=$2 WHERE id=$1 AND status IN ('available','suspended') RETURNING id,status`,[id,status]);
      requireValue(row,'이미 사용 또는 취소된 쿠폰입니다',409);
      await audit(client,'issuance_'+status,{issuance:id,actor:'admin'});
      return row;
    });
  }
  async function dashboard(company){
    return tx(async client=>{
      const companies=await query(client,'SELECT id,name,brand FROM sponsor_companies ORDER BY brand');
      if(!company)return {companies};
      const campaigns=await query(client,'SELECT id,title,type,status FROM sponsor_campaigns WHERE company_id=$1 ORDER BY created_at DESC',[company]);
      const stores=await query(client,'SELECT * FROM store_locations WHERE company_id=$1 ORDER BY name',[company]);
      const staffRows=await query(client,`SELECT ${staffFields} FROM store_staff_accounts WHERE store_id IN
        (SELECT id FROM store_locations WHERE company_id=$1) ORDER BY username`,[company]);
      const policies=await query(client,`SELECT p.*,c.title,(SELECT coalesce(array_agg(store_id),'{}')
        FROM coupon_policy_stores WHERE policy_id=p.id) AS store_ids,
        (SELECT count(*)::int FROM coupon_issuances WHERE policy_id=p.id) AS issued,
        (SELECT count(*)::int FROM coupon_issuances i WHERE policy_id=p.id AND i.status='available' AND p.active
          AND (i.terms_snapshot->>'validUntil')::timestamptz>now()
          AND (i.terms_snapshot->>'validFrom')::timestamptz<=now()) AS available
        FROM coupon_policies p JOIN sponsor_campaigns c ON c.id=p.campaign_id WHERE c.company_id=$1 ORDER BY p.updated_at DESC`,[company]);
      const issuances=await query(client,`SELECT i.id,i.status,i.issued_at,i.terms_snapshot->>'name' AS name,
        (i.terms_snapshot->>'validUntil')::timestamptz AS valid_until,p.active FROM coupon_issuances i
        JOIN coupon_policies p ON p.id=i.policy_id JOIN sponsor_campaigns c ON c.id=i.campaign_id
        WHERE c.company_id=$1 ORDER BY i.issued_at DESC LIMIT 100`,[company]);
      const redemptions=await query(client,`SELECT r.*,s.name AS store_name,
        EXISTS (SELECT 1 FROM advertising_settlement_items WHERE redemption_id=r.id) AS recognized
        FROM coupon_redemptions r JOIN store_locations s ON s.id=r.store_id
        WHERE r.company_id=$1 ORDER BY approved_at DESC LIMIT 100`,[company]);
      const adjustments=await query(client,`SELECT a.*,
        EXISTS(SELECT 1 FROM advertising_settlement_adjustments WHERE adjustment_id=a.id) AS settlement_applied,
        EXISTS(SELECT 1 FROM advertising_settlement_items i JOIN advertising_settlements s ON s.id=i.settlement_id
          WHERE i.redemption_id=a.redemption_id AND a.decided_at>=s.period_end::timestamp AT TIME ZONE 'Asia/Seoul')
          AS originated_in_settlement
        FROM coupon_redemption_adjustments a JOIN coupon_redemptions r ON r.id=a.redemption_id
        WHERE r.company_id=$1 ORDER BY requested_at DESC LIMIT 100`,[company]);
      const stats=await one(client,`SELECT count(*)::int AS approved,
        count(*) FILTER(WHERE status IN ('refunded','cancelled'))::int AS cancelled,
        count(*) FILTER(WHERE i.redemption_id IS NOT NULL)::int AS recognized,
        count(*) FILTER(WHERE i.redemption_id IS NULL AND EXISTS(SELECT 1 FROM advertising_settlements s
          WHERE s.company_id=r.company_id AND s.status='finalized'
          AND s.snapshot->'excluded' @> jsonb_build_array(jsonb_build_object('id',r.id))))::int AS excluded,
        count(*) FILTER(WHERE i.redemption_id IS NULL)::int AS not_recognized
        FROM coupon_redemptions r LEFT JOIN advertising_settlement_items i ON i.redemption_id=r.id WHERE r.company_id=$1`,[company]);
      return {companies,campaigns,stores,staff:staffRows,policies,issuances,redemptions,adjustments,stats};
    });
  }
  return {tx,query,one,audit,saveLocation,saveStaff,login,logout,withStaff,savePolicy,issue,issueWinner,
    wallet,present,confirmOwner,verify,redeem,history,requestCancel,evidence,decide,setCouponStatus,dashboard};
}
module.exports={createCouponStore,uid,money,secret,validToken};
