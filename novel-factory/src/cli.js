#!/usr/bin/env node
'use strict';
/**
 * CLI — 사람이 개입하는 유일한 지점.
 *
 *   novel run --idea "한 줄 아이디어" --preset webnovel --chapters 3
 *   novel resume <projectId>
 *   novel status <projectId>
 *   novel bus tail <projectId> [n]
 *   novel presets
 *   novel doctor
 */
const path = require('path');
const fs = require('fs');
const { Logger, COLOR } = require('./logger');
const { Orchestrator } = require('./pm');
const { loadGenres } = require('./roles');
const { readJson, deepMerge, ensureDir } = require('./util');

const ROOT = path.join(__dirname, '..');

function loadConfig(overrides = {}) {
  const base = readJson(path.join(ROOT, 'config', 'default.json'));
  const local = readJson(path.join(ROOT, 'config', 'local.json'), {});
  const cfg = deepMerge(deepMerge(base, local), overrides);
  cfg.workspaceRoot = path.resolve(ROOT, cfg.workspaceRoot);
  cfg.sessionStateRoot = path.resolve(ROOT, cfg.sessionStateRoot);
  return cfg;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function usage() {
  console.log(`
${COLOR.bold}소설 공장 (Novel Factory) — 다중 에이전트 자동 집필 시스템${COLOR.reset}

사용법:
  node src/cli.js run --idea "<한 줄 아이디어>" [옵션]
  node src/cli.js batch <jobs.json>       여러 스튜디오 팀장에게 동시 발주, 종합 보고만 수신
  node src/cli.js resume <projectId>
  node src/cli.js status <projectId>
  node src/cli.js bus <projectId> [건수]
  node src/cli.js presets
  node src/cli.js doctor

run 옵션:
  --idea       <text>   작품의 씨앗이 되는 아이디어 (필수)
  --preset     <name>   webnovel | romance | epic          (기본 webnovel)
  --chapters   <n>      생성할 회차 수                       (기본: 프리셋 값)
  --chars      <n>      회차당 목표 분량(공백 제외)            (기본: 프리셋 값)
  --pass       <n>      비평 통과선 점수                      (기본: 프리셋 값)
  --provider   <name>   openai | anthropic | mock            (기본 mock)
  --model      <id>     프로바이더 모델 ID 덮어쓰기
  --notes      <text>   추가 지침 (수위, 금기, 톤 등)
  --style      <text>   문체 지시 (예: "짧고 건조한 문장, 은유 절제, 대사 위주")
  --trend      <path>   트렌드 자료 파일 (직접 모은 공개 메타데이터). "auto" 면 자료 없이 추정
  --no-research         리서치 단계 생략
  --project    <id>     기존 프로젝트 ID 로 이어서 진행
  --quiet               로그 최소화

예시:
  node src/cli.js run --idea "기억을 파는 대가로 마력을 얻는 소년" --preset webnovel --chapters 3
  node src/cli.js run --idea "몰락한 변방 영지를 물려받은 전생자" --preset estate --chapters 6 \\
                      --style "짧고 건조한 문장, 숫자는 감각과 함께" --trend trend.md
  OPENAI_API_KEY=sk-... node src/cli.js run --idea "..." --provider openai --model gpt-4o
`);
}

async function cmdRun(args) {
  const genres = loadGenres();
  const preset = String(args.preset || 'webnovel');
  const g = genres[preset];
  if (!g) {
    console.error(`알 수 없는 프리셋: ${preset} (가능: ${Object.keys(genres).join(', ')})`);
    process.exit(1);
  }
  if (!args.idea || args.idea === true) {
    console.error('--idea "한 줄 아이디어" 는 필수입니다.');
    process.exit(1);
  }

  const overrides = { llm: { provider: args.provider || 'mock' } };
  if (args.model) {
    overrides.llm.providers = { [args.provider || 'mock']: { model: String(args.model) } };
  }
  const cfg = loadConfig(overrides);

  const projectId = args.project && args.project !== true ? String(args.project) : null;
  ensureDir(cfg.workspaceRoot);
  const logger = new Logger({
    level: args.debug ? 'debug' : 'info',
    quiet: !!args.quiet,
    file: path.join(cfg.workspaceRoot, 'factory.log'),
  });

  // 트렌드 자료: --trend <파일경로> 로 사용자가 직접 모은 공개 메타데이터를 넣거나,
  // --trend auto 로 자료 없이 모델 내재 지식 추정을 쓴다(추정임이 결과에 명시된다).
  let trendData = '';
  const trendArg = args.trend;
  if (trendArg && trendArg !== true && trendArg !== 'auto') {
    const tp = path.resolve(process.cwd(), String(trendArg));
    if (!fs.existsSync(tp)) {
      console.error(`트렌드 자료 파일을 찾을 수 없습니다: ${tp}`);
      process.exit(1);
    }
    trendData = fs.readFileSync(tp, 'utf8');
  }

  const brief = {
    idea: String(args.idea),
    preset,
    chapters: Number(args.chapters || g.chapters),
    targetChars: Number(args.chars || g.targetChars),
    passScore: Number(args.pass || g.passScore),
    notes: args.notes && args.notes !== true ? String(args.notes) : '',
    research: !args['no-research'],
    trend: !!trendArg,
    trendData,
    style: args.style && args.style !== true ? String(args.style) : '',
  };

  logger.info(`provider=${cfg.llm.provider} model=${cfg.llm.providers[cfg.llm.provider].model}`);
  if (cfg.llm.provider === 'mock') {
    logger.warn('mock 프로바이더로 실행합니다 (오프라인 검증용). 실제 집필은 --provider openai 또는 anthropic 을 쓰세요.');
  }

  const orch = new Orchestrator({ cfg, logger, brief, projectId, resume: !!projectId });
  const summary = await orch.run();
  printSummary(summary);
  return summary;
}

/**
 * batch — 발주서 파일을 읽어 여러 스튜디오 팀장에게 순차 발주한다.
 * 각 팀장이 산하 조직을 돌려 작품을 완성하고, 사용자는 마지막 종합 보고만 받는다.
 * 진행 로그는 기본 침묵(--verbose 로 해제). "결과만 보고" 가 이 명령의 계약이다.
 */
async function cmdBatch(args) {
  const jobsPath = args._[1];
  if (!jobsPath) {
    console.error('발주서 파일을 지정하세요: node src/cli.js batch <jobs.json>  (템플릿: templates/jobs.example.json)');
    process.exit(1);
  }
  const jobs = readJson(path.resolve(process.cwd(), jobsPath));
  if (!Array.isArray(jobs) || !jobs.length) {
    console.error(`발주서가 비어 있거나 JSON 배열이 아닙니다: ${jobsPath}`);
    process.exit(1);
  }

  const genres = loadGenres();
  const cfg = loadConfig({ llm: { provider: args.provider || 'mock' } });
  ensureDir(cfg.workspaceRoot);
  const results = [];

  console.log(`\n${COLOR.bold}발주 ${jobs.length}건 접수 — 각 스튜디오 팀장에게 배정합니다${COLOR.reset}`);

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const g = genres[job.preset || 'webnovel'];
    if (!g || !job.idea) {
      results.push({ ok: false, idea: job.idea || '(없음)', error: !job.idea ? 'idea 누락' : `알 수 없는 preset: ${job.preset}` });
      console.log(`  ${COLOR.error}✘ [${i + 1}/${jobs.length}] 발주 반려: ${results[i].error}${COLOR.reset}`);
      continue;
    }
    const brief = {
      idea: String(job.idea),
      preset: g.preset,
      chapters: Number(job.chapters || g.chapters),
      targetChars: Number(job.chars || g.targetChars),
      passScore: Number(job.pass || g.passScore),
      notes: job.notes || '',
      style: job.style || '',
      research: job.research !== false,
      trend: !!job.trend,
      trendData: '',
    };
    const logger = new Logger({ quiet: !args.verbose, file: path.join(cfg.workspaceRoot, 'factory.log') });
    const orch = new Orchestrator({ cfg, logger, brief });
    console.log(`  ▸ [${i + 1}/${jobs.length}] ${orch.studio} 에 발주: "${brief.idea}" (${g.label}, ${brief.chapters}회차)`);
    try {
      const s = await orch.run();
      results.push({ ok: true, studio: orch.studio, label: g.label, brief, summary: s });
      const scores = s.chapters.map((c) => `${c.no}화 ${c.finalScore}`).join(' ');
      console.log(`    ${COLOR.ok}✔ 완성 — ${scores} → ${path.join(s.project_dir, s.manuscript)}${COLOR.reset}`);
    } catch (err) {
      results.push({ ok: false, studio: orch.studio, idea: brief.idea, error: err.message });
      console.log(`    ${COLOR.error}✘ 실패: ${err.message}${COLOR.reset}`);
    }
  }

  // 종합 보고서 — 사용자가 받는 유일한 문서
  const lines = [
    '# 스튜디오 종합 보고',
    '',
    `- 발주: ${jobs.length}건 / 완성: ${results.filter((r) => r.ok).length}건`,
    '',
  ];
  for (const r of results) {
    if (!r.ok) {
      lines.push(`## ✘ ${r.idea}`, `- 실패: ${r.error}`, '');
      continue;
    }
    const s = r.summary;
    lines.push(
      `## ${r.label} — ${r.brief.idea}`,
      `- 담당 팀장: ${r.studio}`,
      `- 원고: ${path.join(s.project_dir, s.manuscript)}`,
      `- 회차: ${s.chapters.map((c) => `${c.no}화 ${c.finalScore}점(개고${c.revisions})`).join(' · ')}`,
      `- 퇴고 손질: ${s.polish?.touched_chapters?.length ?? 0}개 회차`,
      `- 에스컬레이션: ${s.escalations.length}건${s.escalations.length ? ' ← 확인 필요' : ''}`,
      `- 비용: LLM ${s.usage.calls}회 호출`,
      '',
    );
  }
  const reportPath = path.join(cfg.workspaceRoot, 'BATCH_REPORT.md');
  fs.writeFileSync(reportPath, lines.join('\n') + '\n', 'utf8');

  console.log(`\n${COLOR.bold}${COLOR.ok}━━ 전 스튜디오 보고 완료 ━━${COLOR.reset}`);
  console.log(lines.join('\n'));
  console.log(`종합 보고서: ${reportPath}\n`);
}

