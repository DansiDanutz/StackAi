/**
 * Stack Ai OS — Dashboard SPA (single-file HTML/CSS/JS).
 *
 * Exported as a string and served at GET / by the web server. No build step —
 * vanilla JS polling the REST API + WebSocket for live run events.
 *
 * Tabs: Fleet · Models · Runs · Tailnet · Live
 */
export const dashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stack Ai OS</title>
<style>
  :root {
    --bg:#0a0e14; --panel:#11161f; --panel2:#161c28; --border:#1f2937;
    --text:#e5e7eb; --dim:#6b7280; --accent:#60a5fa; --green:#34d399;
    --yellow:#fbbf24; --red:#f87171; --purple:#a78bfa; --cyan:#22d3ee;
  }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; min-height:100vh; }
  header { display:flex; align-items:center; gap:16px; padding:14px 24px; border-bottom:1px solid var(--border); background:var(--panel); position:sticky; top:0; z-index:10; }
  header h1 { font-size:18px; font-weight:600; }
  header h1 span { color:var(--accent); }
  .status-dot { width:8px; height:8px; border-radius:50%; background:var(--green); box-shadow:0 0 8px var(--green); }
  .status-dot.off { background:var(--red); box-shadow:0 0 8px var(--red); }
  nav { display:flex; gap:4px; margin-left:auto; }
  nav button { background:none; border:1px solid transparent; color:var(--dim); padding:6px 14px; border-radius:6px; cursor:pointer; font-size:13px; }
  nav button:hover { color:var(--text); background:var(--panel2); }
  nav button.active { color:var(--accent); border-color:var(--accent); }
  main { max-width:1400px; margin:0 auto; padding:24px; }
  .tab { display:none; }
  .tab.active { display:block; }
  .grid { display:grid; gap:16px; }
  .cards { grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:16px; }
  .card h3 { font-size:13px; color:var(--dim); text-transform:uppercase; letter-spacing:.5px; margin-bottom:8px; }
  .card .big { font-size:28px; font-weight:600; }
  .card .big.accent { color:var(--accent); }
  .card .big.green { color:var(--green); }
  table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
  th,td { text-align:left; padding:10px 14px; border-bottom:1px solid var(--border); font-size:13px; }
  th { background:var(--panel2); color:var(--dim); font-weight:500; text-transform:uppercase; font-size:11px; letter-spacing:.5px; }
  tr:last-child td { border-bottom:none; }
  tr:hover td { background:var(--panel2); }
  .badge { display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:500; }
  .badge.green { background:rgba(52,211,153,.15); color:var(--green); }
  .badge.yellow { background:rgba(251,191,36,.15); color:var(--yellow); }
  .badge.red { background:rgba(248,113,113,.15); color:var(--red); }
  .badge.blue { background:rgba(96,165,250,.15); color:var(--accent); }
  .badge.purple { background:rgba(167,139,250,.15); color:var(--purple); }
  .badge.dim { background:var(--panel2); color:var(--dim); }
  .caps { display:flex; flex-wrap:wrap; gap:4px; }
  .mono { font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:12px; color:var(--cyan); }
  .row { display:flex; align-items:center; gap:8px; }
  .live { background:#000; border:1px solid var(--border); border-radius:10px; padding:14px; font-family:ui-monospace,monospace; font-size:12px; color:var(--green); height:420px; overflow-y:auto; }
  .live .line { white-space:pre-wrap; word-break:break-word; }
  .live .err { color:var(--red); } .live .dim { color:var(--dim); } .live .warn { color:var(--yellow); }
  .empty { color:var(--dim); padding:40px; text-align:center; }
  a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
  .footer { color:var(--dim); font-size:12px; text-align:center; padding:24px; border-top:1px solid var(--border); margin-top:24px; }
  .score-bar { display:inline-block; width:48px; height:6px; background:var(--panel2); border-radius:3px; overflow:hidden; vertical-align:middle; }
  .score-fill { height:100%; background:linear-gradient(90deg,var(--red),var(--yellow),var(--green)); }
  /* Compose box — the task entry point */
  .compose { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:16px; margin-bottom:20px; }
  .compose label { display:block; font-size:11px; color:var(--dim); text-transform:uppercase; letter-spacing:.5px; margin-bottom:6px; }
  .compose textarea { width:100%; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:12px; font:14px/1.5 -apple-system,sans-serif; resize:vertical; min-height:72px; }
  .compose textarea:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(96,165,250,.15); }
  .compose .controls { display:flex; gap:10px; align-items:flex-end; margin-top:10px; flex-wrap:wrap; }
  .compose .field { flex:1; min-width:200px; }
  .compose select { background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:9px 10px; font:13px -apple-system,sans-serif; width:100%; }
  .compose button.run { background:var(--accent); color:#0a0e14; border:none; border-radius:8px; padding:10px 22px; font-weight:600; font-size:14px; cursor:pointer; }
  .compose button.run:hover { filter:brightness(1.1); }
  .compose button.run:disabled { opacity:.5; cursor:not-allowed; }
  .compose button.attach { background:transparent; color:var(--text); border:1px solid var(--border); border-radius:8px; padding:9px 16px; font-size:14px; cursor:pointer; display:inline-flex; align-items:center; gap:6px; }
  .compose button.attach:hover { border-color:var(--accent); color:var(--accent); }
  .compose .hint { font-size:12px; color:var(--dim); margin-top:8px; }
  /* Attachments — drag-drop zone + file chips */
  .compose.drag-over { border-color:var(--accent); box-shadow:0 0 0 3px rgba(96,165,250,.2); }
  .drop-hint { font-size:12px; color:var(--dim); margin-top:6px; }
  .drop-hint a { color:var(--accent); cursor:pointer; text-decoration:underline; }
  .attach-chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; min-height:0; }
  .attach-chips:empty { display:none; }
  .chip { display:inline-flex; align-items:center; gap:6px; background:var(--panel2); border:1px solid var(--border); border-radius:6px; padding:4px 8px; font-size:12px; max-width:240px; }
  .chip img { width:20px; height:20px; border-radius:3px; object-fit:cover; }
  .chip .chip-icon { font-size:14px; }
  .chip .chip-name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .chip .chip-x { cursor:pointer; color:var(--dim); font-size:14px; line-height:1; padding:0 2px; }
  .chip .chip-x:hover { color:var(--red); }
  .chip.uploading { opacity:.6; }
  .chip.uploading .chip-x { color:var(--yellow); animation:pulse 1s infinite; }
  @keyframes pulse { 50% { opacity:.4; } }
  /* Clarify cards — interactive questions when a task is ambiguous */
  .clarify-card { background:var(--panel2); border:1px solid var(--border); border-left:3px solid var(--purple); border-radius:8px; padding:14px; margin:10px 0; }
  .clarify-card .cq-header { font-size:11px; color:var(--purple); text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px; }
  .clarify-card .cq-question { font-weight:600; margin-bottom:10px; }
  .clarify-card .cq-options { display:flex; flex-direction:column; gap:6px; }
  .clarify-card .cq-opt { background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:9px 12px; cursor:pointer; font-size:13px; transition:border-color .15s; }
  .clarify-card .cq-opt:hover { border-color:var(--accent); }
  .clarify-card .cq-opt.selected { border-color:var(--accent); background:rgba(96,165,250,.1); }
  .clarify-card .cq-opt .cq-rec { font-size:10px; color:var(--green); margin-left:6px; }
  .clarify-card .cq-opt .cq-desc { display:block; color:var(--dim); font-size:11px; margin-top:2px; }
  .clarify-card.locked .cq-opt { cursor:default; opacity:.7; }
  .clarify-submit { background:var(--purple); color:#0a0e14; border:none; border-radius:8px; padding:10px 20px; font-weight:600; cursor:pointer; margin-top:12px; }
  .clarify-submit:hover { filter:brightness(1.1); }
  .clarify-submit:disabled { opacity:.4; cursor:not-allowed; }
  /* Result panel — the delivered output, front and center */
  .result-panel { background:var(--panel); border:1px solid var(--accent); border-radius:10px; margin-top:16px; overflow:hidden; }
  .result-panel .rp-head { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; background:rgba(96,165,250,.08); border-bottom:1px solid var(--border); }
  .result-panel .rp-title { font-weight:600; display:flex; align-items:center; gap:8px; }
  .result-panel .rp-actions { display:flex; gap:8px; }
  .result-panel .rp-btn { background:var(--panel2); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:6px 12px; font-size:12px; cursor:pointer; }
  .result-panel .rp-btn:hover { border-color:var(--accent); color:var(--accent); }
  .result-panel .rp-body { padding:16px; max-height:420px; overflow-y:auto; }
  .result-panel .rp-code { font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:13px; white-space:pre-wrap; word-break:break-word; color:var(--green); line-height:1.6; }
  .result-panel .rp-meta { font-size:11px; color:var(--dim); margin-top:8px; }
</style>
</head>
<body>
<header>
  <div class="status-dot" id="dot"></div>
  <h1>Stack <span>Ai OS</span></h1>
  <span class="mono" id="url"></span>
  <nav>
    <button data-tab="overview" class="active">Overview</button>
    <button data-tab="fleet">Fleet</button>
    <button data-tab="models">Models</button>
    <button data-tab="runs">Runs</button>
    <button data-tab="conversation">Conversation</button>
    <button data-tab="stats">Stats</button>
    <button data-tab="config">Config</button>
    <button data-tab="tailnet">Tailnet</button>
    <button data-tab="live">Live</button>
  </nav>
</header>
<main>
  <!-- COMPOSE — where you write the task -->
  <div class="compose" id="compose-box">
    <label for="task-input">New task</label>
    <textarea id="task-input" placeholder="Describe what you want built or answered…  (e.g. "write a Python is_prime function with tests")"></textarea>
    <div class="attach-chips" id="attach-chips"></div>
    <div class="controls">
      <div class="field">
        <label for="task-agents">Agents (optional team)</label>
        <select id="task-agents"><option value="">default team (auto)</option></select>
      </div>
      <div class="field" style="max-width:160px">
        <label for="task-engine">Engine</label>
        <select id="task-engine">
          <option value="gsd" selected>GSD (clarify + structure)</option>
          <option value="fast">Fast (immediate)</option>
        </select>
      </div>
      <input type="file" id="file-input" multiple style="display:none">
      <button class="attach" id="attach-btn" title="Attach files or images">📎 Attach</button>
      <button class="run" id="task-run">Run task ▸</button>
    </div>
    <div class="hint" id="task-hint">Press <b>⌘↵</b> to run, or click <b>📎 Attach</b> to add files/images. The task runs through 6 phases (Planning → Delivered) — watch it live in the <b>Conversation</b> tab.</div>
  </div>

  <!-- OVERVIEW -->
  <section class="tab active" id="overview">
    <div class="grid cards" id="stats"></div>
    <h2 style="margin:24px 0 12px;font-size:15px;color:var(--dim);">Recent Activity</h2>
    <div id="recent-runs"></div>
  </section>
  <!-- FLEET -->
  <section class="tab" id="fleet"><div id="fleet-table"></div></section>
  <!-- MODELS -->
  <section class="tab" id="models"><div id="models-table"></div></section>
  <!-- RUNS -->
  <section class="tab" id="runs"><div id="runs-table"></div></section>
  <!-- CONVERSATION -->
  <section class="tab" id="conversation">
    <div id="phase-bar" style="display:flex;gap:6px;margin-bottom:12px"></div>
    <div id="conv-status" style="display:none;align-items:center;gap:8px;margin-bottom:12px;padding:10px 14px;background:var(--panel);border:1px solid var(--border);border-radius:8px"></div>
    <div id="clarify-area"></div>
    <div id="result-panel"></div>
    <div id="conv-transcript" style="background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px;height:380px;overflow-y:auto;margin-top:12px"></div>
  </section>
  <!-- STATS -->
  <section class="tab" id="stats"><div id="stats-content"></div></section>
  <!-- CONFIG -->
  <section class="tab" id="config"><div id="config-content"></div></section>
  <!-- TAILNET -->
  <section class="tab" id="tailnet"><div id="tailnet-table"></div></section>
  <!-- LIVE -->
  <section class="tab" id="live">
    <div class="live" id="live-log"><div class="line dim">// live event stream — run a task with \`stackai run\` to see events flow</div></div>
  </section>
</main>
<div class="footer">Stack Ai OS · multi-CLI orchestration · <span id="ts-port"></span></div>

<script>
const API = window.location.origin;
const $ = (id) => document.getElementById(id);
const cap = (c) => Object.entries(c).filter(([k,v])=>v&&k!=='acpServer'&&k!=='jsonStream').map(([k])=>k.replace('mcp','MCP').replace('Selection','').replace('Resume',''));
async function get(path){ const r=await fetch(API+path); return r.json(); }
function esc(s){ return String(s??'').replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m])); }

