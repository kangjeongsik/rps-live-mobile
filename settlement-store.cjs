const {createHash}=require('node:crypto');
const {requireValue}=require('./campaign-validation.cjs');
const amount=value=>BigInt(value??0);
const min=(a,b)=>a<b?a:b;
const dateKey=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'});
function plusDay(value,days){
  const date=new Date(value+'T00:00:00Z');
  date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10);
}
function monthBoundary(key){
  const [y,m]=key.split('-').map(Number);
  return new Date(Date.UTC(y,m,1)).toISOString().slice(0,10);
}
const round=(n,d)=>n<0n?-((-n+d/2n)/d):(n+d/2n)/d;
const clamp=(value,cap)=>cap==null?value:min(value,amount(cap));
function performance(contract,count,purchase){
  if(contract.billing_mode==='fixed')return 0n;
  return contract.performance_basis==='validated_coupon'
    ?BigInt(count)*amount(contract.unit_fee_krw)
    :round(amount(purchase)*amount(contract.purchase_rate_bps),10000n);
}
function totals(contract,terms){
  const param=amount(contract.vat_rate_bps??1000);
  if(contract.vat_mode==='inclusive'){
    const supply=round(terms*10000n,10000n+param);
    return {supply:supply.toString(),vat:(terms-supply).toString(),total:terms.toString()};
  }
  const vat=contract.vat_mode==='exclusive'?round(terms*param,10000n):0n;
  return {supply:terms.toString(),vat:vat.toString(),total:(terms+vat).toString()};
}
function nextWindow(contract,last){
  const stop=plusDay(contract.contract_end,1);
  const start=last?.period_end||contract.contract_start;
  const ext=start>=stop;
  const next=contract.settlement_cycle==='weekly'?plusDay(start,7):
    contract.settlement_cycle==='monthly'||ext?monthBoundary(start):stop;
  return {start,end:!ext&&next>stop?stop:next,extended:ext};
}

