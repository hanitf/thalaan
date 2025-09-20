import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://yqjevqvjpjspcquqwqvo.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlxamV2cXZqcGpzcGNxdXF3cXZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgxNTAyNDEsImV4cCI6MjA3MzcyNjI0MX0.yv0w-JvXEF4U3XgIoohB2zl8Awv-waRVHPpdnzWGZvg";

(() => {
  let inGame = false;
  let canvas2D = null, ctx2D = null;
  let is3D = false, three = null, renderer3D = null, scene = null, camera = null, raycaster = null;
  let meshTiles = [], groupTiles = null, groupEntities = null, ringMarker = null;

  const emailEl = document.getElementById('email');
  const passEl = document.getElementById('password');
  const signinBtn = document.getElementById('signinBtn');
  const signupBtn = document.getElementById('signupBtn');
  const guestBtn = document.getElementById('guestBtn');
  const testBtn = document.getElementById('testBtn');
  const resetBtn = document.getElementById('resetBtn');
  const displayNameEl = document.getElementById('displayName');
  const authBox = document.getElementById('auth');
  const statusEl = document.getElementById('status');
  const hud = document.getElementById('hud');
  const who = document.getElementById('who');
  const stats = document.getElementById('stats');
  const logoutBtn = document.getElementById('logoutBtn');
  const pvpBtn = document.getElementById('pvpBtn');
  const modeBtn = document.getElementById('modeBtn');
  const stage = document.getElementById('stage');

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

  let session = null, ws = null, wsPingInterval = null;
  let myId = null, cols = 30, rows = 20, tileSize = 32, pvpMode = 'optin';
  let ground = [], deco = [], coll = [];
  const state = { players: [], monsters: [], items: [] };

  // navigation / combat
  let moveQueue = [];
  let lastMoveAt = 0;
  let clickDest = null;
  let target = null; // {type:'mob'|'player', id:string}
  let lastAttackAt = 0;
  let lastTargetPos = null;
  let autoLootPos = null;
  let animStart = performance.now();
  let myPvP = false;

  function setStatus(msg, isError=false) { statusEl.textContent = msg; statusEl.classList.toggle('error', !!isError); }
  const isTyping = () => ['INPUT','TEXTAREA'].includes(document.activeElement?.tagName);

  // ========== 2D SETUP ==========
  function ensureCanvas2D() {
    if (!canvas2D) {
      canvas2D = document.createElement('canvas');
      canvas2D.width = 960; canvas2D.height = 640;
      canvas2D.style.background = '#243148';
      canvas2D.style.border = '2px solid #2e3448';
      canvas2D.style.borderRadius = '8px';
      canvas2D.style.imageRendering = 'pixelated';
      stage.innerHTML = ''; stage.appendChild(canvas2D);
      ctx2D = canvas2D.getContext('2d');
      canvas2D.addEventListener('click', onClick2D);
      canvas2D.addEventListener('contextmenu', (e)=>{ e.preventDefault(); cancelActions(); });
    } else if (!ctx2D) {
      ctx2D = canvas2D.getContext('2d');
    }
  }
  function destroyCanvas2D(){ if (canvas2D?.parentNode) canvas2D.parentNode.removeChild(canvas2D); canvas2D=null; ctx2D=null; }

  // ========== 3D SETUP ==========
  async function enable3D() {
    if (is3D) return;
    try {
      three = await import('https://unpkg.com/three@0.160.0/build/three.module.js');
    } catch (e) {
      setStatus('Falha ao carregar Three.js, ficando em 2D.', true);
      return;
    }
    is3D = true;
    destroyCanvas2D();
    setup3D();
  }
  function disable3D() {
    is3D = false;
    if (renderer3D) { renderer3D.dispose?.(); renderer3D.domElement?.remove(); }
    renderer3D = null; scene = null; camera = null; raycaster = null;
    meshTiles = []; groupTiles = null; groupEntities = null; ringMarker = null;
    ensureCanvas2D();
  }

  function setup3D() {
    const width = 960, height = 640;
    scene = new three.Scene();
    camera = new three.PerspectiveCamera(50, width/height, 0.1, 1000);
    // isometric-ish camera
    const worldW = cols, worldH = rows;
    const cx = worldW/2, cy = worldH/2;
    camera.position.set(cx - 12, 22, cy + 18); // x,y,z
    camera.lookAt(cx, 0, cy);

    renderer3D = new three.WebGLRenderer({ antialias: true });
    renderer3D.setSize(width, height);
    renderer3D.setClearColor(0x243148, 1);
    stage.innerHTML = ''; stage.appendChild(renderer3D.domElement);

    // Light
    const hemi = new three.HemisphereLight(0xffffff, 0x444444, 1.0);
    hemi.position.set(0, 50, 0);
    scene.add(hemi);

    // Groups
    groupTiles = new three.Group(); scene.add(groupTiles);
    groupEntities = new three.Group(); scene.add(groupEntities);

    // Build tiles once
    const psize = 1; // 1 unit per tile
    const geom = new three.PlaneGeometry(psize, psize);
    geom.rotateX(-Math.PI/2);
    for (let y=0; y<rows; y++) {
      for (let x=0; x<cols; x++) {
        const gid = ground[y*cols + x] ?? 2;
        const color = (gid===2) ? 0x3a8f4a : (gid===6) ? 0xc9a36a : (gid===5) ? 0x6d6e71 : (gid===7) ? 0x2b6cb3 : 0x777777;
        const mat = new three.MeshLambertMaterial({ color });
        const m = new three.Mesh(geom, mat);
        m.position.set(x, 0, y);
        m.userData = { x, y, kind: 'tile' };
        groupTiles.add(m);
      }
    }

    // ring marker for target/destination
    const ringGeom = new three.RingGeometry(0.35, 0.48, 32);
    const ringMat = new three.MeshBasicMaterial({ color: 0xf4d35e, side: three.DoubleSide });
    ringMarker = new three.Mesh(ringGeom, ringMat);
    ringMarker.rotation.x = -Math.PI/2;
    ringMarker.visible = false;
    scene.add(ringMarker);

    // Raycaster
    raycaster = new three.Raycaster();
    renderer3D.domElement.addEventListener('click', onClick3D);
    renderer3D.domElement.addEventListener('contextmenu', (e)=>{ e.preventDefault(); cancelActions(); });

    // spawn some entity placeholders
    rebuildEntities3D();
  }

  function rebuildEntities3D() {
    if (!three || !groupEntities) return;
    // clear
    while(groupEntities.children.length) groupEntities.remove(groupEntities.children[0]);
    // players
    for (const p of state.players) {
      const isMe = p.id === myId;
      const mat = new three.MeshLambertMaterial({ color: isMe ? 0x7ec8e3 : 0xb3c7f9 });
      const mesh = new three.Mesh(new three.BoxGeometry(0.6, 1.0, 0.6), mat);
      mesh.position.set(p.x, 0.5, p.y);
      mesh.userData = { type: 'player', id: p.id };
      groupEntities.add(mesh);
    }
    // monsters
    for (const m of state.monsters) {
      const mesh = new three.Mesh(new three.BoxGeometry(0.6, 0.8, 0.6), new three.MeshLambertMaterial({ color: 0xe27d60 }));
      mesh.position.set(m.x, 0.4, m.y);
      mesh.userData = { type: 'mob', id: m.id };
      groupEntities.add(mesh);
    }
    // items
    for (const it of state.items) {
      const mesh = new three.Mesh(new three.BoxGeometry(0.4, 0.4, 0.4), new three.MeshLambertMaterial({ color: 0xd6b38d }));
      mesh.position.set(it.x, 0.2, it.y);
      mesh.userData = { type: 'item', id: it.id };
      groupEntities.add(mesh);
    }
  }

  function updateEntities3D() {
    if (!three || !groupEntities) return;
    const mapByKey = new Map();
    for (const child of groupEntities.children) {
      mapByKey.set(child.userData.type + ':' + child.userData.id, child);
    }
    // players
    for (const p of state.players) {
      const key = 'player:' + p.id;
      let mesh = mapByKey.get(key);
      if (!mesh) {
        const isMe = p.id === myId;
        mesh = new three.Mesh(new three.BoxGeometry(0.6, 1.0, 0.6), new three.MeshLambertMaterial({ color: isMe ? 0x7ec8e3 : 0xb3c7f9 }));
        mesh.userData = { type:'player', id:p.id };
        groupEntities.add(mesh);
      }
      mesh.position.set(p.x, 0.5, p.y);
    }
    // monsters
    for (const m of state.monsters) {
      const key = 'mob:' + m.id;
      let mesh = mapByKey.get(key);
      if (!mesh) {
        mesh = new three.Mesh(new three.BoxGeometry(0.6, 0.8, 0.6), new three.MeshLambertMaterial({ color: 0xe27d60 }));
        mesh.userData = { type:'mob', id:m.id };
        groupEntities.add(mesh);
      }
      mesh.position.set(m.x, 0.4, m.y);
    }
    // items
    for (const it of state.items) {
      const key = 'item:' + it.id;
      let mesh = mapByKey.get(key);
      if (!mesh) {
        mesh = new three.Mesh(new three.BoxGeometry(0.4, 0.4, 0.4), new three.MeshLambertMaterial({ color: 0xd6b38d }));
        mesh.userData = { type:'item', id:it.id };
        groupEntities.add(mesh);
      }
      mesh.position.set(it.x, 0.2, it.y);
    }
    // remove stale
    for (const [key, mesh] of mapByKey.entries()) {
      const [type, id] = key.split(':');
      if (type==='player' && !state.players.find(p=>p.id===id)) groupEntities.remove(mesh);
      if (type==='mob' && !state.monsters.find(m=>m.id===id)) groupEntities.remove(mesh);
      if (type==='item' && !state.items.find(it=>it.id===id)) groupEntities.remove(mesh);
    }
  }

  // 2D helpers and drawing (same medieval style)
  function getOffsets2D(){
    const viewW = canvas2D.width, viewH = canvas2D.height;
    const mapW = cols * tileSize, mapH = rows * tileSize;
    return { ox: Math.floor((viewW - mapW) / 2), oy: Math.floor((viewH - mapH) / 2) };
  }
  function fillRect(x,y,w,h,c){ ctx2D.fillStyle = c; ctx2D.fillRect(x,y,w,h); }
  function strokeRect(x,y,w,h,c){ ctx2D.strokeStyle=c; ctx2D.lineWidth=1; ctx2D.strokeRect(x+0.5,y+0.5,w-1,h-1); }
  function fillCircle(x,y,r,c){ ctx2D.fillStyle=c; ctx2D.beginPath(); ctx2D.arc(x,y,r,0,Math.PI*2); ctx2D.fill(); }
  function drawTileXY(px, py, gid) {
    if (gid === 2 || gid === undefined) { fillRect(px, py, tileSize, tileSize, '#3a8f4a'); for (let i=0;i<6;i++) { const nx = px + 4 + (i*5 % (tileSize-8)); const ny = py + (i*7 % (tileSize-8)); fillRect(nx, ny, 2, 2, '#2f7a3d'); } fillRect(px, py, tileSize, 2, '#56b35f'); }
    else if (gid === 6) { fillRect(px, py, tileSize, tileSize, '#c9a36a'); for (let i=2;i<tileSize;i+=4) fillRect(px, py+i, tileSize, 1, '#b38c52'); fillRect(px, py, tileSize, 1, '#e5c694'); fillRect(px, py+tileSize-1, tileSize, 1, '#8f6c3f'); }
    else if (gid === 5) { fillRect(px, py, tileSize, tileSize, '#6d6e71'); for (let i=4;i<tileSize;i+=8) fillRect(px, py+i, tileSize, 2, '#58595b'); strokeRect(px+1, py+1, tileSize-2, tileSize-2, '#414244'); }
    else if (gid === 7) { fillRect(px, py, tileSize, tileSize, '#2b6cb3'); for (let i=0;i<tileSize;i+=4) fillRect(px+i, py+((i/4)%2?6:4), 3, 2, '#7fb3ff'); }
    else { fillRect(px, py, tileSize, tileSize, '#7a7a7a'); }
  }
  function drawHPBar(cx, cy, w, hp, hpMax) {
    const ratio = Math.max(0, Math.min(1, hp / Math.max(1, hpMax)));
    fillRect(cx, cy, w, 4, '#1a1f2b');
    fillRect(cx, cy, Math.floor(w*ratio), 4, '#86e3b4');
  }
  function drawPlayer2D(p, ox, oy) {
    const px = ox + p.x*tileSize, py = oy + p.y*tileSize;
    fillRect(px+6, py+tileSize-8, tileSize-12, 4, 'rgba(0,0,0,0.25)');
    fillRect(px+8, py+8, tileSize-16, tileSize-14, p.id===myId ? '#7ec8e3' : '#b3c7f9');
    fillRect(px+10, py+4, tileSize-20, 6, '#cfcfd6');
    fillRect(px+8, py+18, tileSize-16, 3, '#4b2e1b');
    drawHPBar(px, py-6, tileSize, p.hp, p.hpMax);
    ctx2D.fillStyle = '#e6eefc'; ctx2D.font = '12px monospace'; ctx2D.textAlign = 'center';
    ctx2D.fillText((p.pvp?'⚔ ':'')+(p.name || 'Player'), px + tileSize/2, py - 10);
  }
  function drawMonster2D(m, ox, oy) {
    const px = ox + m.x*tileSize, py = oy + m.y*tileSize;
    fillRect(px+6, py+6, tileSize-12, tileSize-12, '#e27d60');
    drawHPBar(px, py-6, tileSize, m.hp, 10);
  }
  function draw2D() {
    if (!canvas2D) return;
    const { ox, oy } = getOffsets2D();
    ctx2D.clearRect(0,0,canvas2D.width, canvas2D.height);

    if (!ground || ground.length === 0) {
      const c1 = '#3a8f4a', c2 = '#56b35f';
      for (let y=0;y<rows;y++) for (let x=0;x<cols;x++)
        fillRect(ox + x*tileSize, oy + y*tileSize, tileSize, tileSize, ((x+y)%2)?c1:c2);
      ctx2D.fillStyle = '#fff'; ctx2D.font='20px monospace'; ctx2D.textAlign='center'; ctx2D.fillText('Carregando mapa...', canvas2D.width/2, canvas2D.height/2);
    } else {
      for (let y=0;y<rows;y++) for (let x=0;x<cols;x++){ const gid=ground[y*cols+x] ?? 2; drawTileXY(ox+x*tileSize, oy+y*tileSize, gid); }
    }
    // destination
    if (clickDest) { const mx=ox+clickDest.x*tileSize, my=oy+clickDest.y*tileSize; strokeRect(mx+2,my+2,tileSize-4,tileSize-4,'#f4d35e'); }
    // target highlight
    if (target) {
      const tEnt = (target.type==='mob') ? state.monsters.find(m=>m.id===target.id) : state.players.find(p=>p.id===target.id);
      if (tEnt) { const mx=ox+tEnt.x*tileSize, my=oy+tEnt.y*tileSize; strokeRect(mx+1,my+1,tileSize-2,tileSize-2,'#ff9f1c'); }
    }
    // items/mobs/players
    for (const it of state.items) { const px=ox+it.x*tileSize+10, py=oy+it.y*tileSize+10; fillRect(px, py, tileSize-20, tileSize-20, '#d6b38d'); }
    for (const m of state.monsters) drawMonster2D(m, ox, oy);
    for (const p of state.players) drawPlayer2D(p, ox, oy);
  }

  // 3D click handling (raycast tiles/entities)
  function screenToRay(ev) {
    const rect = renderer3D.domElement.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera({x, y}, camera);
  }
  function onClick3D(ev) {
    if (!is3D) return;
    screenToRay(ev);
    const hitsEnt = raycaster.intersectObjects(groupEntities.children, false);
    if (hitsEnt.length) {
      const obj = hitsEnt[0].object;
      const ud = obj.userData;
      if (ud.type === 'mob' || (ud.type === 'player' && ud.id !== myId)) {
        onTargetClick(ud.type, ud.id);
        return;
      }
    }
    const hits = raycaster.intersectObjects(groupTiles.children, false);
    if (hits.length) {
      const { x, y } = hits[0].object.userData;
      onTileClick(x, y);
    }
  }

  // 2D click handling
  function onClick2D(e){
    const rect = canvas2D.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left));
    const y = Math.floor((e.clientY - rect.top));
    const { ox, oy } = getOffsets2D();
    const tx = Math.floor((x - ox) / tileSize);
    const ty = Math.floor((y - oy) / tileSize);
    if (tx<0 || ty<0 || tx>=cols || ty>=rows) return;
    // entity priority: player then mob then tile
    const pClicked = state.players.find(p => p.x===tx && p.y===ty && p.id!==myId);
    if (pClicked) { onTargetClick('player', pClicked.id); return; }
    const mClicked = state.monsters.find(m => m.x===tx && m.y===ty);
    if (mClicked) { onTargetClick('mob', mClicked.id); return; }
    onTileClick(tx, ty);
  }

  // Actions
  function cancelActions(){ moveQueue.length=0; clickDest=null; target=null; autoLootPos=null; }
  function isWalkable(x,y){ return (x>=0 && y>=0 && x<cols && y<rows && (!coll || !coll[y] || coll[y][x]===0)); }
  function bfsPath(from, to){
    if (!isWalkable(to.x,to.y)) return null;
    const q=[]; const visited=new Set(); const key=(x,y)=>x+','+y; const prev = new Map();
    q.push(from); visited.add(key(from.x,from.y));
    const dirs = [{x:0,y:-1,dir:'up'},{x:1,y:0,dir:'right'},{x:0,y:1,dir:'down'},{x:-1,y:0,dir:'left'}];
    while(q.length){
      const cur=q.shift();
      if (cur.x===to.x && cur.y===to.y) break;
      for(const d of dirs){
        const nx=cur.x+d.x, ny=cur.y+d.y;
        const k=key(nx,ny);
        if (!visited.has(k) && isWalkable(nx,ny)){
          visited.add(k);
          prev.set(k, {x:cur.x, y:cur.y, dir:d.dir});
          q.push({x:nx,y:ny});
        }
      }
    }
    const endKey=key(to.x,to.y);
    if (!prev.has(endKey) && !(from.x===to.x && from.y===to.y)) return null;
    const steps=[]; let cx=to.x, cy=to.y, ck=endKey;
    while(!(cx===from.x && cy===from.y)){ const p = prev.get(ck); if (!p) break; steps.push(p.dir); cx=p.x; cy=p.y; ck=key(cx,cy); }
    steps.reverse(); return steps;
  }
  function manhattan(a,b){ return Math.abs(a.x-b.x)+Math.abs(a.y-b.y); }

  function onTileClick(tx,ty){
    target=null; autoLootPos=null;
    if (!isWalkable(tx,ty)) { setStatus('Destino bloqueado.', true); return; }
    const me = state.players.find(p=>p.id===myId); if (!me) return;
    const path = bfsPath({x:me.x,y:me.y}, {x:tx,y:ty});
    if (!path || path.length===0) { setStatus('Sem caminho.', true); return; }
    moveQueue = path.slice(0,400); clickDest = {x:tx,y:ty}; setStatus('Indo...');
    if (is3D && ringMarker) { ringMarker.visible=true; ringMarker.position.set(tx, 0.02, ty); }
  }
  function onTargetClick(kind, id){
    const me = state.players.find(p=>p.id===myId); if (!me) return;
    let targetEnt = (kind==='mob') ? state.monsters.find(m=>m.id===id) : state.players.find(p=>p.id===id);
    if (!targetEnt) return;
    target = { type: kind, id };
    autoLootPos = null;
    // path to adjacent tile
    const adj = [{x:targetEnt.x, y:targetEnt.y-1}, {x:targetEnt.x+1,y:targetEnt.y}, {x:targetEnt.x,y:targetEnt.y+1}, {x:targetEnt.x-1,y:targetEnt.y}].filter(p => isWalkable(p.x,p.y));
    if (adj.length===0) { setStatus('Sem adjacência livre.', true); return; }
    let bestPath=null, best=null;
    for (const a of adj) { const p=bfsPath({x:me.x,y:me.y}, a); if (p && (bestPath===null || p.length<bestPath.length)) { best=a; bestPath=p; } }
    if (!bestPath) { setStatus('Sem caminho ao alvo.', true); return; }
    moveQueue = bestPath.slice(0,400); clickDest = {x:best.x,y:best.y};
    setStatus(kind==='mob'?'Perseguindo monstro...':'Perseguindo jogador...');
    if (is3D && ringMarker && kind==='mob') { ringMarker.visible=true; ringMarker.position.set(targetEnt.x, 0.02, targetEnt.y); }
  }

  function pumpMoveQueue(){
    const now = performance.now();
    if (moveQueue.length === 0) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) { moveQueue.length=0; return; }
    if (now - lastMoveAt < 90) return;
    const dir = moveQueue.shift();
    ws.send(JSON.stringify({ type:'input', dir }));
    lastMoveAt = now;
  }
  setInterval(pumpMoveQueue, 30);

  function attackIfAdjacent(){
    if (!target) return;
    const me = state.players.find(p => p.id===myId); if (!me) return;
    const ent = (target.type==='mob') ? state.monsters.find(m => m.id===target.id) : state.players.find(p => p.id===target.id);
    if (!ent) return;
    if (manhattan(me, ent) <= 1) {
      const now = performance.now();
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (now - lastAttackAt < 330) return;
      ws.send(JSON.stringify({ type:'attack' }));
      lastAttackAt = now;
    }
  }
  setInterval(attackIfAdjacent, 60);

  function chaseTick(){
    if (!target) return;
    const me = state.players.find(p => p.id===myId); if (!me) return;
    const ent = (target.type==='mob') ? state.monsters.find(m => m.id===target.id) : state.players.find(p => p.id===target.id);
    if (!ent) {
      // If it was a mob, go loot last pos
      if (target.type==='mob' && lastTargetPos) {
        const path = bfsPath({x:me.x,y:me.y}, lastTargetPos);
        if (path && path.length) { moveQueue = path.slice(0,400); clickDest = {...lastTargetPos}; autoLootPos={...lastTargetPos}; }
      }
      target=null; return;
    }
    lastTargetPos = {x: ent.x, y: ent.y};
    if (manhattan(me, ent) <= 1) { moveQueue.length=0; clickDest={x:me.x,y:me.y}; return; }
    if (moveQueue.length===0) {
      const adj = [{x:ent.x, y:ent.y-1}, {x:ent.x+1,y:ent.y}, {x:ent.x,y:ent.y+1}, {x:ent.x-1,y:ent.y}].filter(p => isWalkable(p.x,p.y));
      let bestPath=null;
      for (const a of adj) { const p=bfsPath({x:me.x,y:me.y}, a); if (p && (bestPath===null || p.length<bestPath.length)) { bestPath=p; clickDest={x:a.x,y:a.y}; } }
      if (bestPath) moveQueue = bestPath.slice(0,400);
    }
  }
  setInterval(chaseTick, 100);

  function tryAutoPickup(){
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const me = state.players.find(p => p.id===myId); if (!me) return;
    if (autoLootPos && me.x===autoLootPos.x && me.y===autoLootPos.y) {
      ws.send(JSON.stringify({ type:'pickup' }));
      setTimeout(()=>{ autoLootPos=null; }, 250);
    }
    const itemHere = state.items.find(it => it.x===me.x && it.y===me.y);
    if (itemHere) ws.send(JSON.stringify({ type:'pickup' }));
  }
  setInterval(tryAutoPickup, 150);

  // Auth / UI
  function showGameUI(user) {
    inGame = true;
    authBox.style.display = 'none';
    hud.style.display = 'flex';
    ensureCanvas2D();
    who.textContent = (user && (user.email || user.id)) ? `Logado: ${user.email || user.id}` : 'Convidado';
    startDraw();
  }
  function showAuthUI() {
    inGame = false;
    authBox.style.display = 'flex';
    hud.style.display = 'none';
    disable3D(); // ensure back to 2D (cleans scene if any)
  }

  setTimeout(() => emailEl?.focus(), 0);

  async function getToken() { const { data } = await supabase.auth.getSession(); return data.session?.access_token || null; }

  async function signInEmailPassword() {
    try {
      setStatus('Fazendo login...');
      const email = emailEl.value.trim(); const password = passEl.value;
      if (!email || !password) return setStatus('Informe email e senha', true);
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return setStatus(error.message, true);
      if (displayNameEl.value.trim()) await supabase.auth.updateUser({ data: { name: displayNameEl.value.trim() } }).catch(()=>{});

      const { data: sdata } = await supabase.auth.getSession();
      const user = sdata?.session?.user || data?.user;
      if (!user) { setStatus('Login efetuado, mas a sessão não veio. Tente de novo.', true); return; }

      setStatus('Login OK.');
      showGameUI(user);
      connect();
    } catch (e) { setStatus('Falha no login: ' + e.message, true); }
  }

  async function signUpEmailPassword() {
    try {
      setStatus('Criando conta...');
      const email = emailEl.value.trim(); const password = passEl.value;
      if (!email || !password) return setStatus('Informe email e senha', true);
      const { error } = await supabase.auth.signUp({
        email, password, options: { data: { name: displayNameEl.value.trim() || '' } }
      });
      if (error) return setStatus(error.message, true);
      setStatus('Conta criada. Se houver confirmação de email, finalize e depois faça login.');
    } catch (e) { setStatus('Falha no signup: ' + e.message, true); }
  }

  function signInGuest() { setStatus('Entrando como convidado (sem salvar progresso)...'); showGameUI(null); connect(true); }

  async function signOut() {
    try { await supabase.auth.signOut(); } catch {} session=null;
    if (ws?.readyState === WebSocket.OPEN) try { ws.close(); } catch {};
    showAuthUI(); setStatus('Saiu da sessão.');
  }

  async function testConnection() {
    try {
      setStatus('Testando WebSocket do jogo...');
      if (is3D) setStatus('WS OK & Three.js ativo.');
      else setStatus('WS OK.');
    } catch(e) { setStatus('Teste WS falhou: ' + e.message, true); }
  }

  function resetUI() { showAuthUI(); setStatus('UI resetada.'); }

  signinBtn.addEventListener('click', signInEmailPassword);
  signupBtn.addEventListener('click', signUpEmailPassword);
  guestBtn.addEventListener('click', signInGuest);
  logoutBtn.addEventListener('click', signOut);
  testBtn.addEventListener('click', testConnection);
  resetBtn.addEventListener('click', resetUI);
  pvpBtn.addEventListener('click', () => {
    myPvP = !myPvP;
    pvpBtn.textContent = 'PvP: ' + (myPvP ? 'ON' : 'OFF');
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:'toggle_pvp', value: myPvP }));
  });
  modeBtn.addEventListener('click', async () => {
    if (!is3D) { await enable3D(); modeBtn.textContent = 'Modo: 3D'; }
    else { disable3D(); modeBtn.textContent = 'Modo: 2D'; }
  });

  (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      session = data.session || null;
      if (session?.user) { showGameUI(session.user); connect(); }
      supabase.auth.onAuthStateChange((_e, s) => {
        session = s?.session || null;
        if (session?.user) { showGameUI(session.user); connect(); }
        else { showAuthUI(); }
      });
    } catch { /* segue sem sessão */ }
  })();

  function getWsUrl() { const proto = location.protocol === 'https:' ? 'wss' : 'ws'; return `${proto}://${location.host}`; }

  function updateStats() {
    const me = state.players.find(p => p.id === myId);
    if (me && stats) stats.textContent = `Lv ${me.level} • HP ${me.hp}/${me.hpMax} • EXP ${me.exp} • Poções ${me.potions||0}`;
  }

  async function connect(guest=false) {
    const token = guest ? null : (await getToken());
    if (wsPingInterval) { clearInterval(wsPingInterval); wsPingInterval=null; }
    if (ws && ws.readyState === WebSocket.OPEN) { try { ws.close(); } catch {} }

    setStatus('Conectando ao servidor...');
    ws = new WebSocket(getWsUrl());
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'join', name: (displayNameEl.value || '').trim(), authToken: token || undefined }));
      wsPingInterval = setInterval(() => { if (ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify({ type:'ping', ts: Date.now() })); }, 2000);
      setStatus('Conectado. Carregando estado...');
    });
    ws.addEventListener('message', (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === 'error') { setStatus('Erro: ' + data.message, true); return; }
      if (data.type === 'pong') { /* ok */ }
      else if (data.type === 'init') {
        myId = data.id; cols=data.cols; rows=data.rows; tileSize=data.tileSize; pvpMode = data.pvpMode || 'optin';
        ground=data.render.ground || []; deco=data.render.deco || [];
        coll = data.map || [];
        state.players=data.state.players; state.monsters=data.state.monsters; state.items=data.state.items;
        updateStats();
        setStatus('Jogo carregado.');
        if (is3D) rebuildEntities3D(); // sync entities
      } else if (data.type === 'state') {
        // update last target pos
        if (target && target.type==='mob') {
          const mob = state.monsters.find(m => m.id===target.id);
          if (mob) lastTargetPos = {x: mob.x, y: mob.y};
        }
        state.players=data.players; state.monsters=data.monsters; state.items=data.items;
        updateStats();
        if (is3D) updateEntities3D();
      } else if (data.type === 'player_joined') {
        if (!state.players.find(p => p.id===data.player.id)) state.players.push(data.player);
        if (is3D) rebuildEntities3D();
      } else if (data.type === 'player_left') {
        const i = state.players.findIndex(p => p.id===data.id); if (i>=0) state.players.splice(i,1);
        if (is3D) rebuildEntities3D();
      } else if (data.type === 'pvp_update') {
        const p = state.players.find(pl => pl.id===data.id);
        if (p) p.pvp = !!data.pvp;
      }
    });
    ws.addEventListener('close', () => { if (wsPingInterval) { clearInterval(wsPingInterval); wsPingInterval=null; } myId=null; setStatus('Desconectado do servidor.', true); });
    ws.addEventListener('error', (e) => { setStatus('WebSocket erro: '+e.message, true); });
  }

  // main draw loop
  let drawing = false;
  function startDraw() { if (drawing) return; drawing = true; requestAnimationFrame(drawFrame); }
  function drawFrame() {
    try {
      if (!drawing) return;
      if (is3D && renderer3D && scene && camera) {
        renderer3D.render(scene, camera);
        // position ring marker to clickDest (if not targeting mob)
        if (ringMarker && clickDest && (!target || target.type!=='mob')) {
          ringMarker.visible = true;
          ringMarker.position.set(clickDest.x, 0.02, clickDest.y);
        }
      } else {
        ensureCanvas2D();
        draw2D();
      }
    } catch (e) { setStatus('Render erro: ' + e.message, true); }
    finally { requestAnimationFrame(drawFrame); }
  }

  // keyboard
  window.addEventListener('keydown', (e) => {
    if (!inGame) return;
    if (isTyping()) return;
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    switch (e.key) {
      case 'w': case 'W': case 'ArrowUp': moveQueue.length=0; target=null; autoLootPos=null; ws.send(JSON.stringify({ type:'input', dir:'up' })); break;
      case 's': case 'S': case 'ArrowDown': moveQueue.length=0; target=null; autoLootPos=null; ws.send(JSON.stringify({ type:'input', dir:'down' })); break;
      case 'a': case 'A': case 'ArrowLeft': moveQueue.length=0; target=null; autoLootPos=null; ws.send(JSON.stringify({ type:'input', dir:'left' })); break;
      case 'd': case 'D': case 'ArrowRight': moveQueue.length=0; target=null; autoLootPos=null; ws.send(JSON.stringify({ type:'input', dir:'right' })); break;
      case ' ': ws.send(JSON.stringify({ type:'attack' })); break;
      case 'e': case 'E': ws.send(JSON.stringify({ type:'pickup' })); break;
      case 'q': case 'Q': ws.send(JSON.stringify({ type:'use', item:'potion' })); break;
      case '1': myPvP = !myPvP; pvpBtn.textContent = 'PvP: ' + (myPvP ? 'ON' : 'OFF'); if (ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify({ type:'toggle_pvp', value: myPvP })); break;
      case '2': if (!is3D) enable3D().then(()=>{ modeBtn.textContent='Modo: 3D'; }); else { disable3D(); modeBtn.textContent='Modo: 2D'; } break;
    }
  });
})();
