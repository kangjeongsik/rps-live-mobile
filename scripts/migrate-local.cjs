const {readFile}=require('node:fs/promises');
const {resolve}=require('node:path');
const {createHash}=require('node:crypto');
const {Client}=require('pg');
const files=['supabase-prizes.sql','supabase-v0.7.31.sql','supabase-v0.7.32.sql',
  'supabase-phase1-events.sql','supabase-phase2-daily.sql','supabase-phase3-campaigns.sql',
  'supabase-phase4-advertising.sql','supabase-phase5-coupons-settlement.sql'];

async function main(){
  const name=process.env.RPS_LOCAL_MIGRATION_DB;
  let url;
  try{url=new URL(process.env.RPS_LOCAL_MIGRATION_DSN)}catch{throw Error('RPS_LOCAL_MIGRATION_DSN is missing or invalid')}
  if(!/^rps_local_[a-z0-9_]+$/.test(name||'')||
    !['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||
    url.pathname!=='/'+name||url.search||url.hash)throw Error('Use an explicit loopback rps_local_* test database');
  const client=new Client({connectionString:url.toString(),ssl:false,connectionTimeoutMillis:3000});
  await client.connect();
  try{
    const {rows:[row]}=await client.query(`SELECT current_database() AS db,
      to_regclass('public.rps_staging_identity') AS staging`);
    if(row.db!==name||row.staging)throw Error('Database identity is not a local migration target');
    await client.query("SELECT pg_advisory_lock(hashtext('rps-local-migrations-v1'))");
    const {rows:[before]}=await client.query(`SELECT to_regclass('public.rps_local_migrations') AS ledger,
      to_regclass('public.rps_prize_cards') AS existing, to_regclass('public.rps_events') AS existing_events`);
    if(!before.ledger&&(before.existing||before.existing_events))
      throw Error('Existing database has no migration ledger. Use a new empty local database.');
    await client.query(`CREATE TABLE IF NOT EXISTS public.rps_local_migrations
      (file text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
    const {rows}=await client.query('SELECT file, checksum FROM public.rps_local_migrations');
    const applied=new Map(rows.map(row=>[row.file,row.checksum]));
    if(files.some((name,index)=>applied.has(name)&&files.slice(0,index).some(prior=>!applied.has(prior))))
      throw Error('Migration ledger contains a gap');
    for(const file of files){
      const content=await readFile(resolve(__dirname,'..',file),'utf8');
      const sql=content.replace(/^\uFEFF/,'');
      const checksum=createHash('sha256').update(sql.replace(/\r\n/g,'\n')).digest('hex');
      if(applied.has(file)){
        if(applied.get(file)!==checksum)throw Error('An applied migration changed: '+file);
        console.log('Already applied',file);
        continue;
      }
      const body=sql.replace(/^\s*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,'');
      await client.query('BEGIN');
      try{
        await client.query(body);
        await client.query('INSERT INTO public.rps_local_migrations(file,checksum) VALUES ($1,$2)',[file,checksum]);
        await client.query('COMMIT');
      }catch(error){
        await client.query('ROLLBACK');
        throw Error(file+' failed ('+(error.code||error.name)+')');
      }
      console.log('Applied',file);
    }
  }finally{await client.end()}
}
main().catch(error=>{console.error(error.code?'Local migration connection failed: '+error.code:error.message);process.exitCode=1});