function createSettlements(store){
  const {tx,one,query,audit}=store;
  async function contractRow(client,id,lock=false){
    const result=await one(client,`SELECT a.*,a.contract_start::text,a.contract_end::text,p.company_id,p.campaign_id,p.title
      FROM advertising_contracts a JOIN advertising_proposals p ON p.id=a.proposal_id
      WHERE a.id=$1 ${lock?'FOR UPDATE OF a':''}`,[id]);
    requireValue(result?.campaign_id&&result.confirmed_at,'캠페인이 연결된 확정 계약을 선택하세요',409);
    return result;
  }
  const ledger=async(client,id)=>query(client,`SELECT *,period_start::text,period_end::text
    FROM advertising_settlements WHERE contract_id=$1 AND status='finalized' ORDER BY advertising_settlements.period_start`,[id]);

  async function calculate(client,contract,history,window){
    const {start,end}=window;
    const cut=end+'T00:00:00+09:00';
    const startOfContract=contract.contract_start+'T00:00:00+09:00';
    const contractEnd=plusDay(contract.contract_end,1)+'T00:00:00+09:00';
    await query(client,`SELECT id FROM coupon_redemptions WHERE campaign_id=$1 AND approved_at<$2 ORDER BY id FOR UPDATE`,
      [contract.campaign_id,cut]);
    const candidates=await query(client,`SELECT r.id,r.approved_at,r.external_verified_at,r.external_amount_krw,
      EXISTS(SELECT 1 FROM coupon_redemption_adjustments a WHERE a.redemption_id=r.id
        AND a.status='approved' AND a.decided_at<$4 AND a.full_reversal) AS reversed,
      coalesce((SELECT sum(refund_krw) FROM coupon_redemption_adjustments a WHERE a.redemption_id=r.id
        AND a.status='approved' AND a.decided_at<$4),0) AS refunds
      FROM coupon_redemptions r WHERE r.campaign_id=$1 AND r.approved_at>=$2 AND r.approved_at<$3
      AND r.approved_at<$4 AND NOT EXISTS (SELECT 1 FROM advertising_settlement_items it WHERE it.redemption_id=r.id)
      AND NOT EXISTS (SELECT 1 FROM advertising_settlements s
        WHERE s.contract_id=$5 AND s.status='finalized' AND s.snapshot->'excluded' @> jsonb_build_array(jsonb_build_object('id',r.id,'reason','reversed')))
      ORDER BY r.approved_at,r.id`,[contract.campaign_id,startOfContract,contractEnd,cut,contract.id]);
    const external=contract.evidence_level==='external'||contract.performance_basis==='validated_purchase';
    const items=[],excluded=[];
    for(const row of candidates){
      const verified=row.external_verified_at&&row.external_verified_at<new Date(cut);
      const purchase=verified?amount(row.external_amount_krw)-amount(row.refunds):0n;
      if(row.reversed||(!verified&&external)){
        excluded.push({id:row.id,reason:row.reversed?'reversed':'external_evidence_required'});
      }else items.push({id:row.id,count:1,purchase:purchase.toString(),proof:verified?'external':'store',
        approvedAt:row.approved_at.toISOString()});
    }
    const count=items.length;
    const purchase=items.reduce((sum,item)=>sum+amount(item.purchase),0n);
    const fixed=history.length?0n:amount(contract.fixed_fee_krw);
    const fee=performance(contract,count,purchase);
    const base=fixed+fee;
    const adjustments=await query(client,`SELECT a.id,a.full_reversal,a.refund_krw,i.eligible_krw,s.id AS origin,
      coalesce((SELECT sum(previous.purchase_delta) FROM advertising_settlement_adjustments previous
        JOIN coupon_redemption_adjustments related ON related.id=previous.adjustment_id
        WHERE related.redemption_id=a.redemption_id),0) AS prior_delta,a.redemption_id
      FROM coupon_redemption_adjustments a JOIN advertising_settlement_items i ON i.redemption_id=a.redemption_id
      JOIN advertising_settlements s ON s.id=i.settlement_id
      WHERE s.contract_id=$1 AND a.status='approved' AND a.decided_at<$2
        AND a.decided_at>=s.period_end::timestamp AT TIME ZONE 'Asia/Seoul'
        AND NOT EXISTS (SELECT 1 FROM advertising_settlement_adjustments l WHERE l.adjustment_id=a.id)
      ORDER BY a.decided_at,a.id`,[contract.id,cut]);
    const lines=[],perTrade=new Map();
    for(const row of adjustments){
      const left=amount(row.eligible_krw)+amount(row.prior_delta)+(perTrade.get(row.redemption_id)||0n);
      const delta=-min(left,amount(row.refund_krw));
      perTrade.set(row.redemption_id,(perTrade.get(row.redemption_id)||0n)+delta);
      lines.push({id:row.id,redemptionId:row.redemption_id,origin:row.origin,countDelta:row.full_reversal?-1:0,purchaseDelta:delta.toString()});
    }
    let rawChange=0n,cappedChange=0n;
    for(const original of history.filter(entry=>lines.some(line=>line.origin===entry.id))){
      const prior=await one(client,`SELECT coalesce(sum(count_delta),0) AS count,coalesce(sum(purchase_delta),0) AS paid
        FROM advertising_settlement_adjustments WHERE origin_id=$1`,[original.id]);
      const next=lines.filter(line=>line.origin===original.id);
      const beforeCount=original.snapshot.recognizedCount+Number(prior.count);
      const beforePaid=amount(original.snapshot.recognizedPurchase)+amount(prior.paid);
      const before=amount(original.snapshot.fixed)+performance(contract,beforeCount,beforePaid);
      const after=amount(original.snapshot.fixed)+performance(contract,beforeCount+next.reduce((sum,line)=>sum+line.countDelta,0),
        beforePaid+next.reduce((sum,line)=>sum+amount(line.purchaseDelta),0n));
      rawChange+=after-before;
      cappedChange+=clamp(after,contract.cap_krw)-clamp(before,contract.cap_krw);
    }
    const prevRaw=history.reduce((sum,row)=>sum+amount(row.snapshot.rawNet),0n);
    const prevBilled=history.reduce((sum,row)=>sum+amount(row.snapshot.taxBase),0n);
    const billed=contract.cap_scope==='period'?clamp(base,contract.cap_krw)+cappedChange:
      clamp(prevRaw+base+rawChange,contract.cap_krw)-prevBilled;
    const contractTerms={mode:contract.billing_mode,basis:contract.performance_basis,cap:contract.cap_krw,
      capScope:contract.cap_scope,evidence:external?'external':'store',vat:contract.vat_mode,vatRate:contract.vat_rate_bps,
      revision:contract.revision,fixed:contract.fixed_fee_krw,unit:contract.unit_fee_krw,rate:contract.purchase_rate_bps};
    return {periodStart:start,periodEndExclusive:end,contract:contractTerms,fixed:fixed.toString(),
      recognizedCount:count,recognizedPurchase:purchase.toString(),performance:fee.toString(),
      adjustment:rawChange.toString(),capApplied:(base+rawChange-billed).toString(),rawNet:(base+rawChange).toString(),
      taxBase:billed.toString(),...totals(contract,billed),items,adjustments:lines,excluded};
  }
  const fingerprint=snapshot=>createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  async function run(id,command,now,actor,settlementId){
    return tx(async client=>{
      const contract=await contractRow(client,id,true);
      if(settlementId){
        const requested=await one(client,`SELECT *,period_start::text,period_end::text FROM advertising_settlements
          WHERE id=$1 AND contract_id=$2`,[settlementId,id]);
        requireValue(requested,'이 계약의 정산서를 찾을 수 없습니다',404);
        if(requested.status==='finalized'&&command==='finalize')return requested;
      }
      const history=await ledger(client,id);
      const window=nextWindow(contract,history.at(-1));
      requireValue(window.end<=dateKey.format(now),'정산 기간 종료 후 집계할 수 있습니다',409);
      const saved=await one(client,`SELECT *,period_start::text,period_end::text FROM advertising_settlements
        WHERE contract_id=$1 AND period_start=$2 FOR UPDATE`,[id,window.start]);
      const snapshot=await calculate(client,contract,history,window);
      const key=fingerprint(snapshot);
      if(command==='collect'){
        const status=snapshot.excluded.some(item=>item.reason==='external_evidence_required')?'needs_review':'collecting';
        return one(client,`INSERT INTO advertising_settlements
          (contract_id,company_id,campaign_id,period_start,period_end,status,snapshot,fingerprint)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(contract_id,period_start)
          DO UPDATE SET status=$6,snapshot=$7,fingerprint=$8 RETURNING *,period_start::text,period_end::text`,
        [id,contract.company_id,contract.campaign_id,window.start,window.end,status,snapshot,key]);
      }
      requireValue(saved&&saved.id===settlementId&&saved.fingerprint===key,'집계 이후 내역이 바뀌었습니다. 다시 집계하세요',409);
      if(command==='review'){
        if(saved.status==='reviewed')return saved;
        const reviewed=await one(client,`UPDATE advertising_settlements SET status='reviewed' WHERE id=$1
          RETURNING *,period_start::text,period_end::text`,[saved.id]);
        await audit(client,'settlement_reviewed',{actor,detail:saved.id});
        return reviewed;
      }
      requireValue(saved.status==='reviewed','검토 완료 후 확정하세요',409);
      for(const item of snapshot.items)await query(client,`INSERT INTO advertising_settlement_items
        (settlement_id,redemption_id,eligible_count,eligible_krw) VALUES($1,$2,$3,$4)`,[saved.id,item.id,item.count,item.purchase]);
      for(const item of snapshot.adjustments)await query(client,`INSERT INTO advertising_settlement_adjustments
        (settlement_id,adjustment_id,origin_id,count_delta,purchase_delta) VALUES($1,$2,$3,$4,$5)`,
      [saved.id,item.id,item.origin,item.countDelta,item.purchaseDelta]);
      const locked=await one(client,`UPDATE advertising_settlements SET status='finalized',finalized_at=$2,
        finalized_by=$3 WHERE id=$1 RETURNING *,period_start::text,period_end::text`,[saved.id,now,actor]);
      await audit(client,'settlement_finalized',{actor,detail:saved.id});
      return locked;
    });
  }
  async function list(company){
    return tx(async client=>{
      const contracts=await query(client,`SELECT a.id,p.title,a.billing_mode,a.cap_scope,a.evidence_level,a.vat_rate_bps
        FROM advertising_contracts a JOIN advertising_proposals p ON p.id=a.proposal_id
        WHERE p.company_id=$1 AND a.confirmed_at IS NOT NULL AND p.campaign_id IS NOT NULL ORDER BY p.title`,[company]);
      const settlements=await query(client,`SELECT s.*,s.period_start::text,s.period_end::text,p.title,
        EXISTS(SELECT 1 FROM advertising_settlement_items i JOIN coupon_redemption_adjustments a ON a.redemption_id=i.redemption_id
          WHERE i.settlement_id=s.id AND a.status='approved' AND a.decided_at>=s.period_end::timestamp AT TIME ZONE 'Asia/Seoul' AND NOT EXISTS
          (SELECT 1 FROM advertising_settlement_adjustments applied WHERE adjustment_id=a.id)) AS adjustment_needed
        FROM advertising_settlements s JOIN advertising_proposals p ON p.campaign_id=s.campaign_id
        WHERE s.company_id=$1 ORDER BY s.period_start DESC,s.id LIMIT 150`,[company]);
      return {contracts,settlements};
    });
  }
  const get=id=>tx(async client=>{
    const row=await one(client,`SELECT s.*,s.period_start::text,s.period_end::text,b.brand,c.title
      FROM advertising_settlements s JOIN sponsor_companies b ON b.id=s.company_id
      JOIN sponsor_campaigns c ON c.id=s.campaign_id WHERE s.id=$1`,[id]);
    requireValue(row,'정산서를 찾을 수 없습니다',404);return row;
  });
  return {run,list,get};
}

