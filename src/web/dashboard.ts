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
    <button data-tab="stats">Stats</button>
    <button data-tab="config">Config</button>
    <button data-tab="tailnet">Tailnet</button>
    <button data-tab="live">Live</button>
  </nav>
</header>
<main>
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
}

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
    runs.map(r=>'<tr><td class="mono">'+esc(String(r.id).slice(0,10))+'</td><td>'+statusBadge(r.pattern)+'</td>'+statusCell(r.status)+'<td>'+(r.winnerAgent?esc(r.winnerAgent):'<span class="dim">—</span>')+'</td><td>'+(r.spentUsd!=null?('$'+r.spentUsd.toFixed(3)):'—')+'</td><td>'+esc(String(r.task).slice(0,60))+'</td></tr>').join('')
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

// WebSocket live events
function connectWS(){
  const proto = location.protocol==='https:'?'wss':'ws';
  const ws = new WebSocket(proto+'://'+location.host+'/ws');
  ws.onmessage = (ev)=>{
    const m = JSON.parse(ev.data);
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
