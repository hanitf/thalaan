// MMORPG v0.5.0 — server: unchanged from 0.4.9 (client adds auto-attack)
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

const envFromServer = path.join(__dirname, '.env');
const envFromRoot = path.join(process.cwd(), '.env');
const envPath = fs.existsSync(envFromServer) ? envFromServer : envFromRoot;
require('dotenv').config({ path: envPath });

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PORT = process.env.PORT || 3000;
const ALLOW_GUESTS = String(process.env.ALLOW_GUESTS || 'false').toLowerCase() === 'true';

const authClient  = (SUPABASE_URL && SUPABASE_ANON_KEY) ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const adminClient = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }) : null;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.static(path.join(__dirname, '../client')));

// Map
const TILE_SIZE = 32;
const MAP_COLS = 30;
const MAP_ROWS = 20;

function makeMap(){
  const ground = new Array(MAP_COLS * MAP_ROWS).fill(2);
  const deco = new Array(MAP_COLS * MAP_ROWS).fill(0);
  const collision = new Array(MAP_COLS * MAP_ROWS).fill(0);

  for(let x=0;x<MAP_COLS;x++){ 
    ground[x]=5; collision[x]=1; 
    const i2=(MAP_ROWS-1)*MAP_COLS+x; ground[i2]=5; collision[i2]=1;
  }
  for(let y=0;y<MAP_ROWS;y++){ 
    const i=y*MAP_COLS; ground[i]=5; collision[i]=1;
    const i2=y*MAP_COLS+(MAP_COLS-1); ground[i2]=5; collision[i2]=1;
  }
  for(let x=4;x<MAP_COLS-4;x++){ const i=10*MAP_COLS+x; ground[i]=7; collision[i]=1; }
  for(let y=9;y<=11;y++){ const i=y*MAP_COLS+15; ground[i]=6; collision[i]=0; }
  for(let x=2;x<MAP_COLS-2;x++){ const i=14*MAP_COLS+x; ground[i]=6; }
  for(let y=5;y<14;y++){ const i=y*MAP_COLS+6; ground[i]=6; }
  for(let y=6;y<14;y+=2){ deco[y*MAP_COLS+8]=4; collision[y*MAP_COLS+8]=1; }
  for(let x=10;x<26;x+=4){ deco[6*MAP_COLS+x]=3; }

  const map2D = Array.from({length:MAP_ROWS},(_,r)=>Array.from({length:MAP_COLS},(_,c)=>collision[r*MAP_COLS+c]?1:0));
  return { ground, deco, collision2D: map2D };
}
const { groundLayer, decoLayer, mapGrid } = (()=>{ const {ground,deco,collision2D}=makeMap(); return { groundLayer:ground, decoLayer:deco, mapGrid:collision2D }; })();
function isBlocked(tx,ty){ return (tx<0||ty<0||tx>=MAP_COLS||ty>=MAP_ROWS) ? true : mapGrid[ty][tx]===1; }

const TICK_RATE = 20;
const players = new Map();
const monsters = new Map();
const items = new Map();

function randomOpenTile(){ for(;;){ const x=Math.floor(Math.random()*MAP_COLS), y=Math.floor(Math.random()*MAP_ROWS); if(!isBlocked(x,y)) return {x,y}; } }
function hpMaxForLevel(level){ return 20 + (level-1)*5; }
function expToNext(level){ return level*10; }
function distance(a,b){ return Math.abs(a.x-b.x)+Math.abs(a.y-b.y); }
function handleMove(e,dir){ const d={up:{x:0,y:-1},down:{x:0,y:1},left:{x:-1,y:0},right:{x:1,y:0}}[dir]; if(!d) return; const nx=e.x+d.x, ny=e.y+d.y; if(!isBlocked(nx,ny)){ e.x=nx; e.y=ny; } }
function tryAttack(att,target){ if(distance(att,target)<=1){ target.hp-=3; return target.hp<=0; } return false; }
function levelUpIfNeeded(p){ const need=expToNext(p.level); if(p.exp>=need){ p.exp-=need; p.level++; p.hpMax=hpMaxForLevel(p.level); p.hp=p.hpMax; } }

for(let i=0;i<8;i++){ const id=uuidv4(),pos=randomOpenTile(); monsters.set(id,{id,x:pos.x,y:pos.y,hp:10}); }
for(let i=0;i<5;i++){ const id=uuidv4(),pos=randomOpenTile(); items.set(id,{id,x:pos.x,y:pos.y,kind:'potion'}); }

function broadcast(payload){ const data=JSON.stringify(payload); wss.clients.forEach(ws=>{ if(ws.readyState===WebSocket.OPEN) ws.send(data); }); }
function send(ws,payload){ if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(payload)); }

async function verifyTokenAndGetUser(token){
  if (!authClient || !token) return null;
  try { const {data,error}=await authClient.auth.getUser(token); if(error) return null; return data.user||null; } catch { return null; }
}
async function loadSnapshot(userId){
  if (!adminClient) return null;
  try { const {data,error}=await adminClient.from('player_snapshots').select('*').eq('user_id',userId).maybeSingle(); if(error) return null; return data; } catch { return null; }
}
async function saveSnapshot(p){
  if (!adminClient) return;
  const row={ user_id:p.accountId,name:p.name,level:p.level,exp:p.exp,potions:p.potions,x:p.x,y:p.y,hp:p.hp,hp_max:p.hpMax,updated_at:new Date().toISOString() };
  try { await adminClient.from('player_snapshots').upsert(row,{ onConflict:'user_id' }); } catch(e){ console.error('[SAVE ERROR]',e.message); }
}

