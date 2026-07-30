'use strict';
/**
 * 웹 대시보드 — CLI 없이 브라우저에서 발주·관찰·수령까지.
 *
 *   node src/web.js            →  http://127.0.0.1:8765
 *
 * 설계 원칙
 *  - 외부 패키지 0개 (Node 내장 http 만)
 *  - 서버는 얇다: 발주는 기존 CLI 를 자식 프로세스로 실행할 뿐이다 (인자 배열 — 셸 인젝션 불가)
 *  - 127.0.0.1 에만 바인딩한다. 이 대시보드에는 인증이 없으므로 외부에 열면 안 된다.
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { loadConfig } = require('./cli');
const { loadGenres } = require('./roles');
const { readJson, newId } = require('./util');

const ROOT = path.join(__dirname, '..');
const PROJECT_RE = /^prj_[A-Za-z0-9]+$/;

function start(opts = {}) {
  const cfg = loadConfig({});
  if (opts.workspaceRoot) {
    cfg.workspaceRoot = path.resolve(opts.workspaceRoot);
    cfg.sessionStateRoot = path.join(cfg.workspaceRoot, 'session_state');
  }
  fs.mkdirSync(cfg.workspaceRoot, { recursive: true });

  /** 실행 상태 — 동시 1건만 허용 (비용 폭주 방지, batch 철학과 동일) */
  const state = {
    current: null,          // { projectId, child, startedAt, exitCode }
    logs: new Map(),        // projectId -> string[]
  };

  const server = http.createServer((req, res) => {
    route(req, res, cfg, state).catch((err) => {
      json(res, 500, { error: err.message });
    });
  });
  const port = opts.port ?? Number(process.env.PORT || 8765);
  server.listen(port, '127.0.0.1', () => {
    const p = server.address().port;
    if (!opts.quiet) {
      console.log(`\n소설 공장 대시보드 가동: http://127.0.0.1:${p}\n(이 주소는 이 컴퓨터에서만 열립니다. 끄려면 Ctrl+C)`);
    }
  });
  return server;
}

async function route(req, res, cfg, state) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (req.method === 'GET' && p === '/') return html(res, PAGE);
  if (req.method === 'GET' && p === '/api/presets') return apiPresets(res);
  if (req.method === 'GET' && p === '/api/projects') return apiProjects(res, cfg);
  if (req.method === 'GET' && p === '/api/current') return apiCurrent(res, state);
  if (req.method === 'GET' && p === '/api/manuscript') return apiManuscript(res, cfg, url);
  if (req.method === 'GET' && p === '/api/report') return apiReport(res, cfg, url);
  if (req.method === 'GET' && p === '/api/feed') return apiFeed(req, res, cfg, state, url);
  if (req.method === 'POST' && p === '/api/run') return apiRun(req, res, cfg, state);
  if (req.method === 'POST' && p === '/api/stop') return apiStop(res, state);
  json(res, 404, { error: 'not found' });
}

// ── API ─────────────────────────────────────────────────────────

function apiPresets(res) {
  const genres = Object.values(loadGenres()).map((g) => ({
    preset: g.preset, label: g.label, chapters: g.chapters, targetChars: g.targetChars,
  }));
  json(res, 200, genres);
}

function apiProjects(res, cfg) {
  const out = [];
  if (fs.existsSync(cfg.workspaceRoot)) {
    for (const name of fs.readdirSync(cfg.workspaceRoot)) {
      if (!PROJECT_RE.test(name)) continue;
      const st = readJson(path.join(cfg.workspaceRoot, name, 'state.json'));
      if (!st) continue;
      out.push({
        id: name,
        idea: st.brief?.idea || '',
        preset: st.brief?.preset || '',
        updated_at: st.updated_at || st.created_at || '',
        done: !!st.completed?.final,
        chapters: Object.values(st.chapters || {}).map((c) => ({ no: c.no, score: c.finalScore, revisions: c.revisions })),
      });
    }
  }
  out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  json(res, 200, out);
}

function apiCurrent(res, state) {
  const c = state.current;
  json(res, 200, c ? {
    running: c.exitCode === null || c.exitCode === undefined,
    projectId: c.projectId,
    startedAt: c.startedAt,
    exitCode: c.exitCode ?? null,
  } : { running: false });
}

function safeProjectDir(cfg, url) {
  const id = url.searchParams.get('project') || '';
  if (!PROJECT_RE.test(id)) return null;
  return { id, dir: path.join(cfg.workspaceRoot, id) };
}

