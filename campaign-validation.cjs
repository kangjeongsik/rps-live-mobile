const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const isUUID=value=>typeof value==='string'&&uuid.test(value);
const publicStates=new Set(['scheduled','open','active','paused','completed','cancelled']);
const entryStates=new Set(['open','active']);
const kst=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'});

class CampaignError extends Error{
  constructor(status,message){super(message);this.status=status}
}
function requireValue(test,message,status=400){
  if(!test)throw new CampaignError(status,message);
}
function text(value,max,min=0){
  requireValue(value===undefined||typeof value==='string','텍스트 항목을 확인하세요');
  const result=(value||'').trim();
  requireValue(result.length>=min&&result.length<=max,'입력 길이를 확인하세요');
  return result;
}
function link(value){
  const result=text(value,1200);
  if(!result)return '';
  let url;
  try{url=new URL(result)}catch{}
  requireValue(url?.protocol==='https:'&&!url.username&&!url.password,'HTTPS 주소를 입력하세요');
  return url.href;
}
function time(value){
  requireValue(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value),
    '시간대가 포함된 일시를 입력하세요');
  const date=new Date(value);
  requireValue(Number.isFinite(+date),'운영 일시를 확인하세요');
  return date;
}
function dateIndex(date){return Date.parse(kst.format(date)+'T00:00:00Z')/86400000}
function currentDay(campaign,now){return dateIndex(now)-dateIndex(campaign.starts_at)+1}
function question(value){
  requireValue(value&&typeof value==='object','문제를 입력하세요');
  const {choices,correctIndex}=value;
  requireValue(Array.isArray(choices)&&choices.length>=2&&choices.length<=6,'보기는 2~6개를 입력하세요');
  const options=choices.map(choice=>text(choice,220,1));
  requireValue(Number.isInteger(correctIndex)&&correctIndex>=0&&correctIndex<options.length,'정답 번호를 확인하세요');
  return {prompt:text(value.prompt,800,2),options,correctIndex};
}
function companyInput(body){
  return [text(body.name,100,1),text(body.brand,100,1),text(body.industry,100,1),text(body.contactName,100),
    text(body.contactInfo,200),text(body.description,3000),link(body.logoURL),link(body.imageURL),
    link(body.websiteURL),body.enabled!==false,text(body.internalNote,2000)];
}
function campaignInput(body,{advertising=false}={}){
  requireValue(isUUID(body.companyId),'기업을 선택하세요');
  requireValue(['quiz','mission','rps'].includes(body.type),'이벤트 유형을 확인하세요');
  const opens=time(body.opensAt),starts=time(body.startsAt),ends=time(body.endsAt);
  requireValue(opens<=starts&&starts<ends,'참가 시작, 게임 시작, 종료 시각의 순서를 확인하세요');
  const span=dateIndex(new Date(+ends-1))-dateIndex(starts)+1;
  if(body.type==='quiz')requireValue(advertising?span>=1&&span<=31:span===1,advertising
    ?'광고 퀴즈는 한국시간 기준 1~31일 동안 운영할 수 있습니다':'당일 퀴즈는 같은 한국 날짜 안에서 진행해야 합니다');
  requireValue(body.estimatedReach==null||(Number.isInteger(body.estimatedReach)&&body.estimatedReach>=0&&body.estimatedReach<=2147483647),'예상 참여 규모를 확인하세요');
  let questions=[],missions=[];
  if(body.type==='quiz'){
    requireValue(Array.isArray(body.questions)&&body.questions.length<=30,'문제는 최대 30개입니다');
    questions=body.questions.map(value=>{
      const points=value?.points;
      requireValue(Number.isInteger(points)&&points>=1&&points<=1000,'배점은 1~1000점입니다');
      return {...question(value),points};
    });
  }
  if(body.type==='mission'){
    requireValue(span>=1&&span<=31&&Array.isArray(body.missions)&&body.missions.length<=span,'미션 운영 기간은 1~31일입니다');
    missions=body.missions.map(value=>{
      const checked=question(value);
      requireValue(['daily_quiz','content_check'].includes(value.kind),'앱 안에서 채점할 수 있는 미션 유형을 선택하세요');
      return {...checked,title:text(value.title,180,1),description:text(value.description,800),
        kind:value.kind,content:text(value.content,1600,value.kind==='content_check'?1:0)};
    });
  }
  return {values:[body.companyId,body.type,text(body.title,180,2),text(body.description,3000),link(body.imageURL),
    text(body.joinTerms,900),text(body.adGoal,300),body.estimatedReach??null,opens,starts,ends,body.allowRetry===true],
    questions,missions};
}

module.exports={CampaignError,requireValue,isUUID,publicStates,entryStates,currentDay,dateIndex,text,companyInput,campaignInput};
