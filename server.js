import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';
const app=express();
app.disable('x-powered-by');
app.use(express.json({limit:'12mb'}));
const allowed='https://billy-rp-quickdesk.onrender.com';
app.use((req,res,next)=>{
 res.setHeader('Access-Control-Allow-Origin',allowed);
 res.setHeader('Vary','Origin');
 res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Sync-Key');
 res.setHeader('Access-Control-Allow-Methods','GET,PUT,OPTIONS');
 res.setHeader('Cache-Control','no-store');
 if(req.method==='OPTIONS') return res.sendStatus(204);
 next();
});
const pool=process.env.DATABASE_URL?new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSL==='disable'?false:{rejectUnauthorized:false}}):null;
let initialized=false;
async function init(){
 if(!pool)throw Error('DATABASE_URL not configured');
 if(!initialized){await pool.query('CREATE TABLE IF NOT EXISTS billy_sync_state (id integer PRIMARY KEY CHECK (id=1), revision text NOT NULL, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');initialized=true;}
}
function valid(s){return s&&Array.isArray(s.categories)&&s.categories.length>0&&s.categories.length<=100&&Array.isArray(s.items)&&s.items.length<=2000&&s.items.every(i=>i&&typeof i.id==='string'&&typeof i.title==='string'&&typeof i.categoryId==='string'&&typeof i.body==='string')}
app.get('/health',(req,res)=>res.json({ok:true,storageConfigured:!!pool}));
app.get('/api/sync',async(req,res)=>{try{await init();const q=await pool.query('SELECT revision,state FROM billy_sync_state WHERE id=1');res.json(q.rows[0]||{revision:null,state:null});}catch(e){console.error(e);res.status(503).json({error:'클라우드 저장소 연결을 확인해 주세요'})}});
app.put('/api/sync',async(req,res)=>{
 const s=req.body?.state;
 if(!valid(s))return res.status(400).json({error:'저장 데이터 형식이 올바르지 않습니다'});
 try{await init();const client=await pool.connect();
 try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(93014011)');
 const old=await client.query('SELECT revision FROM billy_sync_state WHERE id=1');
 const revision=old.rows[0]?.revision||null;
 if(revision!== (req.body.revision||null)){await client.query('ROLLBACK');return res.status(409).json({error:'다른 기기에서 먼저 수정했습니다. 새로고침 후 확인해 주세요'})}
 const next=crypto.randomUUID();
 await client.query('INSERT INTO billy_sync_state (id,revision,state) VALUES (1,$1,$2) ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,state=EXCLUDED.state,updated_at=now()',[next,JSON.stringify(s)]);
 await client.query('COMMIT');res.json({revision:next});
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
 }catch(e){console.error(e);res.status(503).json({error:'클라우드 저장을 완료하지 못했습니다'})}
});

/* Dedicated verification data, separate from real counseling content. */
let verificationInitialized=false;
async function initVerification(){
 await init();
 if(!verificationInitialized){
  await pool.query('CREATE TABLE IF NOT EXISTS billy_sync_verification (id integer PRIMARY KEY CHECK (id=1), revision text NOT NULL, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
  verificationInitialized=true;
 }
}
app.get('/api/verification-sync',async(req,res)=>{
 try{
  await initVerification();
  const q=await pool.query('SELECT revision,state FROM billy_sync_verification WHERE id=1');
  res.json(q.rows[0]||{revision:null,state:null});
 }catch(e){console.error(e);res.status(503).json({error:'verification storage failure'})}
});
app.put('/api/verification-sync',async(req,res)=>{
 const s=req.body?.state;
 if(!valid(s))return res.status(400).json({error:'invalid verification data'});
 try{
  await initVerification();
  const c=await pool.connect();
  try{
   await c.query('BEGIN');
   await c.query('SELECT pg_advisory_xact_lock(93014012)');
   const o=await c.query('SELECT revision FROM billy_sync_verification WHERE id=1');
   const rev=o.rows[0]?.revision||null;
   if(rev!==(req.body.revision||null)){
    await c.query('ROLLBACK');
    return res.status(409).json({error:'revision conflict'});
   }
   const next=crypto.randomUUID();
   await c.query('INSERT INTO billy_sync_verification (id,revision,state) VALUES(1,$1,$2) ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,state=EXCLUDED.state,updated_at=now()',[next,JSON.stringify(s)]);
   await c.query('COMMIT');
   res.json({revision:next});
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }catch(e){console.error(e);res.status(503).json({error:'verification write failure'})}
});
app.delete('/api/verification-sync',async(req,res)=>{
 try{
  await initVerification();
  const result=await pool.query('DELETE FROM billy_sync_verification WHERE id=1 AND revision=$1',[req.body?.revision||'']);
  res.status(result.rowCount?200:409).json({deleted:!!result.rowCount});
 }catch(e){console.error(e);res.status(503).json({error:'verification cleanup failure'})}
});

app.listen(process.env.PORT||10000,'0.0.0.0');
