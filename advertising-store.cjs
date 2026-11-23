const {randomUUID}=require('node:crypto');
const {requireValue}=require('./campaign-validation.cjs');
const validate=require('./advertising-validation.cjs');

const normalize=value=>String(value??'').normalize('NFKC').toLowerCase().trim();
const transition={
  consulting:['proposal_writing','cancelled'],
  proposal_writing:['proposal_sent','cancelled'],
  proposal_sent:['negotiating','confirmed','cancelled'],
  negotiating:['proposal_sent','confirmed','cancelled'],
  confirmed:['running','cancelled'],
  running:['ended','cancelled'],
  ended:[],cancelled:[]
};
const editContract=new Set(['consulting','proposal_writing','proposal_sent','negotiating']);

function scoreRule(rule,lead){
  const val=normalize(rule.match_value);
  const value=lead[rule.field];
  if(rule.field==='duration')return lead.desired_days===Number(val);
  if(rule.field==='budget')return lead.budget_krw!==null&&BigInt(lead.budget_krw)>=BigInt(val);
  if(['goal','has_store','needs_consultation'].includes(rule.field))return normalize(value)===val;
  return val.split('|').map(token=>token.trim()).some(token=>token&&normalize(value).includes(token));
}
function recommendations(packages,rules,lead){
  return packages.filter(pkg=>pkg.enabled).map(pkg=>{
    const matched=rules.filter(rule=>rule.package_id===pkg.id&&rule.enabled&&scoreRule(rule,lead));
    const duration=Math.max(pkg.min_days,Math.min(pkg.max_days,lead.desired_days??pkg.default_days));
    const reasons=matched.map(rule=>rule.reason);
    if(!reasons.length)reasons.push('이 상품의 기본 구성과 기간을 검토할 수 있습니다.');
    if(lead.desired_days&&duration!==lead.desired_days)reasons.push('희망 기간을 상품 기본 범위에 맞췄습니다.');
    return {packageId:pkg.id,code:pkg.code,name:pkg.name,eventType:pkg.event_type,
      durationDays:duration,activities:pkg.activities,billingMode:pkg.suggested_billing,reasons,
      score:matched.reduce((sum,rule)=>sum+rule.weight,0)};
  }).sort((a,b)=>b.score-a.score||a.code.localeCompare(b.code));
}

