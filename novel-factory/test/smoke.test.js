'use strict';
/**
 * 무의존성 스모크 테스트 — node test/smoke.test.js
 * 버스 규격, 가드 격리, 컨텍스트 리셋, 전체 파이프라인(mock)을 검증한다.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Bus } = require('../src/bus');
const { Guard, GuardError } = require('../src/guard');
const { ContextManager } = require('../src/context');
const { validateHandoff, makeHandoff } = require('../src/schema');
const { loadRoles, loadGenres } = require('../src/roles');
const { extractJson, estimateTokens } = require('../src/util');
const { Logger } = require('../src/logger');
const { Orchestrator } = require('../src/pm');
const { loadConfig } = require('../src/cli');

let passed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(() => { passed++; console.log(`  ✔ ${name}`); },
      (e) => { console.error(`  ✘ ${name}\n     ${e.message}`); process.exitCode = 1; });
    passed++; console.log(`  ✔ ${name}`);
  } catch (e) {
    console.error(`  ✘ ${name}\n     ${e.message}`);
    process.exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-factory-'));

(async () => {
  console.log('\n[1] 핸드오프 규격');
  test('필수 필드가 빠지면 반려된다', () => {
    const r = validateHandoff({ sender: 'PM' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.length >= 5);
  });
  test('미등록 역할 코드는 반려된다', () => {
    const r = validateHandoff({ sender: 'GHOST', receiver: 'PM', status: 'COMPLETE', summary: 'a', next_action: 'b', data_payload_path: 'c' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('미등록 sender')));
  });
  test('경로 탈출(..)이 든 payload 는 반려된다', () => {
    const r = validateHandoff({ sender: 'PM', receiver: 'WRITER_1', status: 'COMPLETE', summary: 'a', next_action: 'b', data_payload_path: '../../etc/passwd' });
    assert.strictEqual(r.ok, false);
  });
  test('정상 봉투는 통과한다', () => {
    const r = validateHandoff(makeHandoff({ sender: 'PM', receiver: 'WRITER_1', summary: 's', next_action: 'n', data_payload_path: 'p' }));
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  });

  console.log('\n[2] 버스');
  const bus = new Bus(path.join(tmp, 'bus'));
  test('발행 → 수신자 큐에 적재된다', () => {
    const r = bus.emit({ sender: 'PM', receiver: 'WRITER_1', summary: '집필 지시', next_action: '1화 써라', data_payload_path: 'canon/outline.json' });
    assert.ok(r.ok);
    assert.strictEqual(bus.pending('WRITER_1').length, 1);
  });
  test('ack 하면 큐에서 빠진다', () => {
    const item = bus.peek('WRITER_1');
    assert.ok(item);
    bus.ack(item.file);
    assert.strictEqual(bus.pending('WRITER_1').length, 0);
  });
  test('규격 위반 메시지는 버스에 실리지 않는다', () => {
    const r = bus.publish({ sender: 'PM' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(bus.stats().rejected, 1);
  });
  test('재시도 초과분은 DLQ 로 격리된다', () => {
    bus.emit({ sender: 'PM', receiver: 'CRITIC', summary: 'x', next_action: 'y', data_payload_path: 'z' });
    let item = bus.peek('CRITIC');
    let res;
    for (let i = 0; i < 4; i++) {
      item = bus.peek('CRITIC');
      if (!item) break;
      res = bus.nack(item.file, new Error('의도적 실패'));
    }
    assert.strictEqual(res, 'DLQ');
    assert.strictEqual(bus.stats().dlq, 1);
  });

  console.log('\n[3] 안전 게이트');
  const guard = new Guard(path.join(tmp, 'ws'), loadConfig().guard);
  test('워크스페이스 밖 쓰기는 차단된다', () => {
    assert.throws(() => guard.write('../../evil.txt', 'x'), GuardError);
  });
  test('시스템 경로 접근은 차단된다', () => {
    assert.throws(() => guard.read('/etc/passwd'), GuardError);
  });
  test('.env 접근은 차단된다', () => {
    assert.throws(() => guard.write('.env.local', 'KEY=1'), GuardError);
  });
  test('위험 명령은 거부된다', () => {
    assert.throws(() => guard.assertCommandAllowed('rm -rf / --no-preserve-root'), GuardError);
    assert.throws(() => guard.assertCommandAllowed('git push origin main'), GuardError);
  });
  test('API 키는 저장 전에 마스킹된다', () => {
    guard.write('notes.md', '키는 sk-abcdefghijklmnop1234 입니다');
    const saved = guard.read('notes.md');
    assert.ok(!saved.includes('sk-abcdefghijklmnop1234'));
    assert.ok(saved.includes('REDACTED'));
  });
  test('덮어쓰기 전 백업이 남는다', () => {
    guard.write('draft.md', '원본');
    guard.write('draft.md', '수정본');
    const backups = fs.readdirSync(path.join(tmp, 'ws', '.cache', 'backups'));
    assert.ok(backups.length >= 1);
  });

  console.log('\n[4] 컨텍스트 리셋 루프');
  test('80% 도달 시 캐싱 후 리셋된다', () => {
    const ctx = new ContextManager({
      cfg: { windowTokens: 1000, warnRatio: 0.5, cacheRatio: 0.8, hardResetRatio: 0.92 },
      projectDir: path.join(tmp, 'ws'), sessionStateRoot: path.join(tmp, 'session_state'),
      logger: null, projectId: 'prj_test',
    });
    ctx.add({ in: 300, out: 300 });
    assert.strictEqual(ctx.level(), 'WARN');
    ctx.add({ in: 200, out: 100 });
    const r = ctx.checkpoint({ stage: 'ch01:draft', completed: ['world'], remaining: ['chapters'] });
    assert.strictEqual(r.reset, true);
    assert.strictEqual(ctx.used, 0);
    const snap = JSON.parse(fs.readFileSync(path.join(tmp, 'ws', 'session_state', 'latest_summary.json'), 'utf8'));
    assert.strictEqual(snap.stage, 'ch01:draft');
    assert.ok(ctx.bootContext().includes('ch01:draft'));
  });

  console.log('\n[5] 프롬프트 자산');
  test('모든 역할 프롬프트가 로드된다', () => {
    const roles = loadRoles();
    for (const code of ['PM', 'RESEARCHER', 'WORLDBUILDER', 'CHARACTER_DESIGNER', 'SYNOPSIS_WRITER',
      'OUTLINER', 'WRITER_1', 'REVIEWER', 'CRITIC', 'WRITER_2', 'CONTINUITY_KEEPER', 'POLISHER', 'EDITOR']) {
      assert.ok(roles[code], `역할 누락: ${code}`);
      assert.ok(roles[code].prompt.length > 100, `프롬프트 부실: ${code}`);
    }
  });
  test('장르 프리셋 4종이 로드된다', () => {
    const g = loadGenres();
    assert.ok(g.webnovel && g.romance && g.epic && g.estate);
    assert.strictEqual(typeof g.webnovel.passScore, 'number');
    assert.ok(g.estate.prompt.includes('지표'), '영지물 팩에 지표 규약이 없음');
  });

  console.log('\n[6] 파서');
  test('코드펜스에 싸인 JSON 을 추출한다', () => {
    const o = extractJson('설명입니다\n```json\n{"a":1}\n```\n끝');
    assert.deepStrictEqual(o, { a: 1 });
  });
  test('한글 토큰 추정이 영문보다 무겁다', () => {
    assert.ok(estimateTokens('가나다라마바사') > estimateTokens('abcdefg'));
  });

  console.log('\n[7] 전 파이프라인 (mock provider)');
  await test('아이디어 → 최종 원고까지 완주한다', async () => {
    const cfg = loadConfig({ llm: { provider: 'mock' } });
    cfg.workspaceRoot = path.join(tmp, 'run');
    cfg.sessionStateRoot = path.join(tmp, 'run', 'session_state');
    const logger = new Logger({ quiet: true });
    const orch = new Orchestrator({
      cfg, logger,
      brief: { idea: '기억을 파는 소년', preset: 'webnovel', chapters: 2, targetChars: 1200, passScore: 82, research: true },
    });
    const s = await orch.run();

    assert.ok(fs.existsSync(path.join(s.project_dir, 'MANUSCRIPT.md')), '최종 원고 없음');
    assert.strictEqual(s.chapters.length, 2);
    assert.ok(s.chapters.every((c) => c.finalScore >= 0), '점수 미기록');
    assert.ok(s.bus.total > 20, `버스 이벤트 부족: ${s.bus.total}`);
    assert.strictEqual(s.bus.dlq, 0, 'DLQ 에 빠진 메시지가 있음');
    assert.ok(fs.existsSync(path.join(s.project_dir, 'canon', 'world.json')));
    assert.ok(fs.existsSync(path.join(s.project_dir, 'reports', 'pm-final.json')));
    assert.ok(fs.existsSync(path.join(s.project_dir, 'session_state', 'latest_summary.json')));

    const manuscript = fs.readFileSync(path.join(s.project_dir, 'MANUSCRIPT.md'), 'utf8');
    assert.ok(!manuscript.includes('HANDOFF_EVENT'), '원고에 핸드오프 블록이 섞여 있음');
    assert.ok(manuscript.length > 800, '원고가 비어 있음');
  });

  await test('영지 경영물 프리셋으로 전면 퇴고까지 수행한다', async () => {
    const cfg = loadConfig({ llm: { provider: 'mock' } });
    cfg.workspaceRoot = path.join(tmp, 'estate');
    cfg.sessionStateRoot = path.join(tmp, 'estate', 'session_state');
    const logger = new Logger({ quiet: true });
    const orch = new Orchestrator({
      cfg, logger,
      brief: { idea: '몰락한 변방 영지를 물려받은 전생자', preset: 'estate', chapters: 3, targetChars: 1200, passScore: 81, research: false },
    });
    const s = await orch.run();

    assert.ok(s.polish, '퇴고 리포트가 없음');
    assert.ok(s.polish.touched_chapters.length >= 1, '퇴고 대상 회차가 지정되지 않음');
    assert.ok(fs.existsSync(path.join(s.project_dir, 'reports', 'polish-diagnosis.json')), '퇴고 진단서 없음');

    const diag = JSON.parse(fs.readFileSync(path.join(s.project_dir, 'reports', 'polish-diagnosis.json'), 'utf8'));
    assert.ok(diag.overall_read, '통독 인상이 비어 있음');
    assert.ok(Array.isArray(diag.unresolved_foreshadow), '미회수 복선 추적 누락');
    for (const d of diag.chapter_directives) {
      assert.ok(Array.isArray(d.keep), `${d.no}화 퇴고 지시에 keep 이 없음 — 장점이 지워질 위험`);
    }
    // 퇴고본이 백업을 남기고 덮어썼는지
    assert.ok(fs.existsSync(path.join(s.project_dir, '.cache', 'backups')), '퇴고 전 백업이 없음');
  });

  await test('재개(resume) 시 완료 단계를 건너뛴다', async () => {
    const cfg = loadConfig({ llm: { provider: 'mock' } });
    cfg.workspaceRoot = path.join(tmp, 'run2');
    cfg.sessionStateRoot = path.join(tmp, 'run2', 'session_state');
    const logger = new Logger({ quiet: true });
    const brief = { idea: '재개 테스트', preset: 'webnovel', chapters: 1, targetChars: 800, passScore: 82, research: false };

    const first = new Orchestrator({ cfg, logger, brief });
    const s1 = await first.run();
    const callsAfterFirst = s1.usage.calls;

    const second = new Orchestrator({ cfg, logger, brief, projectId: s1.project_id, resume: true });
    const s2 = await second.run();
    assert.ok(s2.usage.calls < callsAfterFirst, `재개가 작업을 건너뛰지 못함 (${s2.usage.calls} vs ${callsAfterFirst})`);
  });

  console.log(`\n${process.exitCode ? '실패 있음' : `전체 통과 (${passed}건)`}\n`);
  fs.rmSync(tmp, { recursive: true, force: true });
})();
