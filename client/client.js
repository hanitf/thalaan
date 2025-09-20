import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://yqjevqvjpjspcquqwqvo.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlxamV2cXZqcGpzcGNxdXF3cXZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgxNTAyNDEsImV4cCI6MjA3MzcyNjI0MX0.yv0w-JvXEF4U3XgIoohB2zl8Awv-waRVHPpdnzWGZvg";

(() => {
  let inGame = false;
  let canvas = null, ctx = null;

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
  const stage = document.getElementById('stage');

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

  let session = null, ws = null, wsPingInterval = null;
  let myId = null, cols = 30, rows = 20, tileSize = 32;
  let ground = [], deco = [], coll = []; // 2D 0/1
  const state = { players: [], monsters: [], items: [] };

  // click-to-move + combat
  let moveQueue = [];
  let lastMoveAt = 0;
  let clickDest = null;
  let autoAttackTarget = null; // monster id
  let lastAttackAt = 0;

  function setStatus(msg, isError=false) { statusEl.textContent = msg; statusEl.classList.toggle('error', !!isError); }
  const isTyping = () => ['INPUT','TEXTAREA'].includes(document.activeElement?.tagName);

  function ensureCanvas() {
    const newlyCreated = !canvas;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = 960; canvas.height = 640;
      canvas.style.background = '#243148';
      canvas.style.border = '2px solid #2e3448';
      canvas.style.borderRadius = '8px';
      canvas.style.imageRendering = 'pixelated';
      stage.innerHTML = ''; stage.appendChild(canvas);
      ctx = canvas.getContext('2d');
    } else if (!ctx) {
      ctx = canvas.getContext('2d');
    }
    if (newlyCreated) {
      canvas.addEventListener('click', onCanvasClick);
      canvas.addEventListener('contextmenu', (e)=>{ e.preventDefault(); moveQueue.length=0; clickDest=null; autoAttackTarget=null; });
    }
  }
  function destroyCanvas() { if (canvas?.parentNode) canvas.parentNode.removeChild(canvas); canvas=null; ctx=null; }

  function showGameUI(user) {
    inGame = true;
    authBox.style.display = 'none';
    hud.style.display = 'flex';
    ensureCanvas();
    who.textContent = (user && (user.email || user.id)) ? `Logado: ${user.email || user.id}` : 'Convidado';
    startDraw();
  }
  function showAuthUI() {
    inGame = false;
    authBox.style.display = 'flex';
    hud.style.display = 'none';
    destroyCanvas();
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
      const test = new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host);
      await new Promise((resolve,reject)=>{ test.onopen=resolve; test.onerror=reject; setTimeout(()=>reject(new Error('timeout')), 2000); });
      test.close();
      setStatus('WS OK. Supabase é testado no Login/Signup.');
    } catch(e) { setStatus('Teste WS falhou: ' + e.message, true); }
  }

  function resetUI() { showAuthUI(); setStatus('UI resetada.'); }

  signinBtn.addEventListener('click', signInEmailPassword);
  signupBtn.addEventListener('click', signUpEmailPassword);
  guestBtn.addEventListener('click', signInGuest);
  logoutBtn.addEventListener('click', signOut);
  testBtn.addEventListener('click', testConnection);
  resetBtn.addEventListener('click', resetUI);

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
        myId = data.id; cols=data.cols; rows=data.rows; tileSize=data.tileSize;
        ground=data.render.ground || []; deco=data.render.deco || [];
        coll = data.map || [];
        state.players=data.state.players; state.monsters=data.state.monsters; state.items=data.state.items;
        updateStats();
        setStatus('Jogo carregado.');
      } else if (data.type === 'state') {
        state.players=data.players; state.monsters=data.monsters; state.items=data.items;
        // re-path if chasing a moving target and not adjacent
        if (autoAttackTarget) autoChaseTick();
        updateStats();
      } else if (data.type === 'player_joined') {
        if (!state.players.find(p => p.id===data.player.id)) state.players.push(data.player);
      } else if (data.type === 'player_left') {
        const i = state.players.findIndex(p => p.id===data.id); if (i>=0) state.players.splice(i,1);
      }
    });
    ws.addEventListener('close', () => { if (wsPingInterval) { clearInterval(wsPingInterval); wsPingInterval=null; } myId=null; setStatus('Desconectado do servidor.', true); });
    ws.addEventListener('error', (e) => { setStatus('WebSocket erro: '+e.message, true); });
  }

  // ------- Pathfinding helpers -------
  function isWalkable(x,y){ return (x>=0 && y>=0 && x<cols && y<rows && (!coll || !coll[y] || coll[y][x]===0)); }
  function bfsPath(from, to){
    if (!isWalkable(to.x,to.y)) return null;
    const q=[]; const visited=new Set(); const key=(x,y)=>x+','+y;
    const prev = new Map();
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
    const endKey = key(to.x,to.y);
    if (!prev.has(endKey) && !(from.x===to.x && from.y===to.y)) return null;
    const steps=[];
    let cx=to.x, cy=to.y, ck=endKey;
    while(!(cx===from.x && cy===from.y)){
      const p = prev.get(ck);
      if (!p) break;
      steps.push(p.dir);
      cx=p.x; cy=p.y; ck=key(cx,cy);
    }
    steps.reverse();
    return steps;
  }
  function manhattan(a,b){ return Math.abs(a.x-b.x)+Math.abs(a.y-b.y); }

  // click handling
  function onCanvasClick(e){
    if (!inGame || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = Math.floor((e.clientX - rect.left));
    const py = Math.floor((e.clientY - rect.top));
    const mapW = cols*tileSize, mapH = rows*tileSize;
    const ox = Math.floor((canvas.width - mapW) / 2), oy = Math.floor((canvas.height - mapH) / 2);
    const tx = Math.floor((px - ox) / tileSize);
    const ty = Math.floor((py - oy) / tileSize);
    if (tx<0 || ty<0 || tx>=cols || ty>=rows) return;

    const me = state.players.find(p => p.id === myId);
    if (!me) return;

    // Did we click a monster?
    let target = state.monsters.find(m => m.x===tx && m.y===ty);
    if (target) {
      // Set auto-chase + attack
      autoAttackTarget = target.id;
      // Compute nearest adjacent tile
      const adj = [{x:target.x, y:target.y-1}, {x:target.x+1,y:target.y}, {x:target.x,y:target.y+1}, {x:target.x-1,y:target.y}].filter(p => isWalkable(p.x,p.y));
      if (adj.length===0) { setStatus('Sem posição adjacente livre.', true); return; }
      // Choose shortest path among adjacents
      let best=null, bestPath=null;
      for (const a of adj) { const path=bfsPath({x:me.x,y:me.y}, a); if (path && (bestPath===null || path.length < bestPath.length)) { best=a; bestPath=path; } }
      if (!bestPath) { setStatus('Sem caminho até o alvo.', true); return; }
      moveQueue = bestPath.slice(0,400);
      clickDest = {x:best.x,y:best.y};
      setStatus('Perseguindo o alvo...');
      return;
    }

    // Otherwise, normal move
    autoAttackTarget = null;
    if (!isWalkable(tx,ty)) { setStatus('Destino bloqueado.', true); return; }
    const path = bfsPath({x:me.x,y:me.y}, {x:tx,y:ty});
    if (!path || path.length===0) { setStatus('Sem caminho até o destino.', true); return; }
    moveQueue = path.slice(0,400);
    clickDest = {x:tx,y:ty};
    setStatus('Indo até o destino...');
  }

  function pumpMoveQueue(){
    const now = performance.now();
    if (moveQueue.length === 0) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) { moveQueue.length=0; return; }
    if (now - lastMoveAt < 90) return; // throttle
    const dir = moveQueue.shift();
    ws.send(JSON.stringify({ type:'input', dir }));
    lastMoveAt = now;
  }
  setInterval(pumpMoveQueue, 30);

  function attackIfAdjacent(){
    if (!autoAttackTarget) return;
    const me = state.players.find(p => p.id===myId); if (!me) return;
    const mob = state.monsters.find(m => m.id===autoAttackTarget);
    if (!mob) { autoAttackTarget=null; setStatus('Alvo abatido ou sumiu.'); return; }
    if (manhattan(me, mob) <= 1) {
      const now = performance.now();
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (now - lastAttackAt < 330) return; // cooldown client-side (server 300ms)
      ws.send(JSON.stringify({ type:'attack' }));
      lastAttackAt = now;
      // we keep standing here attacking; picking up handled by user
    }
  }
  setInterval(attackIfAdjacent, 60);

  function autoChaseTick(){
    if (!autoAttackTarget) return;
    const me = state.players.find(p => p.id===myId); if (!me) return;
    const mob = state.monsters.find(m => m.id===autoAttackTarget);
    if (!mob) { autoAttackTarget=null; return; }
    // If already adjacent, don't move; attack loop handles damage
    if (manhattan(me, mob) <= 1) { moveQueue.length=0; clickDest = {x:me.x, y:me.y}; return; }
    // If not adjacent and not currently walking, re-path
    if (moveQueue.length===0) {
      const adj = [{x:mob.x, y:mob.y-1}, {x:mob.x+1,y:mob.y}, {x:mob.x,y:mob.y+1}, {x:mob.x-1,y:mob.y}].filter(p => isWalkable(p.x,p.y));
      let bestPath=null;
      for (const a of adj) { const path=bfsPath({x:me.x,y:me.y}, a); if (path && (bestPath===null || path.length < bestPath.length)) { bestPath=path; clickDest = {x:a.x,y:a.y}; } }
      if (bestPath) moveQueue = bestPath.slice(0,400);
    }
  }

  // ------- Renderer (same look as 0.4.9) -------
  function fillRect(x,y,w,h,c){ ctx.fillStyle = c; ctx.fillRect(x,y,w,h); }
  function strokeRect(x,y,w,h,c){ ctx.strokeStyle=c; ctx.lineWidth=1; ctx.strokeRect(x+0.5,y+0.5,w-1,h-1); }
  function fillCircle(x,y,r,c){ ctx.fillStyle=c; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); }
  function strokeCircle(x,y,r,c){ ctx.strokeStyle=c; ctx.lineWidth=1; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.stroke(); }
  function drawTileXY(px, py, gid) {
    if (gid === 2 || gid === undefined) { fillRect(px, py, tileSize, tileSize, '#3a8f4a'); for (let i=0;i<6;i++) { const nx = px + 4 + (i*5 % (tileSize-8)); const ny = py + (i*7 % (tileSize-8)); fillRect(nx, ny, 2, 2, '#2f7a3d'); } fillRect(px, py, tileSize, 2, '#56b35f'); }
    else if (gid === 6) { fillRect(px, py, tileSize, tileSize, '#c9a36a'); for (let i=2;i<tileSize;i+=4) fillRect(px, py+i, tileSize, 1, '#b38c52'); fillRect(px, py, tileSize, 1, '#e5c694'); fillRect(px, py+tileSize-1, tileSize, 1, '#8f6c3f'); }
    else if (gid === 5) { fillRect(px, py, tileSize, tileSize, '#6d6e71'); for (let i=4;i<tileSize;i+=8) fillRect(px, py+i, tileSize, 2, '#58595b'); strokeRect(px+1, py+1, tileSize-2, tileSize-2, '#414244'); }
    else if (gid === 7) { fillRect(px, py, tileSize, tileSize, '#2b6cb3'); for (let i=0;i<tileSize;i+=4) fillRect(px+i, py+((i/4)%2?6:4), 3, 2, '#7fb3ff'); }
    else { fillRect(px, py, tileSize, tileSize, '#7a7a7a'); }
  }
  function drawDecoXY(px, py, gid) {
    if (gid === 4) { fillRect(px + tileSize/2 - 3, py + 8, 6, tileSize-12, '#5b3a1d'); fillCircle(px + tileSize/2, py + 8, 10, '#2f7a3d'); strokeCircle(px + tileSize/2, py + 8, 10, '#1f5128'); }
    else if (gid === 3) { fillRect(px+8, py+10, tileSize-16, tileSize-14, '#8d8f94'); strokeRect(px+8, py+10, tileSize-16, tileSize-14, '#5c5e63'); }
  }
  function drawHPBar(cx, cy, w, hp, hpMax) {
    const ratio = Math.max(0, Math.min(1, hp / Math.max(1, hpMax)));
    fillRect(cx, cy, w, 4, '#1a1f2b');
    fillRect(cx, cy, Math.floor(w*ratio), 4, '#86e3b4');
    strokeRect(cx, cy, w, 4, '#2e354a');
  }
  function drawPlayer(p, ox, oy) {
    const px = ox + p.x*tileSize, py = oy + p.y*tileSize;
    fillRect(px+6, py+tileSize-8, tileSize-12, 4, 'rgba(0,0,0,0.25)');
    fillRect(px+8, py+8, tileSize-16, tileSize-14, '#b79c6d');
    fillRect(px+10, py+4, tileSize-20, 6, '#cfcfd6');
    strokeRect(px+10, py+4, tileSize-20, 6, '#8f9096');
    fillRect(px+8, py+18, tileSize-16, 3, '#4b2e1b');
    fillRect(px+tileSize-10, py+12, 6, 10, '#8b5e34');
    fillRect(px+4, py+12, 2, 10, '#cfcfd6');
    drawHPBar(px, py-6, tileSize, p.hp, p.hpMax);
    ctx.fillStyle = '#e6eefc'; ctx.font = '12px monospace'; ctx.textAlign = 'center';
    ctx.fillText(p.name || 'Player', px + tileSize/2, py - 10);
  }
  function drawMonster(m, ox, oy) {
    const px = ox + m.x*tileSize, py = oy + m.y*tileSize;
    const kind = (m.id && (m.id.charCodeAt(0)%2===0)) ? 'slime' : 'goblin';
    if (kind === 'slime') { fillRect(px+5, py+8, tileSize-10, tileSize-10, '#2fd06c'); fillRect(px+8, py+12, 3, 3, '#163a24'); fillRect(px+tileSize-11, py+12, 3, 3, '#163a24'); }
    else { fillRect(px+6, py+6, tileSize-12, tileSize-12, '#3f7a2f'); fillRect(px+4, py+10, 4, 4, '#3f7a2f'); fillRect(px+tileSize-8, py+10, 4, 4, '#3f7a2f'); fillRect(px+10, py+10, tileSize-20, 4, '#1a1f2b'); }
    drawHPBar(px, py-6, tileSize, m.hp, 10);
  }

  // draw loop
  let drawing = false;
  function startDraw() { if (drawing) return; drawing = true; requestAnimationFrame(draw); }
  function draw() {
    try {
      if (!drawing) return;
      ensureCanvas();
      if (!ctx) return;
      const viewW = canvas.width, viewH = canvas.height;
      const mapW = cols * tileSize, mapH = rows * tileSize;
      const ox = Math.floor((viewW - mapW) / 2), oy = Math.floor((viewH - mapH) / 2);
      ctx.clearRect(0, 0, viewW, viewH);

      if (!ground || ground.length === 0) {
        const c1 = '#3a8f4a', c2 = '#56b35f';
        for (let y=0;y<rows;y++) for (let x=0;x<cols;x++) {
          fillRect(ox + x*tileSize, oy + y*tileSize, tileSize, tileSize, ((x+y)%2)?c1:c2);
        }
        ctx.fillStyle = '#ffffff'; ctx.font = '20px monospace'; ctx.textAlign='center';
        ctx.fillText('Carregando mapa...', viewW/2, viewH/2);
      } else {
        for (let y = 0; y < rows; y++)
          for (let x = 0; x < cols; x++) {
            const gid = ground[y*cols + x] ?? 2;
            drawTileXY(ox + x*tileSize, oy + y*tileSize, gid);
          }
        if (deco && deco.length) {
          for (let y = 0; y < rows; y++)
            for (let x = 0; x < cols; x++) {
              const gid = deco[y*cols + x] || 0; if (!gid) continue;
              drawDecoXY(ox + x*tileSize, oy + y*tileSize, gid);
            }
        }
      }

      // target marker
      if (clickDest) {
        const mx = ox + clickDest.x*tileSize, my = oy + clickDest.y*tileSize;
        strokeRect(mx+2, my+2, tileSize-4, tileSize-4, '#f4d35e');
      }
      if (autoAttackTarget) {
        const mob = state.monsters.find(m => m.id===autoAttackTarget);
        if (mob) {
          const mx = ox + mob.x*tileSize, my = oy + mob.y*tileSize;
          strokeRect(mx+1, my+1, tileSize-2, tileSize-2, '#ff9f1c');
        }
      }

      for (const it of state.items) {
        const px = ox + it.x*tileSize + 10, py = oy + it.y*tileSize + 10;
        fillRect(px, py, tileSize-20, tileSize-20, '#d6b38d');
        strokeRect(px, py, tileSize-20, tileSize-20, '#8b5e34');
      }
      for (const m of state.monsters) drawMonster(m, ox, oy);
      for (const p of state.players) drawPlayer(p, ox, oy);
    } catch (e) {
      setStatus('Render erro: ' + e.message, true);
    } finally {
      requestAnimationFrame(draw);
    }
  }

  // keyboard overrides movement path
  window.addEventListener('keydown', (e) => {
    if (!inGame) return;
    if (isTyping()) return;
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    switch (e.key) {
      case 'w': case 'W': case 'ArrowUp': moveQueue.length=0; autoAttackTarget=null; ws.send(JSON.stringify({ type:'input', dir:'up' })); break;
      case 's': case 'S': case 'ArrowDown': moveQueue.length=0; autoAttackTarget=null; ws.send(JSON.stringify({ type:'input', dir:'down' })); break;
      case 'a': case 'A': case 'ArrowLeft': moveQueue.length=0; autoAttackTarget=null; ws.send(JSON.stringify({ type:'input', dir:'left' })); break;
      case 'd': case 'D': case 'ArrowRight': moveQueue.length=0; autoAttackTarget=null; ws.send(JSON.stringify({ type:'input', dir:'right' })); break;
      case ' ': ws.send(JSON.stringify({ type:'attack' })); break;
      case 'e': case 'E': ws.send(JSON.stringify({ type:'pickup' })); break;
      case 'q': case 'Q': ws.send(JSON.stringify({ type:'use', item:'potion' })); break;
    }
  });
})();