async function cmdResume(args) {
  const projectId = args._[1];
  if (!projectId) { console.error('projectId 를 지정하세요.'); process.exit(1); }
  const cfg = loadConfig(args.provider ? { llm: { provider: args.provider } } : {});
  const dir = path.join(cfg.workspaceRoot, projectId);
  const state = readJson(path.join(dir, 'state.json'));
  if (!state) { console.error(`프로젝트를 찾을 수 없습니다: ${dir}`); process.exit(1); }

  const logger = new Logger({ file: path.join(cfg.workspaceRoot, 'factory.log') });
  logger.info(`중단점에서 재개합니다: ${projectId}`);
  const orch = new Orchestrator({ cfg, logger, brief: state.brief, projectId, resume: true });
  console.log(orch.ctx.bootContext() || '(복원 컨텍스트 없음 — 파일 상태로 재개)');
  const summary = await orch.run();
  printSummary(summary);
}

function cmdStatus(args) {
  const projectId = args._[1];
  const cfg = loadConfig();
  const dir = path.join(cfg.workspaceRoot, projectId || '');
  const state = readJson(path.join(dir, 'state.json'));
  if (!state) { console.error(`프로젝트를 찾을 수 없습니다: ${dir}`); process.exit(1); }
  const snap = readJson(path.join(dir, 'session_state', 'latest_summary.json'), {});
  console.log(`\n${COLOR.bold}프로젝트 ${state.project_id}${COLOR.reset}`);
  console.log(`아이디어 : ${state.brief.idea}`);
  console.log(`장르     : ${state.brief.preset} / ${state.brief.chapters}회차`);
  console.log(`완료 단계: ${Object.keys(state.completed).join(', ') || '-'}`);
  console.log(`회차     :`);
  for (const [k, v] of Object.entries(state.chapters || {})) {
    console.log(`  ${k} 점수=${v.finalScore} 개고=${v.revisions} ${v.escalated ? '⚠에스컬레이션' : ''} ${v.path}`);
  }
  console.log(`컨텍스트 : ${snap.context ? `${(snap.context.ratio * 100).toFixed(0)}% (리셋 ${snap.context.resets_so_far}회)` : '-'}`);
}