function apiManuscript(res, cfg, url) {
  const ref = safeProjectDir(cfg, url);
  if (!ref) return json(res, 400, { error: '잘못된 프로젝트 ID' });
  const file = path.join(ref.dir, 'MANUSCRIPT.md');
  if (!fs.existsSync(file)) return json(res, 404, { error: '아직 원고가 없습니다' });
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(fs.readFileSync(file, 'utf8'));
}

function apiReport(res, cfg, url) {
  const ref = safeProjectDir(cfg, url);
  if (!ref) return json(res, 400, { error: '잘못된 프로젝트 ID' });
  const data = readJson(path.join(ref.dir, 'reports', 'run-summary.json'));
  if (!data) return json(res, 404, { error: '아직 보고서가 없습니다' });
  json(res, 200, data);
}

async function apiRun(req, res, cfg, state) {
  if (state.current && (state.current.exitCode === null || state.current.exitCode === undefined)) {
    return json(res, 409, { error: '이미 제작이 진행 중입니다. 끝나면 다시 발주하세요.' });
  }
  const body = await readBody(req);
  const idea = String(body.idea || '').trim();
  if (!idea) return json(res, 400, { error: '아이디어를 입력하세요.' });
  if (idea.length > 2000) return json(res, 400, { error: '아이디어가 너무 깁니다 (2000자 이하).' });

  const genres = loadGenres();
  const preset = genres[body.preset] ? String(body.preset) : 'webnovel';
  const chapters = Math.max(1, Math.min(30, parseInt(body.chapters, 10) || genres[preset].chapters));
  const provider = ['mock', 'openai', 'anthropic'].includes(body.provider) ? body.provider : 'mock';
  const projectId = newId('prj');

  // 셸을 거치지 않는다 — 인자 배열이라 "$(rm -rf ~)" 같은 입력도 그냥 문자열이다.
  const args = [
    path.join(ROOT, 'src', 'cli.js'), 'run',
    '--idea', idea,
    '--preset', preset,
    '--chapters', String(chapters),
    '--provider', provider,
    '--project', projectId,
    '--workspace', cfg.workspaceRoot,
    '--quiet',
  ];
  if (body.style) args.push('--style', String(body.style).slice(0, 500));
  if (body.notes) args.push('--notes', String(body.notes).slice(0, 500));

  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  state.logs.set(projectId, logs);
  const push = (buf) => {
    for (const line of String(buf).split('\n')) {
      const t = line.trim();
      if (t) { logs.push(t); if (logs.length > 800) logs.shift(); }
    }
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);

  state.current = { projectId, child, startedAt: new Date().toISOString(), exitCode: null };
  child.on('exit', (code) => { if (state.current?.projectId === projectId) state.current.exitCode = code ?? -1; });

  json(res, 200, { projectId, preset, chapters, provider });
}

function apiStop(res, state) {
  const c = state.current;
  if (!c || c.exitCode !== null) return json(res, 200, { stopped: false, reason: '실행 중인 작업 없음' });
  c.child.kill('SIGTERM');
  json(res, 200, { stopped: true, note: '체크포인트가 남아 있어 같은 프로젝트로 재개할 수 있습니다.' });
}

/** SSE — 버스 원장과 실행 로그를 실시간으로 브라우저에 흘린다 */
function apiFeed(req, res, cfg, state, url) {
  const ref = safeProjectDir(cfg, url);
  if (!ref) { json(res, 400, { error: '잘못된 프로젝트 ID' }); return; }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const busFile = path.join(ref.dir, 'bus', 'events.jsonl');
  let busOffset = 0;
  let logIndex = 0;
  let closed = false;

  const send = (event, data) => {
    if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const tick = () => {
    // 1) 버스 원장 증분 읽기
    try {
      const size = fs.statSync(busFile).size;
      if (size > busOffset) {
        const fd = fs.openSync(busFile, 'r');
        const buf = Buffer.alloc(size - busOffset);
        fs.readSync(fd, buf, 0, buf.length, busOffset);
        fs.closeSync(fd);
        busOffset = size;
        for (const line of buf.toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line);
            if (e.type === 'PUBLISH') {
              send('bus', { sender: e.sender, receiver: e.receiver, status: e.status, summary: e.summary });
            }
          } catch { /* 파싱 불가 라인은 건너뜀 */ }
        }
      }
    } catch { /* 버스 파일이 아직 없으면 다음 틱에 */ }

    // 2) 실행 로그 증분
    const logs = state.logs.get(ref.id) || [];
    while (logIndex < logs.length) send('log', logs[logIndex++]);

    // 3) 종료 감지
    const c = state.current;
    if (c && c.projectId === ref.id && c.exitCode !== null) {
      const summary = readJson(path.join(ref.dir, 'reports', 'run-summary.json'));
      send('done', { exitCode: c.exitCode, summary: summary ? {
        chapters: summary.chapters?.map((x) => ({ no: x.no, score: x.finalScore })),
        escalations: summary.escalations?.length || 0,
        calls: summary.usage?.calls,
      } : null });
      cleanup();
    }
  };
  const timer = setInterval(tick, 500);
  const cleanup = () => { if (!closed) { closed = true; clearInterval(timer); res.end(); } };
  req.on('close', cleanup);
}

