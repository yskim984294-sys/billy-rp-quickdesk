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
app.put('/api/sync',(req,res,next)=>{
 if(!process.env.SYNC_SECRET||!crypto.timingSafeEqual(Buffer.from(crypto.createHash('sha256').update(req.get('X-Sync-Key')||'').digest()),Buffer.from(crypto.createHash('sha256').update(process.env.SYNC_SECRET).digest())))return res.status(401).json({error:'인증 코드가 올바르지 않습니다'});
 next();
});
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
app.listen(process.env.PORT||10000,'0.0.0.0');