function cmdBus(args) {
  const projectId = args._[1];
  const n = Number(args._[2] || 40);
  const cfg = loadConfig();
  const ledger = path.join(cfg.workspaceRoot, projectId || '', 'bus', 'events.jsonl');
  if (!fs.existsSync(ledger)) { console.error(`버스 원장이 없습니다: ${ledger}`); process.exit(1); }
  const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).slice(-n);
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { console.log(l); continue; }
    if (e.type === 'PUBLISH') {
      console.log(`${COLOR.dim}#${String(e.seq).padStart(3, '0')}${COLOR.reset} ` +
        `${COLOR.agent}${e.sender}${COLOR.reset} → ${COLOR.agent}${e.receiver}${COLOR.reset} ` +
        `[${e.status}] ${e.summary}`);
    } else {
      console.log(`${COLOR.dim}    ${e.type} ${e.event_id || ''} ${e.error || ''}${COLOR.reset}`);
    }
  }
}

function cmdPresets() {
  const genres = loadGenres();
  console.log(`\n${COLOR.bold}사용 가능한 작가 프리셋${COLOR.reset}`);
  for (const g of Object.values(genres)) {
    console.log(`  ${COLOR.agent}${g.preset.padEnd(10)}${COLOR.reset} ${g.label} — 기본 ${g.chapters}회차 / ${g.targetChars}자 / 통과선 ${g.passScore}점`);
  }
  console.log('\n새 작가 유형을 추가하려면 prompts/genres/<이름>.md 를 만드세요.\n');
}