// ── 유틸 ────────────────────────────────────────────────────────

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function html(res, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 64 * 1024) { reject(new Error('본문이 너무 큽니다')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('JSON 파싱 실패')); } });
  });
}

// ── 페이지 (단일 HTML, 외부 리소스 없음) ─────────────────────────

const PAGE = `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>소설 공장</title>
<style>
  :root{--bg:#14151a;--panel:#1e2028;--line:#2e313c;--fg:#e6e6ea;--dim:#9a9dab;--acc:#8b7cf6;--ok:#4ade80;--warn:#fbbf24;--err:#f87171}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,'Apple SD Gothic Neo','Malgun Gothic',sans-serif}
  header{padding:18px 24px;border-bottom:1px solid var(--line);display:flex;align-items:baseline;gap:12px}
  header h1{margin:0;font-size:19px}header span{color:var(--dim);font-size:13px}
  main{display:grid;grid-template-columns:340px 1fr;gap:16px;padding:16px 24px;max-width:1280px}
  @media(max-width:900px){main{grid-template-columns:1fr}}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
  h2{margin:0 0 12px;font-size:14px;color:var(--dim);font-weight:600;letter-spacing:.04em}
  label{display:block;margin:10px 0 4px;font-size:13px;color:var(--dim)}
  input,select,textarea{width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:8px 10px;font:inherit}
  textarea{resize:vertical;min-height:64px}
  button{margin-top:14px;width:100%;padding:11px;border:0;border-radius:8px;background:var(--acc);color:#fff;font:inherit;font-weight:700;cursor:pointer}
  button:disabled{opacity:.45;cursor:not-allowed}
  button.stop{background:transparent;border:1px solid var(--err);color:var(--err);margin-top:8px;padding:8px}
  #feed{height:380px;overflow-y:auto;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px}
  #feed .b{color:var(--dim)}#feed .b b{color:var(--acc);font-weight:600}
  #feed .err{color:var(--err)}#feed .human{color:var(--warn)}
  #ms{white-space:pre-wrap;max-height:480px;overflow-y:auto;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:16px 18px;display:none}
  .proj{padding:9px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px;cursor:pointer}
  .proj:hover{border-color:var(--acc)}
  .proj .t{font-size:13.5px}.proj .m{font-size:12px;color:var(--dim)}
  .badge{display:inline-block;padding:1px 7px;border-radius:99px;font-size:11px;border:1px solid var(--line);color:var(--dim);margin-left:6px}
  .badge.done{color:var(--ok);border-color:var(--ok)}
  #banner{display:none;margin-bottom:12px;padding:10px 12px;border-radius:8px;font-size:13.5px}
  #banner.ok{display:block;background:#132a1a;border:1px solid var(--ok)}
  #banner.err{display:block;background:#2a1313;border:1px solid var(--err)}
</style></head><body>
<header><h1>📚 소설 공장</h1><span>아이디어를 넣으면 스튜디오 팀장이 조직을 돌려 완성 원고를 보고합니다</span></header>
<main>
  <div>
    <div class="panel">
      <h2>발주</h2>
      <div id="banner"></div>
      <label>아이디어 (한 줄이면 충분)</label>
      <textarea id="idea" placeholder="예) 몰락한 변방 영지를 물려받은 전생자"></textarea>
      <label>장르 (담당 팀장)</label><select id="preset"></select>
      <label>회차 수</label><input id="chapters" type="number" min="1" max="30">
      <label>문체 지시 (선택)</label><input id="style" placeholder="예) 짧고 건조한 문장, 대사 위주">
      <label>추가 지침 (선택)</label><input id="notes" placeholder="예) 잔혹 묘사 자제">
      <label>엔진</label><select id="provider">
        <option value="mock">mock — 무료 리허설 (더미 문장)</option>
        <option value="openai">openai — 실제 집필 (API 키 필요)</option>
        <option value="anthropic">anthropic — 실제 집필 (API 키 필요)</option>
      </select>
      <button id="go">제작 시작</button>
      <button id="stop" class="stop" style="display:none">중단 (체크포인트 저장됨)</button>
    </div>
    <div class="panel" style="margin-top:16px">
      <h2>완성 작품</h2>
      <div id="projects"><span style="color:var(--dim);font-size:13px">아직 없습니다</span></div>
    </div>
  </div>
  <div>
    <div class="panel">
      <h2>제작 현장 (에이전트 릴레이)</h2>
      <div id="feed"><span style="color:var(--dim)">발주하면 여기로 팀장·팀원의 핸드오프가 실시간으로 흐릅니다.</span></div>
    </div>
    <div class="panel" style="margin-top:16px">
      <h2 id="msTitle">원고</h2>
      <div id="ms"></div>
    </div>
  </div>
</main>
<script>
const $=(id)=>document.getElementById(id);
let es=null;

async function loadPresets(){
  const list=await (await fetch('/api/presets')).json();
  $('preset').innerHTML=list.map(g=>\`<option value="\${g.preset}" data-ch="\${g.chapters}">\${g.label}</option>\`).join('');
  $('chapters').value=list[0]?.chapters||3;
  $('preset').onchange=()=>{ $('chapters').value=$('preset').selectedOptions[0].dataset.ch; };
}
async function loadProjects(){
  const list=await (await fetch('/api/projects')).json();
  if(!list.length) return;
  $('projects').innerHTML=list.map(p=>\`
    <div class="proj" onclick="openMs('\${p.id}')">
      <div class="t">\${esc(p.idea)}<span class="badge \${p.done?'done':''}">\${p.done?'완성':'진행중'}</span></div>
      <div class="m">\${p.preset} · \${p.chapters.map(c=>c.no+'화 '+c.score+'점').join(' · ')||'-'}</div>
    </div>\`).join('');
}
async function openMs(id){
  const r=await fetch('/api/manuscript?project='+id);
  $('ms').style.display='block';
  $('ms').textContent=r.ok?await r.text():'아직 원고가 없습니다.';
  $('msTitle').textContent='원고 — '+id;
  $('ms').scrollTop=0;
}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function feedLine(cls,html){
  const d=document.createElement('div'); d.className=cls; d.innerHTML=html;
  const f=$('feed'); f.appendChild(d); f.scrollTop=f.scrollHeight;
}
function banner(kind,msg){ const b=$('banner'); b.className=kind; b.textContent=msg; }

$('go').onclick=async()=>{
  const body={idea:$('idea').value,preset:$('preset').value,chapters:$('chapters').value,
              style:$('style').value,notes:$('notes').value,provider:$('provider').value};
  const r=await fetch('/api/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const data=await r.json();
  if(!r.ok){ banner('err',data.error); return; }
  banner('ok','발주 접수: '+data.projectId+' — 제작이 시작됐습니다.');
  $('go').disabled=true; $('stop').style.display='block';
  $('feed').innerHTML='';
  if(es) es.close();
  es=new EventSource('/api/feed?project='+data.projectId);
  es.addEventListener('bus',e=>{
    const m=JSON.parse(e.data);
    const cls=m.status==='ERROR'?'err':(m.status==='NEEDS_HUMAN'?'human':'b');
    feedLine(cls,\`<b>\${m.sender}</b> → <b>\${m.receiver}</b> [\${m.status}] \${esc(m.summary)}\`);
  });
  es.addEventListener('log',e=>{ /* 자세한 실행 로그는 접어둠 — 필요 시 개발자도구 */ console.log(JSON.parse(e.data)); });
  es.addEventListener('done',e=>{
    const d=JSON.parse(e.data);
    if(d.exitCode===0 && d.summary){
      feedLine('b','━━ <b>제작 완료</b> — '+d.summary.chapters.map(c=>c.no+'화 '+c.score+'점').join(', ')
        +(d.summary.escalations?(' · ⚠ 확인 필요 '+d.summary.escalations+'건'):''));
      banner('ok','완성! 왼쪽 목록에서 작품을 눌러 원고를 읽어보세요.');
      openMs(data.projectId);
    } else {
      feedLine('err','제작이 비정상 종료됐습니다 (코드 '+d.exitCode+'). 같은 아이디어로 다시 발주하면 이어서 진행합니다.');
      banner('err','중단됨 — 체크포인트가 남아 있습니다.');
    }
    $('go').disabled=false; $('stop').style.display='none';
    es.close(); loadProjects();
  });
};
$('stop').onclick=async()=>{ await fetch('/api/stop',{method:'POST'}); };

loadPresets(); loadProjects(); setInterval(loadProjects,5000);
</script>
</body></html>`;

if (require.main === module) start();
module.exports = { start };