function createAdvertising(campaigns){
  const {tx,one,query}=campaigns;
  async function write(client,table,values,id){
    const fields=Object.keys(values);
    const params=fields.map((_,index)=>'$'+(index+1));
    const returning=table==='advertising_contracts'
      ?'*,contract_start::text AS contract_start,contract_end::text AS contract_end':'*';
    if(!id)return one(client,`INSERT INTO ${table} (${fields.join(',')})
      VALUES (${params.join(',')}) RETURNING ${returning}`,Object.values(values));
    return one(client,`UPDATE ${table} SET ${fields.map((field,i)=>field+'='+params[i]).join(',')}
       WHERE id=$${fields.length+1} RETURNING ${returning}`,[...Object.values(values),id]);
  }
  async function log(client,action,{company,lead,proposal,contract,detail}){
    return query(client,`INSERT INTO advertising_activity_logs
      (company_id,lead_id,proposal_id,contract_id,action,detail) VALUES ($1,$2,$3,$4,$5,$6)`,
    [company,lead||null,proposal||null,contract||null,action,detail||'']);
  }
  const catalog=client=>Promise.all([
    query(client,'SELECT * FROM advertising_packages ORDER BY code'),
    query(client,'SELECT * FROM advertising_pricing_rules ORDER BY weight DESC,id')
  ]).then(([packages,rules])=>({packages,rules}));
  const getProposal=(client,id)=>one(client,'SELECT * FROM advertising_proposals WHERE id=$1 FOR UPDATE',[id]);
  const getContract=(client,id)=>one(client,'SELECT *,contract_start::text,contract_end::text FROM advertising_contracts WHERE id=$1 FOR UPDATE',[id]);
  function revision(row,body){
    requireValue(String(body.revision)===String(row.revision),'다른 화면에서 수정되었습니다. 새로고침하세요',409);
  }
  function touch(values,row){return {...values,updated_at:new Date(),revision:(BigInt(row.revision)+1n).toString()}}

  async function recommend(body){
    const input=validate.lead(body);
    return tx(async client=>{
      const company=await one(client,'SELECT id,name,brand FROM sponsor_companies WHERE id=$1',[input.company_id]);
      requireValue(company,'기업을 찾을 수 없습니다',404);
      const {packages,rules}=await catalog(client);
      return {company,recommendations:recommendations(packages,rules,input)};
    });
  }
  async function saveLead(body,id){
    const values=validate.lead(body);
    return tx(async client=>{
      const company=await one(client,'SELECT id FROM sponsor_companies WHERE id=$1',[values.company_id]);
      requireValue(company,'기업을 찾을 수 없습니다',404);
      if(id){
        const old=await one(client,'SELECT * FROM advertising_leads WHERE id=$1 FOR UPDATE',[id]);
        requireValue(old,'상담을 찾을 수 없습니다',404);
        requireValue(old.company_id===values.company_id,'저장된 상담의 기업은 바꿀 수 없습니다',409);
      }
      const item=await write(client,'advertising_leads',{...values,updated_at:new Date()},id);
      await log(client,id?'lead_update':'lead_create',{company:item.company_id,lead:item.id});
      return item;
    });
  }
  async function saveProposal(body,id){
    const values=validate.proposal(body);
    return tx(async client=>{
      const old=id?await getProposal(client,id):null;
      if(id){
        requireValue(old,'제안을 찾을 수 없습니다',404);
        requireValue(old.status==='draft'&&old.lead_id===values.lead_id,'초안만 수정할 수 있으며 상담 연결은 유지됩니다',409);
        revision(old,body);
      }
      const lead=await one(client,'SELECT * FROM advertising_leads WHERE id=$1',[values.lead_id]);
      requireValue(lead,'상담을 먼저 저장하세요',404);
      const pkg=await one(client,'SELECT id,enabled FROM advertising_packages WHERE id=$1',[values.package_id]);
      requireValue(pkg&&(pkg.enabled||old?.package_id===pkg.id),'사용 가능한 광고상품을 선택하세요',409);
      const item=await write(client,'advertising_proposals',old?touch(values,old):{...values,company_id:lead.company_id},id);
      await log(client,id?'proposal_update':'proposal_create',{company:item.company_id,lead:item.lead_id,proposal:item.id});
      return item;
    });
  }

  async function proposalCommand(id,body){
    return tx(async client=>{
      const row=await getProposal(client,id);
      requireValue(row,'제안을 찾을 수 없습니다',404);
      const targets={finalize:'finalized',mark_sent:'sent',cancel:'cancelled'};
      requireValue(Object.hasOwn(targets,body.command),'제안 상태 명령을 확인하세요');
      const target=targets[body.command];
      if(row.status===target)return row;
      revision(row,body);
      const verified=await one(client,'SELECT * FROM advertising_contracts WHERE proposal_id=$1 FOR UPDATE',[id]);
      const allowed=(target==='finalized'&&row.status==='draft')||
        (target==='sent'&&row.status==='finalized')||
        (target==='cancelled'&&!row.campaign_id&&(!verified||editContract.has(verified.status)||verified.status==='cancelled'));
      requireValue(allowed,'현재 제안 상태에서는 변경할 수 없습니다',409);
      const item=await write(client,'advertising_proposals',touch({status:target,
        finalized_at:target==='finalized'?new Date():row.finalized_at},row),id);
      if(verified&&((target==='sent'&&['consulting','proposal_writing'].includes(verified.status))||
        (target==='cancelled'&&verified.status!=='cancelled'))){
        const state=target==='sent'?'proposal_sent':'cancelled';
        await write(client,'advertising_contracts',touch({status:state},verified),verified.id);
        await log(client,'contract_'+state,{company:row.company_id,proposal:id,contract:verified.id});
      }
      await log(client,'proposal_'+target,{company:row.company_id,lead:row.lead_id,proposal:id});
      return item;
    });
  }

  async function saveContract(body,id){
    const values=validate.contract(body);
    const proposalId=validate.id(body.proposalId,'제안');
    return tx(async client=>{
      const proposal=await getProposal(client,proposalId);
      requireValue(proposal&&proposal.status!=='cancelled','등록할 수 있는 제안을 선택하세요',404);
      if(id){
        const old=await getContract(client,id);
        requireValue(old&&old.proposal_id===proposalId,'계약을 찾을 수 없습니다',404);
        requireValue(editContract.has(old.status),'확정 또는 종료된 계약의 조건은 수정할 수 없습니다',409);
        revision(old,body);
        const updated=await write(client,'advertising_contracts',touch(values,old),id);
        await log(client,'contract_update',{company:proposal.company_id,proposal:proposalId,contract:id});
        return updated;
      }
      const existing=await one(client,'SELECT id FROM advertising_contracts WHERE proposal_id=$1',[proposalId]);
      requireValue(!existing,'이미 이 제안에 연결된 계약이 있습니다',409);
      const item=await write(client,'advertising_contracts',{...values,proposal_id:proposalId,
        status:proposal.status==='sent'?'proposal_sent':'consulting'});
      await log(client,'contract_create',{company:proposal.company_id,proposal:proposalId,contract:item.id});
      return item;
    });
  }

  async function contractCommand(id,body){
    return tx(async client=>{
      const initial=await one(client,'SELECT proposal_id FROM advertising_contracts WHERE id=$1',[id]);
      requireValue(initial,'계약을 찾을 수 없습니다',404);
      const proposal=await getProposal(client,initial.proposal_id);
      const old=await getContract(client,id);
      const target=body.status;
      if(old.status===target)return old;
      revision(old,body);
      requireValue(transition[old.status].includes(target),'현재 계약 상태에서는 변경할 수 없습니다',409);
      requireValue(!['proposal_sent','negotiating','confirmed','running'].includes(target)||
        ['finalized','sent'].includes(proposal.status),'제안을 먼저 확정하세요',409);
      const item=await write(client,'advertising_contracts',touch({status:target,
        confirmed_at:target==='confirmed'?new Date():old.confirmed_at},old),id);
      if(target==='proposal_sent'&&proposal.status==='finalized'){
        await write(client,'advertising_proposals',touch({status:'sent'},proposal),proposal.id);
        await log(client,'proposal_sent',{company:proposal.company_id,proposal:proposal.id,contract:id});
      }
      await log(client,'contract_'+target,{company:proposal.company_id,proposal:proposal.id,contract:id});
      return item;
    });
  }

  async function createDraft(id){
    return tx(async client=>{
      const row=await getProposal(client,id);
      requireValue(row,'제안을 찾을 수 없습니다',404);
      if(row.campaign_id)return {campaign:await campaigns.find(client,row.campaign_id),created:false};
      requireValue(['finalized','sent'].includes(row.status),'제안을 확정한 뒤 캠페인 초안을 만들 수 있습니다',409);
      const lead=await one(client,'SELECT goal,goal_note FROM advertising_leads WHERE id=$1',[row.lead_id]);
      const draft=await campaigns.saveCampaign(null,{
        companyId:row.company_id,type:row.event_type,title:row.title,description:row.description,
        opensAt:row.opens_at.toISOString(),startsAt:row.starts_at.toISOString(),endsAt:row.ends_at.toISOString(),
        adGoal:lead.goal,joinTerms:row.join_terms,estimatedReach:row.expected_reach,
        questions:[],missions:[]
      },{client,advertising:{packageId:row.package_id,couponPolicyId:row.coupon_policy_id,
        activities:row.activities,benefitNotes:row.benefit_notes}});
      await write(client,'advertising_proposals',touch({campaign_id:draft.id},row),id);
      await log(client,'campaign_draft',{company:row.company_id,lead:row.lead_id,proposal:id});
      return {campaign:draft,created:true};
    });
  }

  async function dashboard(companyId){
    return tx(async client=>{
      const companies=await query(client,`SELECT b.id,b.name,b.brand,b.industry,b.enabled,
        (SELECT count(*)::int FROM advertising_leads WHERE company_id=b.id) AS lead_count,
        (SELECT count(*)::int FROM advertising_proposals WHERE company_id=b.id) AS proposal_count,
        (SELECT count(*)::int FROM advertising_contracts k JOIN advertising_proposals p ON p.id=k.proposal_id
          WHERE p.company_id=b.id) AS contract_count,
        (SELECT count(*)::int FROM sponsor_campaigns WHERE company_id=b.id AND status='active') AS active_count
        FROM sponsor_companies b ORDER BY b.brand,b.id`);
      const totals=await one(client,`SELECT (SELECT count(*)::int FROM sponsor_companies WHERE enabled) AS advertisers,
        (SELECT count(*)::int FROM advertising_proposals) AS proposals,
        (SELECT count(*)::int FROM advertising_contracts) AS contracts,
        (SELECT count(*)::int FROM sponsor_campaigns WHERE status='active') AS active_campaigns,
        (SELECT count(*)::int FROM campaign_participants) AS participants,
        (SELECT count(*)::int FROM (SELECT DISTINCT campaign_id,participant_id FROM campaign_quiz_submissions) q) AS quiz_submitters,
        (SELECT count(*)::int FROM (SELECT campaign_id,participant_id FROM campaign_mission_progress m
          GROUP BY campaign_id,participant_id HAVING count(*)=(SELECT count(*) FROM campaign_missions WHERE campaign_id=m.campaign_id)) x) AS mission_completers`);
      const settlements=await one(client,`SELECT count(*)::int AS finalized,
        coalesce(sum((snapshot->>'total')::numeric),0)::text AS planned_total
        FROM advertising_settlements WHERE status='finalized' AND ($1::uuid IS NULL OR company_id=$1)`,
        [companyId||null]);
      const result={companies,totals,actualSettlement:settlements.finalized?settlements:null};
      if(!companyId)return result;
      const company=await one(client,'SELECT * FROM sponsor_companies WHERE id=$1',[companyId]);
      requireValue(company,'기업을 찾을 수 없습니다',404);
      const ads=await query(client,`SELECT c.id,c.title,c.status,c.type,c.starts_at,c.ends_at,c.estimated_reach,
        (SELECT count(*)::int FROM campaign_participants WHERE campaign_id=c.id) AS participants,
        (SELECT count(DISTINCT participant_id)::int FROM campaign_quiz_submissions WHERE campaign_id=c.id) AS quiz_submitters,
        (SELECT count(*)::int FROM (SELECT participant_id FROM campaign_mission_progress WHERE campaign_id=c.id
          GROUP BY participant_id HAVING count(*)=(SELECT count(*) FROM campaign_missions WHERE campaign_id=c.id)) m) AS mission_completers,
        EXISTS (SELECT 1 FROM rps_event_runtime r WHERE r.event_id=c.event_id AND r.snapshot#>>'{game,champion}' IS NOT NULL) AS has_winner
        FROM sponsor_campaigns c WHERE c.company_id=$1 ORDER BY c.created_at DESC LIMIT 100`,[companyId]);
      const campaignsList=ads.map(row=>{
        const completed=row.type==='quiz'?row.quiz_submitters:row.type==='mission'?row.mission_completers:Number(row.has_winner);
        return {...row,completed,participationRate:row.estimated_reach>0?Math.round(row.participants*1000/row.estimated_reach)/10:null,
          completionRate:row.participants?Math.round(completed*1000/row.participants)/10:null};
      });
      return {...result,company,campaigns:campaignsList,
        leads:await query(client,'SELECT * FROM advertising_leads WHERE company_id=$1 ORDER BY created_at DESC LIMIT 100',[companyId]),
        proposals:await query(client,`SELECT p.*, a.name AS package_name FROM advertising_proposals p
          JOIN advertising_packages a ON a.id=p.package_id WHERE p.company_id=$1 ORDER BY p.created_at DESC LIMIT 100`,[companyId]),
        contracts:await query(client,`SELECT k.*,k.contract_start::text AS contract_start,k.contract_end::text AS contract_end,p.title AS proposal_title FROM advertising_contracts k
          JOIN advertising_proposals p ON p.id=k.proposal_id WHERE p.company_id=$1 ORDER BY k.created_at DESC LIMIT 100`,[companyId]),
        logs:await query(client,'SELECT * FROM advertising_activity_logs WHERE company_id=$1 ORDER BY id DESC LIMIT 40',[companyId])};
    });
  }

  async function savePackage(id,body){
    return tx(async client=>{
      const item=await write(client,'advertising_packages',validate.pkg(body),id);
      requireValue(item,'광고상품을 찾을 수 없습니다',404);return item;
    });
  }
  async function saveRule(id,body){
    return tx(async client=>{
      const values=validate.rule(body);
      if(!id){
        values.package_id=validate.id(body.packageId,'광고상품');
        requireValue(await one(client,'SELECT id FROM advertising_packages WHERE id=$1',[values.package_id]),'광고상품을 찾을 수 없습니다',404);
        values.rule_code='custom-'+randomUUID();
      }
      const item=await write(client,'advertising_pricing_rules',values,id);
      requireValue(item,'추천 규칙을 찾을 수 없습니다',404);return item;
    });
  }
  return {tx,catalog,recommend,saveLead,saveProposal,proposalCommand,saveContract,contractCommand,
    createDraft,dashboard,savePackage,saveRule};
}
module.exports={createAdvertising};
