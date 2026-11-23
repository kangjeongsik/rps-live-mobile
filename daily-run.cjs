process.env.RPS_DAILY_CLI='1';

async function main(){
  const [flag,value,...rest]=process.argv.slice(2);
  if((flag&&flag!=='--at')||(flag&&!value)||rest.length)throw Error('Usage: node daily-run.cjs [--at ISO-8601]');
  const url=new URL(process.env.DATABASE_URL||'');
  if(flag&&(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!/(Z|[+-]\d{2}:\d{2})$/i.test(value)))
    throw Error('--at requires a local PostgreSQL database and an explicit timezone');
  const now=flag?new Date(value):new Date();
  if(!Number.isFinite(now.getTime()))throw Error('Invalid test clock');
  const app=require('./tournament.cjs');
  try{
    await app.initialize();
    console.log(JSON.stringify(await app.runDailySchedule(now)));
  }finally{await app.close()}
}
main().catch(error=>{
  console.error('DAILY run failed:',error.code||error.message);
  process.exitCode=1;
});