function csv(row){
  const q=value=>{
    const text=String(value??'');
    const safe=/^[\s\uFEFF]*[=+@-]/.test(text)&&!/^-\d+$/.test(text)?"'"+text:text;
    return '"'+safe.replace(/"/g,'""')+'"';
  };
  const s=row.snapshot;
  return '\uFEFF'+[
    ['기업','계약 ID','캠페인','정산 시작','종료일(미포함)','상태','고정 광고비','인정 사용','인정 구매액','성과 광고비','조정액','상한 차감','공급가액','부가세','총 예정액'],
    [row.brand,row.contract_id,row.title,row.period_start,row.period_end,row.status,s.fixed,s.recognizedCount,s.recognizedPurchase,
      s.performance,s.adjustment,s.capApplied,s.supply,s.vat,s.total],
    [],
    ['거래 ID','인정 건수','인정 구매액','증빙'],
    ...s.items.map(item=>[item.id,item.count,item.purchase,item.proof]),
    [],
    ['조정 ID','원 정산서 ID','건수 조정','구매액 조정'],
    ...s.adjustments.map(item=>[item.id,item.origin,item.countDelta,item.purchaseDelta]),
    [],
    ['제외 거래 ID','제외 사유'],
    ...s.excluded.map(item=>[item.id,item.reason])
  ].map(line=>line.map(q).join(',')).join('\r\n');
}
module.exports={createSettlements,csv,performance,totals,nextWindow};