wss.on('connection', ws => {
  let playerId = null;

  ws.on('message', async msg => {
    let data; try { data=JSON.parse(msg); } catch { return; }
    if (data.type==='ping') return send(ws,{type:'pong',ts:data.ts});

    if (data.type==='join') {
      let account = null;
      if (data.authToken) account = await verifyTokenAndGetUser(data.authToken);
      if (!account && !ALLOW_GUESTS) { send(ws,{type:'error',message:'AUTH_REQUIRED'}); try{ws.close();}catch{}; return; }

      const id = uuidv4(); playerId = id;
      let name = String(data.name || (account?.email || 'Player'));
      if (account?.user_metadata?.name) name = account.user_metadata.name;

      let snapshot = null;
      if (account) snapshot = await loadSnapshot(account.id);

      const spawn = randomOpenTile();
      const level   = snapshot?.level   ?? 1;
      const exp     = snapshot?.exp     ?? 0;
      const hpMax   = snapshot?.hp_max  ?? hpMaxForLevel(level);
      const hp      = snapshot?.hp      ?? hpMax;
      const px      = snapshot?.x       ?? spawn.x;
      const py      = snapshot?.y       ?? spawn.y;
      const potions = snapshot?.potions ?? 0;

      players.set(id, { id, accountId: account?.id || ('guest:'+id), name, x:px, y:py, hp, hpMax, level, exp, potions, lastAttack:0, lastSaveAt:Date.now() });

      send(ws, { type:'init', id, map:mapGrid, tileSize:TILE_SIZE, cols:MAP_COLS, rows:MAP_ROWS, render:{ ground:groundLayer, deco:decoLayer }, state:snapshotState() });
      broadcast({ type:'player_joined', player: players.get(id) });
      return;
    }

    if (!playerId || !players.has(playerId)) return;
    const me = players.get(playerId);

    if (data.type==='input')  { if(typeof data.dir==='string') handleMove(me,data.dir); }
    if (data.type==='attack') {
      const now=Date.now(); if (now-me.lastAttack<300) return;
      me.lastAttack=now;
      let killedId=null;
      for (const [mid,m] of monsters) { if (distance(me,m)<=1) { const dead=tryAttack(me,m); if (dead) killedId=mid; break; } }
      if (killedId) { monsters.delete(killedId); me.exp+=3; levelUpIfNeeded(me); if (Math.random()<0.6) { const dropId=uuidv4(); items.set(dropId,{id:dropId,x:me.x,y:me.y,kind:'potion'}); } }
    }
    if (data.type==='pickup') { let picked=null; for(const [iid,it] of items){ if(it.x===me.x&&it.y===me.y){ picked=iid; break; } } if(picked){ const it=items.get(picked); items.delete(picked); if(it.kind==='potion') me.potions=(me.potions||0)+1; } }
    if (data.type==='use') { if (data.item==='potion' && me.potions>0 && me.hp<me.hpMax) { me.potions-=1; me.hp=Math.min(me.hpMax, me.hp+5); } }

    if (adminClient && me.accountId && !String(me.accountId).startsWith('guest:') && Date.now()-me.lastSaveAt>5000) { me.lastSaveAt=Date.now(); saveSnapshot(me).catch(()=>{}); }
  });

  ws.on('close', () => {
    if (playerId && players.has(playerId)) {
      const p = players.get(playerId);
      players.delete(playerId);
      broadcast({ type:'player_left', id:p.id });
      if (adminClient && p.accountId && !String(p.accountId).startsWith('guest:')) saveSnapshot(p).catch(()=>{});
    }
  });
});

function snapshotState(){ return { players:[...players.values()], monsters:[...monsters.values()], items:[...items.values()] }; }

setInterval(() => {
  for (const m of monsters.values()) {
    if (Math.random()<0.5) continue;
    const dirs=['up','down','left','right']; handleMove(m, dirs[Math.floor(Math.random()*dirs.length)]);
    for (const p of players.values()) {
      if (distance(m,p)<=1) { p.hp -= 1; if (p.hp<=0) { const pos=randomOpenTile(); p.x=pos.x; p.y=pos.y; p.hp=p.hpMax; } break; }
    }
  }
  while (monsters.size<8) { const id=uuidv4(), pos=randomOpenTile(); monsters.set(id,{id,x:pos.x,y:pos.y,hp:10}); }
  if (items.size<6 && Math.random()<0.02) { const id=uuidv4(), pos=randomOpenTile(); items.set(id,{id,x:pos.x,y:pos.y,kind:'potion'}); }
  broadcast({ type:'state', ...snapshotState() });
}, 1000/TICK_RATE);

server.listen(PORT, () => console.log(`MMORPG v${process.env.npm_package_version || '0.5.0'} http://localhost:${PORT}`));