function cmdDoctor() {
  const cfg = loadConfig();
  const { loadRoles } = require('./roles');
  const roles = loadRoles();
  console.log(`\n${COLOR.bold}점검 결과${COLOR.reset}`);
  console.log(`  Node        : ${process.version} ${Number(process.versions.node.split('.')[0]) >= 18 ? '✔' : '✘ (18 이상 필요)'}`);
  console.log(`  fetch       : ${typeof fetch === 'function' ? '✔' : '✘'}`);
  console.log(`  역할 로드   : ${Object.keys(roles).length}개 (${Object.keys(roles).join(', ')})`);
  console.log(`  프리셋      : ${Object.keys(loadGenres()).join(', ')}`);
  console.log(`  워크스페이스: ${cfg.workspaceRoot}`);
  for (const [name, p] of Object.entries(cfg.llm.providers)) {
    if (!p.apiKeyEnv) { console.log(`  ${name.padEnd(11)} : 키 불필요`); continue; }
    console.log(`  ${name.padEnd(11)} : ${process.env[p.apiKeyEnv] ? '✔ 키 감지됨' : `✘ ${p.apiKeyEnv} 없음`}`);
  }
  console.log('');
}

function printSummary(s) {
  console.log(`\n${COLOR.bold}${COLOR.ok}━━ 납품 완료 ━━${COLOR.reset}`);
  console.log(`프로젝트   : ${s.project_id}`);
  console.log(`원고       : ${path.join(s.project_dir, s.manuscript)}`);
  console.log(`PM 보고서  : ${path.join(s.project_dir, s.pm_report)}`);
  console.log(`회차       : ${s.chapters.map((c) => `${c.no}화(${c.finalScore}점/개고${c.revisions})`).join(' · ')}`);
  console.log(`버스       : ${s.bus.total}건 (반려 ${s.bus.rejected}, DLQ ${s.bus.dlq})`);
  console.log(`LLM        : ${s.usage.calls}회 호출, 교정 ${s.usage.repairs}회, 재시도 ${s.usage.retries}회`);
  console.log(`컨텍스트   : 리셋 ${s.context.resets}회`);
  if (s.escalations.length) {
    console.log(`${COLOR.warn}에스컬레이션 ${s.escalations.length}건 — reports/run-summary.json 확인${COLOR.reset}`);
  }
  console.log(`소요       : ${s.elapsed_sec}초\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0];
  try {
    switch (cmd) {
      case 'run': await cmdRun(args); break;
      case 'batch': await cmdBatch(args); break;
      case 'resume': await cmdResume(args); break;
      case 'status': cmdStatus(args); break;
      case 'bus': cmdBus(args); break;
      case 'presets': cmdPresets(); break;
      case 'doctor': cmdDoctor(); break;
      default: usage();
    }
  } catch (err) {
    console.error(`\n${COLOR.error}실행 실패: ${err.message}${COLOR.reset}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { loadConfig, parseArgs };