// tabs
document.querySelectorAll('nav button').forEach(b=>{
  b.onclick=()=>{ document.querySelectorAll('nav button').forEach(x=>x.classList.remove('active')); b.classList.add('active');
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active')); $(b.dataset.tab).classList.add('active');
    if(b.dataset.tab==='runs')loadRuns(); if(b.dataset.tab==='tailnet')loadTailnet();
    if(b.dataset.tab==='stats')loadStats(); if(b.dataset.tab==='config')loadConfig(); };
});

async function loadOverview(){
  try{
    const [health,fleet,runs] = await Promise.all([get('/api/health'),get('/api/fleet'),get('/api/runs')]);
    $('dot').classList.toggle('off',!health.ok);
    const n = fleet.fleet?.length ?? 0;
    const done = (runs.runs??[]).filter(r=>r.status==='done').length;
    const spent = (runs.runs??[]).reduce((s,r)=>s+(r.spentUsd||0),0);
    $('stats').innerHTML = [
      card('Agents in fleet', n, 'accent'),
      card('Runs total', runs.runs?.length ?? 0, 'green'),
      card('Completed', done, 'green'),
      card('Total spend', '$'+spent.toFixed(3), ''),
    ].join('');
    $('url').textContent = health.ok?'connected':'offline';
    // recent runs (top 5)
    const top = (runs.runs??[]).slice(0,5);
    $('recent-runs').innerHTML = top.length ? runsTable(top) : '<div class="empty">No runs yet. Start one: <code>stackai run "task" --pattern ensemble</code></div>';
  }catch(e){ $('dot').classList.add('off'); $('stats').innerHTML='<div class="empty">Dashboard API unreachable.</div>'; }
}
function card(label,val,cls){ return \`<div class="card"><h3>\${label}</h3><div class="big \${cls}">\${val}</div></div>\`; }

async function loadFleet(){
  const f = await get('/api/fleet');
  const rows = (f.fleet??[]).map(a=>{
    const caps = ['modelSelection','jsonStream','mcpClient','mcpServer','acpServer','fullAuto','sessionResume'];
    const tags = caps.filter(k=>a.capabilities[k]).map(k=>{
      const map={modelSelection:'model',jsonStream:'json',mcpClient:'mcp-c',mcpServer:'mcp-s',acpServer:'acp',fullAuto:'auto',sessionResume:'resume'};
      return \`<span class="badge blue">\${map[k]}</span>\`;
    }).join('');
    return \`<tr><td><b>\${esc(a.displayName)}</b> \${a.dynamic?'<span class="badge purple">dynamic</span>':''}</td><td class="mono">\${esc(a.name)}</td><td class="caps">\${tags}</td></tr>\`;
  }).join('');
  $('fleet-table').innerHTML = \`<table><thead><tr><th>Agent</th><th>id</th><th>Capabilities</th></tr></thead><tbody>\${rows}</tbody></table>\`;
  // Populate the compose-box agent dropdown from the fleet.
  const sel = $('task-agents');
  if (sel) {
    const preset = sel.value;
    sel.innerHTML = '<option value="">default team (auto)</option>' +
      (f.fleet??[]).map(a=>'<option value="'+esc(a.name)+'">'+esc(a.displayName)+'</option>').join('');
    sel.value = preset;
  }
}

// ---- Attachments (drag-drop + attach button) ----
// attachments: [{ name, path, type, previewUrl? }] — path is filled after upload.
let attachments = [];

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => { const s = String(fr.result); resolve(s.slice(s.indexOf(',') + 1)); };
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}
function isImageType(type) { return String(type||'').startsWith('image/'); }
function endsWithAny(name, exts) { const n = String(name||'').toLowerCase(); return exts.some(e => n.endsWith(e)); }
function iconFor(type, name) {
  if (isImageType(type)) return '🖼️';
  if (endsWithAny(type, ['/pdf']) || endsWithAny(name, ['.pdf'])) return '📕';
  if (endsWithAny(name, ['.md','.txt','.json','.yaml','.yml','.csv'])) return '📄';
  if (endsWithAny(name, ['.zip','.tar','.gz','.tgz'])) return '🗜️';
  return '📎';
}

function renderChips() {
  const box = $('attach-chips'); if (!box) return;
  box.innerHTML = attachments.map((a, i) => {
    const preview = a.previewUrl ? '<img src="'+a.previewUrl+'">' : '<span class="chip-icon">'+iconFor(a.type, a.name)+'</span>';
    const cls = a.uploading ? 'chip uploading' : 'chip';
    const x = a.uploading ? '⏳' : '✕';
    return '<span class="'+cls+'" data-i="'+i+'">'+preview+'<span class="chip-name">'+esc(a.name)+'</span><span class="chip-x" data-x="'+i+'">'+x+'</span></span>';
  }).join('');
}

async function addFiles(files) {
  const hint = $('task-hint');
  for (const file of files) {
    const idx = attachments.length;
    attachments.push({ name: file.name, type: file.type || '', uploading: true });
    renderChips();
    try {
      const base64 = await fileToBase64(file);
      const r = await fetch(API+'/api/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, type: file.type, data: base64 }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || 'upload failed');
      attachments[idx].path = d.path;
      attachments[idx].uploading = false;
      if (isImageType(file.type)) attachments[idx].previewUrl = URL.createObjectURL(file);
    } catch (e) {
      // Mark failed + remove after a beat.
      hint.innerHTML = '<span style="color:var(--red)">Upload failed: '+esc(e.message)+'</span>';
      attachments.splice(idx, 1);
    }
    renderChips();
  }
}

// Wire the attach button + hidden file input.
$('attach-btn').onclick = () => $('file-input').click();
$('file-input').onchange = (e) => { const fs = [...(e.target.files||[])]; if (fs.length) addFiles(fs); e.target.value = ''; };

// Drag-drop on the compose box.
const composeBox = $('compose-box');
['dragenter','dragover'].forEach(ev => composeBox.addEventListener(ev, (e) => { e.preventDefault(); composeBox.classList.add('drag-over'); }));
['dragleave','drop'].forEach(ev => composeBox.addEventListener(ev, (e) => { e.preventDefault(); composeBox.classList.remove('drag-over'); }));
composeBox.addEventListener('drop', (e) => { const fs = [...(e.dataTransfer?.files||[])]; if (fs.length) addFiles(fs); });

// Allow removing a chip before submission.
$('attach-chips').addEventListener('click', (e) => {
  const t = e.target.closest('[data-x]'); if (!t) return;
  const i = Number(t.dataset.x); if (attachments[i] && !attachments[i].uploading) attachments.splice(i, 1);
  renderChips();
});

// ---- Task submission (the compose box) ----
async function submitTask() {
  const task = $('task-input').value.trim();
  if (!task) { $('task-input').focus(); return; }
  // Wait for any uploads still in flight, then collect the paths.
  const pending = attachments.filter(a => a.uploading);
  if (pending.length) { $('task-hint').innerHTML = 'Waiting for <b>'+pending.length+'</b> upload(s) to finish…'; await new Promise(r => setTimeout(r, 400)); }
  const paths = attachments.filter(a => a.path).map(a => a.path);
  const agentsRaw = $('task-agents').value;
  const engineRaw = $('task-engine') ? $('task-engine').value : 'gsd';
  const btn = $('task-run');
  const hint = $('task-hint');
  btn.disabled = true; btn.textContent = 'Starting…';
  hint.innerHTML = 'Submitting task to the orchestrator…';
  try {
    const r = await fetch(API+'/api/task', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, agents: agentsRaw ? [agentsRaw] : undefined, attachments: paths.length ? paths : undefined, engine: engineRaw })
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'submit failed');
    // Clear the box, attachments, switch to the Conversation tab, reset the transcript.
    $('task-input').value = '';
    attachments = []; renderChips();
    currentPhaseIdx = -1; renderPhaseBar();
    const status = $('conv-status'); if (status) { status.style.display = 'none'; status.innerHTML = ''; }
    clarifyState = null; renderClarifyCards();
    const rp = $('result-panel'); if (rp) rp.innerHTML = '';
    const tr = $('conv-transcript'); if (tr) tr.innerHTML = '';
    // Show an immediate "working" message so the screen isn't blank during the
    // 5-15s before the first agent event arrives.
    appendConversationMsg({ phase: 'planning', fromAgent: 'orchestrator', content: '▸ Task received. Dispatching to the fleet — agents are thinking…' });
    document.querySelectorAll('nav button').forEach(x=>x.classList.remove('active'));
    document.querySelector('nav button[data-tab="conversation"]').classList.add('active');
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    $('conversation').classList.add('active');
    hint.innerHTML = 'Task started — agents are working. Watch the <b>Conversation</b> tab.';
  } catch (e) {
    hint.innerHTML = '<span style="color:var(--red)">Failed to start: '+esc(e.message)+'</span>';
  } finally {
    btn.disabled = false; btn.textContent = 'Run task ▸';
  }
}
$('task-run').onclick = submitTask;
$('task-input').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitTask(); }
});

async function loadModels(){
  const m = await get('/api/models');
  const agents = [...new Set((m.aliases??[]).flatMap(a=>Object.keys(a.providers||{})))];
  const head = '<th>alias</th>'+agents.map(a=>'<th>'+esc(a)+'</th>').join('');
  const rows = (m.aliases??[]).map(a=>{
    return '<tr><td class="mono">'+esc(a.alias)+'</td>'+agents.map(ag=>'<td>'+(a.providers?.[ag]?('<span class="mono">'+esc(a.providers[ag])+'</span>'):'<span class="badge dim">—</span>')+'</td>').join('')+'</tr>';
  }).join('');
  $('models-table').innerHTML = '<table><thead><tr>'+head+'</tr></thead><tbody>'+rows+'</tbody></table>';
}

function runsTable(runs){
  return '<table><thead><tr><th>Run</th><th>Pattern</th><th>Status</th><th>Winner</th><th>Spent</th><th>Task</th></tr></thead><tbody>'+
    runs.map(r=>{
      const err = r.meta && r.meta.error ? String(r.meta.error).slice(0,120) : '';
      const errTag = (r.status==='failed' && err) ? ' <span class="badge red" title="'+esc(err)+'">!</span>' : '';
      const taskTitle = err ? err : '';
      return '<tr><td class="mono">'+esc(String(r.id).slice(0,10))+'</td><td>'+statusBadge(r.pattern)+'</td>'+statusCell(r.status)+errTag+'<td>'+(r.winnerAgent?esc(r.winnerAgent):'<span class="dim">—</span>')+'</td><td>'+(r.spentUsd!=null?('$'+r.spentUsd.toFixed(3)):'—')+'</td><td title="'+esc(taskTitle)+'">'+esc(String(r.task).slice(0,60))+'</td></tr>';
    }).join('')
    +'</tbody></table>';
}
async function loadRuns(){ const r=await get('/api/runs'); $('runs-table').innerHTML = (r.runs?.length)?runsTable(r.runs):'<div class="empty">No runs yet.</div>'; }
function statusBadge(p){ const m={ensemble:'purple',solo:'blue',judge:'yellow'}; return '<span class="badge '+(m[p]||'dim')+'">'+esc(p)+'</span>'; }
function statusCell(s){ const m={done:'green',running:'yellow',failed:'red',cancelled:'dim'}; return '<td><span class="badge '+(m[s]||'dim')+'">'+esc(s)+'</span></td>'; }

async function loadTailnet(){
  try{
    const t = await get('/api/fleet/tailnet');
    const rows = (t.peers??[]).map(p=>{
      const os = p.os||'?'; const state = p.online?'<span class="badge green">online</span>':'<span class="badge dim">offline</span>';
      const exit = p.offersExitNode?'<span class="badge yellow">exit node</span>':'';
      return '<tr><td><b>'+esc(p.hostname)+'</b></td><td class="mono">'+esc(p.ip)+'</td><td>'+esc(p.user)+'</td><td>'+esc(os)+'</td><td>'+state+' '+exit+'</td></tr>';
    }).join('');
    $('tailnet-table').innerHTML = '<table><thead><tr><th>Host</th><th>Tailnet IP</th><th>User</th><th>OS</th><th>State</th></tr></thead><tbody>'+rows+'</tbody></table>'+(rows?'':'<div class="empty">No Tailscale peers (or tailscale unavailable).</div>');
  }catch(e){ $('tailnet-table').innerHTML='<div class="empty">Tailscale query failed.</div>'; }
}

async function loadStats(){
  try{
    const s = await get('/api/stats');
    const winRows = Object.entries(s.winRate||{}).sort((a,b)=>b[1]-a[1]).map(([a,p])=>
      '<tr><td>'+esc(a)+'</td><td><div class="score-bar"><div class="score-fill" style="width:'+p+'%"></div></div></td><td>'+p+'%</td></tr>').join('');
    const patRows = Object.entries(s.byPattern||{}).map(([p,n])=>'<span class="badge blue">'+esc(p)+' '+n+'</span>').join(' ');
    const stRows = Object.entries(s.byStatus||{}).map(([p,n])=>'<span class="badge '+(p==='done'?'green':p==='failed'?'red':'yellow')+'">'+esc(p)+' '+n+'</span>').join(' ');
    const spark = (s.spendOverTime||[]).map(x=>x.spent).join(',');
    $('stats-content').innerHTML =
      '<div class="grid cards" style="margin-bottom:16px">'+
        card('Total runs', s.totalRuns||0, 'accent')+
        card('Total spend', '$'+(s.totalSpent||0).toFixed(3), 'green')+
        card('Patterns', Object.keys(s.byPattern||{}).length, '')+
      '</div>'+
      '<h2 style="font-size:14px;color:var(--dim);margin:16px 0 8px">By pattern</h2><div>'+patRows+'</div>'+
      '<h2 style="font-size:14px;color:var(--dim);margin:16px 0 8px">By status</h2><div>'+stRows+'</div>'+
      '<h2 style="font-size:14px;color:var(--dim);margin:16px 0 8px">Win rate by agent</h2>'+
      '<table><thead><tr><th>Agent</th><th>Win share</th><th>%</th></tr></thead><tbody>'+(winRows||'<tr><td colspan=3 class=empty>no winners yet</td></tr>')+'</tbody></table>'+
      (spark?'<h2 style="font-size:14px;color:var(--dim);margin:16px 0 8px">Spend trend (last '+s.spendOverTime.length+' runs)</h2><div class=mono>'+esc(spark)+'</div>':'');
  }catch(e){ $('stats-content').innerHTML='<div class=empty>stats load failed</div>'; }
}

async function loadConfig(){
  try{
    const [a,m] = await Promise.all([get('/api/config/agents'),get('/api/models')]);
    const agentRows=(a.agents||[]).map(x=>'<tr><td><b>'+esc(x.name)+'</b>'+(x.dynamic?' <span class="badge purple">dynamic</span>':'')+'</td><td class="mono">'+esc(x.command)+'</td><td>'+(x.enabled?'<span class="badge green">on</span>':'<span class="badge dim">off</span>')+'</td><td class="mono">'+esc(x.defaultModel||'—')+'</td></tr>').join('');
    const agents2=[...new Set((m.aliases||[]).flatMap(a=>Object.keys(a.providers||{})))];
    const modelRows=(m.aliases||[]).map(al=>'<tr><td class="mono">'+esc(al.alias)+'</td>'+agents2.map(ag=>'<td>'+(al.providers?.[ag]?'<span class="mono">'+esc(al.providers[ag])+'</span>':'<span class="badge dim">—</span>')+'</td>').join('')+'</tr>').join('');
    $('config-content').innerHTML =
      '<p style="color:var(--dim);margin-bottom:12px">Read-only view. Edit <code>config/agents.yaml</code> and <code>config/models.yaml</code> then restart.</p>'+
      '<h2 style="font-size:14px;color:var(--dim);margin:0 0 8px">Agents</h2>'+
      '<table><thead><tr><th>Name</th><th>Command</th><th>Enabled</th><th>Default model</th></tr></thead><tbody>'+agentRows+'</tbody></table>'+
      '<h2 style="font-size:14px;color:var(--dim);margin:16px 0 8px">Model aliases</h2>'+
      '<table><thead><tr><th>alias</th>'+agents2.map(a=>'<th>'+esc(a)+'</th>').join('')+'</tr></thead><tbody>'+modelRows+'</tbody></table>';
  }catch(e){ $('config-content').innerHTML='<div class=empty>config load failed</div>'; }
}

// Conversation tab — phase bar + transcript (fed by WS events from the task orchestrator)
const PHASE_LIST = ["planning","orchestrating","running","testing","looping","delivered"];
let currentPhaseIdx = -1;
function renderPhaseBar() {
  const bar = $("phase-bar");
  if (!bar) return;
  bar.innerHTML = PHASE_LIST.map((p, i) => {
    const cls = i < currentPhaseIdx ? "badge green" : i === currentPhaseIdx ? "badge yellow" : "badge dim";
    return '<span class="'+cls+'" style="flex:1;text-align:center;padding:8px">'+p.toUpperCase()+'</span>';
  }).join("");
}
function appendConversationMsg(m) {
  const el = $("conv-transcript"); if (!el) return;
  const line = document.createElement("div"); line.style.marginBottom = "12px";
  const content = m.content || '';
  const isError = content.startsWith('[error]') || content.toLowerCase().includes('task failed');
  if (isError) line.style.borderLeft = "3px solid var(--red)";
  const phaseTag = '<span class="badge '+(isError?'red':'purple')+'" style="font-size:10px">'+(m.phase||'').toUpperCase()+'</span>';
  const fromTag = '<b style="color:'+(isError?'var(--red)':'var(--cyan)')+'">'+esc(m.fromAgent||'?')+'</b>';
  const toTag = m.toAgent ? ' <span style="color:var(--dim)">→ '+esc(m.toAgent)+'</span>' : '';
  const bodyColor = isError ? 'var(--red)' : 'var(--text)';
  const body = '<div style="margin-top:4px;white-space:pre-wrap;color:'+bodyColor+'">'+esc(content.slice(0,600))+(content.length>600?'…':'')+'</div>';
  line.innerHTML = phaseTag+' '+fromTag+toTag+(m.iteration!=null?' <span class="badge dim">iter '+(m.iteration+1)+'</span>':'')+body;
  el.appendChild(line); el.scrollTop = el.scrollHeight;
}

// Show a delivered/failed banner above the transcript when the run ends.
function showResultBanner(status, error) {
  const bar = $("conv-status");
  if (!bar) return;
  if (status === "failed") {
    bar.innerHTML = '<span class="badge red" style="padding:6px 12px">✗ FAILED</span>' +
      (error ? ' <span style="color:var(--red)">'+esc(error.slice(0,200))+'</span>' : ' <span style="color:var(--dim)">see messages below</span>');
  } else if (status === "done") {
    bar.innerHTML = '<span class="badge green" style="padding:6px 12px">✓ DELIVERED</span> <span style="color:var(--dim)">task complete</span>';
  }
  bar.style.display = "flex";
}

// Show the delivered result in a prominent panel with Copy + Download.
let lastResultOutput = '';
function showResultPanel(status, output, iterations) {
  const panel = $('result-panel');
  if (!panel) return;
  if (status !== 'done' || !output || !output.trim()) { panel.innerHTML = ''; return; }
  lastResultOutput = output;
  const lines = output.split(String.fromCharCode(10)).length;
  const isCode = output.includes(String.fromCharCode(10)) && /(function|def |class |import |const |=>|return )/.test(output) && lines > 2;
  const meta = '<div class="rp-meta">'+lines+' lines · '+(iterations!=null?iterations+' iteration(s) · ':'')+output.length+' chars</div>';
  panel.innerHTML =
    '<div class="result-panel">' +
      '<div class="rp-head">' +
        '<span class="rp-title"><span class="badge green">✓ Result</span> Delivered output</span>' +
        '<span class="rp-actions">' +
          '<button class="rp-btn" id="rp-copy">📋 Copy</button>' +
          '<button class="rp-btn" id="rp-download">⬇ Download</button>' +
        '</span>' +
      '</div>' +
      '<div class="rp-body"><div class="rp-code">'+esc(output)+'</div>'+meta+'</div>' +
    '</div>';
  $('rp-copy').onclick = () => {
    navigator.clipboard.writeText(lastResultOutput).then(() => {
      const b = $('rp-copy'); b.textContent = '✓ Copied!'; setTimeout(() => b.textContent = '📋 Copy', 1500);
    });
  };
  $('rp-download').onclick = () => {
    const isPy = output.includes('def ') || output.includes('import ') || output.includes('print(');
    const isJs = output.includes('function ') || output.includes('const ') || output.includes('=>') || output.includes('console.');
    const ext = isPy ? 'py' : isJs ? 'js' : isCode ? 'txt' : 'md';
    const blob = new Blob([lastResultOutput], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'stackai-result.' + ext;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Clarify cards — interactive questions when a task is ambiguous.
let clarifyState = null; // { questionId, questions, answers: {} }
function renderClarifyCards() {
  const area = $('clarify-area'); if (!area) return;
  if (!clarifyState) { area.innerHTML = ''; return; }
  const cards = clarifyState.questions.map(q => {
    const sel = clarifyState.answers[q.id];
    const opts = q.options.map((o, oi) => {
      const isSel = sel === o.label;
      const rec = o.recommended ? '<span class="cq-rec">★ recommended</span>' : '';
      const desc = o.description ? '<span class="cq-desc">'+esc(o.description)+'</span>' : '';
      return '<div class="cq-opt'+(isSel?' selected':'')+'" data-q="'+esc(q.id)+'" data-opt="'+oi+'"><b>'+esc(o.label)+'</b>'+rec+desc+'</div>';
    }).join('');
    return '<div class="clarify-card"><div class="cq-header">'+esc(q.header)+'</div><div class="cq-question">'+esc(q.question)+'</div><div class="cq-options">'+opts+'</div></div>';
  }).join('');
  area.innerHTML = cards + '<button class="clarify-submit" id="clarify-submit">Submit answers ▸</button>';
  // Wire option clicks (toggle selection within each question).
  area.querySelectorAll('.cq-opt').forEach(el => {
    el.onclick = () => {
      const qid = el.dataset.q; const oi = Number(el.dataset.opt);
      const q = clarifyState.questions.find(x => x.id === qid); if (!q) return;
      clarifyState.answers[qid] = q.options[oi].label;
      renderClarifyCards();
    };
  });
  $('clarify-submit').onclick = submitClarifyAnswers;
}
async function submitClarifyAnswers() {
  if (!clarifyState) return;
  const btn = $('clarify-submit'); if (btn) { btn.disabled = true; btn.textContent = 'Locking decisions…'; }
  try {
    // Fill in recommended defaults for any unanswered questions.
    const answers = {};
    for (const q of clarifyState.questions) {
      answers[q.id] = clarifyState.answers[q.id] || (q.options.find(o=>o.recommended)||q.options[0]||{}).label || '';
    }
    const r = await fetch(API+'/api/task/answer', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ questionId: clarifyState.questionId, answers }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || 'submit failed');
    // Lock the cards so the user sees their final choices.
    document.querySelectorAll('.clarify-card').forEach(c => c.classList.add('locked'));
    const area = $('clarify-area');
    area.querySelectorAll('.cq-opt').forEach(el => el.classList.remove('selected'));
    // Re-apply selected styling for locked view.
    for (const q of clarifyState.questions) {
      const sel = answers[q.id];
      area.querySelectorAll('.cq-opt').forEach(el => {
        if (el.textContent.includes(sel)) el.classList.add('selected');
      });
    }
    if (btn) btn.remove();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Submit answers ▸'; }
    alert('Failed to submit answers: '+e.message);
  }
}
renderPhaseBar();

// WebSocket live events
function connectWS(){
  const proto = location.protocol==='https:'?'wss':'ws';
  const ws = new WebSocket(proto+'://'+location.host+'/ws');
  ws.onmessage = (ev)=>{
    const m = JSON.parse(ev.data);
    // Route conversation/phase events to the Conversation tab.
    if (m.type === 'phase' && m.data) {
      const idx = PHASE_LIST.indexOf(m.data.phase);
      if (idx >= 0 && idx > currentPhaseIdx) { currentPhaseIdx = idx; renderPhaseBar(); }
    }
    if (m.type === 'conversation' && m.data) {
      appendConversationMsg(m.data);
    }
    if (m.type === 'agent-switch' && m.data) {
      // The orchestrator recovered by switching agents — show it as a yellow
      // system message so the user sees the fleet adapting in real time.
      appendConversationMsg({ phase: m.data.phase, fromAgent: m.data.from, toAgent: m.data.to, content: '[switch] '+m.data.from+' → '+m.data.to+' ('+m.data.reason+')' });
    }
    if (m.type === 'clarify' && m.data) {
      // The clarifier found ambiguity — render interactive question cards.
      clarifyState = { questionId: m.data.questionId, questions: m.data.questions, answers: {} };
      appendConversationMsg({ phase: 'planning', fromAgent: 'clarifier', content: '🤔 Before I start, I need to check a few things:' });
      renderClarifyCards();
      // Make sure we're on the Conversation tab so the user sees the questions.
      document.querySelectorAll('nav button').forEach(x=>x.classList.remove('active'));
      document.querySelector('nav button[data-tab="conversation"]').classList.add('active');
      document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
      $('conversation').classList.add('active');
    }
    if (m.type === 'done' && m.data) {
      currentPhaseIdx = PHASE_LIST.length - 1; renderPhaseBar();
      // Show the delivered/failed banner — the error field explains failures.
      showResultBanner(m.data.status, m.data.error);
      // Show the delivered output in a prominent result panel with Copy/Download.
      showResultPanel(m.data.status, m.data.finalOutput, m.data.iterations);
    }
    // Also log everything to the Live tab.
    const log = $('live-log');
    const line = document.createElement('div'); line.className='line';
    if(m.type==='error') line.classList.add('err');
    if(m.type==='system') line.classList.add('dim');
    line.textContent = '['+new Date().toLocaleTimeString()+'] '+m.type+': '+JSON.stringify(m.data).slice(0,200);
    log.appendChild(line); log.scrollTop = log.scrollHeight;
    if(log.children.length>500) log.removeChild(log.firstChild);
  };
  ws.onclose = ()=>setTimeout(connectWS,3000);
}
connectWS();

loadOverview(); loadFleet(); loadModels();
setInterval(loadOverview, 5000);
$('ts-port').textContent = 'dashboard :42719';
</script>
</body>
</html>`;
