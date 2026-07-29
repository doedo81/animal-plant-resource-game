'use strict';
/**
 * PM 오케스트레이터 — 조직 전체를 굴리는 상위 루프.
 *
 * 릴레이 구조:
 *   HUMAN → PM → 팀장 → 팀원 → (버스) → 팀장 게이트 → PM → 다음 팀장 …
 *
 * 팀장(LEAD_*)은 LLM 호출 없이 동작한다. 팀장의 실제 업무는
 *   (a) 과제 배분  (b) 수용 기준 게이트 검사  (c) 상급 보고
 * 세 가지이며, 이는 결정론적 코드로 구현하는 편이 더 정확하고 싸다.
 * 창작·판단이 필요한 지점(팀원, 그리고 최종 승인하는 PM)만 모델을 쓴다.
 */
const path = require('path');
const { Bus } = require('./bus');
const { Guard } = require('./guard');
const { LLM } = require('./llm');
const { ContextManager } = require('./context');
const { AgentRunner } = require('./agent');
const { loadRoles, loadGenres } = require('./roles');
const { makeHandoff } = require('./schema');
const { newId, nowIso, ensureDir, writeJson, readJson, pad, countChars, truncate } = require('./util');

class Orchestrator {
  constructor({ cfg, logger, brief, projectId = null, resume = false }) {
    this.cfg = cfg;
    this.logger = logger;
    this.brief = brief;
    this.registry = loadRoles();
    this.genres = loadGenres();
    this.genre = this.genres[brief.preset] || this.genres.webnovel;

    this.projectId = projectId || newId('prj');
    this.projectDir = path.join(path.resolve(cfg.workspaceRoot), this.projectId);
    ensureDir(this.projectDir);

    this.guard = new Guard(this.projectDir, cfg.guard, logger);
    this.bus = new Bus(path.join(this.projectDir, 'bus'), { maxAttempts: cfg.bus.maxAttempts, logger });
    this.ctx = new ContextManager({
      cfg: cfg.context,
      projectDir: this.projectDir,
      sessionStateRoot: path.resolve(cfg.sessionStateRoot),
      logger,
      projectId: this.projectId,
    });

    this.llm = new LLM(cfg.llm, {
      logger,
      budget: cfg.budget,
      archive: (label, payload) => {
        const safe = String(label).replace(/[^\w.#:-]/g, '_');
        try {
          this.guard.write(`.cache/calls/${Date.now()}-${safe}.txt`,
            `### SYSTEM\n${payload.system}\n\n### USER\n${payload.user}\n\n### OUTPUT\n${payload.output}\n`);
        } catch { /* 아카이브 실패는 본 작업을 막지 않는다 */ }
      },
    });

    this.canon = {
      research: null, world: null, characters: null, synopsis: null, outline: null,
      established_facts: [], open_threads: [],
    };

    this.runner = new AgentRunner({
      registry: this.registry,
      genre: this.genre,
      llm: this.llm,
      bus: this.bus,
      guard: this.guard,
      ctx: this.ctx,
      logger,
      traceId: this.projectId,
      canon: () => this.canonSummary(),
    });

    this.stateFile = path.join(this.projectDir, 'state.json');
    this.state = resume ? (readJson(this.stateFile) || this._blankState()) : this._blankState();
    this.report = { chapters: [], escalations: [], violations: [] };
  }

  _blankState() {
    return {
      project_id: this.projectId,
      created_at: nowIso(),
      brief: this.brief,
      completed: {},
      chapters: {},
    };
  }

  _save() {
    writeJson(this.stateFile, { ...this.state, updated_at: nowIso() });
  }

  /** 모든 팀원 프롬프트에 주입되는 캐논 요약 — 장편에서 설정이 무너지는 것을 막는 핵심 */
  canonSummary() {
    const c = this.canon;
    const lines = [];
    if (c.world?.world) {
      const w = c.world.world;
      lines.push(`- 세계: ${w.name || '-'} / ${truncate(w.premise || '', 200)}`);
      if (w.magic_system) {
        lines.push(`- 체계: ${w.magic_system.name || '-'} — 규칙: ${truncate(w.magic_system.rule || '', 160)}`);
        lines.push(`- 대가/한계: ${truncate(String(w.magic_system.cost || ''), 100)} / ${(w.magic_system.limits || []).join('; ')}`);
      }
      if (w.factions) lines.push(`- 세력: ${(w.factions || []).map((f) => f.name).join(', ')}`);
    }
    if (c.characters?.characters) {
      for (const ch of c.characters.characters.slice(0, 8)) {
        lines.push(`- 인물 ${ch.name}(${ch.role}): 목표=${ch.goal} / 결함=${ch.flaw} / 화술=${truncate(ch.voice || '', 60)}`);
      }
    }
    if (c.synopsis?.logline) lines.push(`- 로그라인: ${c.synopsis.logline}`);
    if (c.research?.constraints) lines.push(`- 창작 제약: ${(c.research.constraints || []).join(' / ')}`);
    if (c.established_facts.length) lines.push(`- 확정 사실: ${c.established_facts.slice(-12).join(' / ')}`);
    if (c.open_threads.length) lines.push(`- 미회수 복선: ${c.open_threads.slice(-8).join(' / ')}`);
    return lines.join('\n');
  }

  /** 팀장 라우팅 이벤트 — 실제 배분이 버스 원장에 남는다 */
  _route(from, to, summary, nextAction, payload = '') {
    this.bus.publish(makeHandoff({
      trace_id: this.projectId, sender: from, receiver: to,
      status: 'IN_PROGRESS', summary, next_action: nextAction, data_payload_path: payload || '-',
    }));
  }

  /**
   * 팀장 수용 기준 게이트.
   * @returns {{ok:boolean, reasons:string[]}}
   */
  _gate(roleCode, result) {
    const d = result.data;
    const reasons = [];
    switch (roleCode) {
      case 'RESEARCHER':
        if (!(d?.findings?.length >= 1)) reasons.push('검증 가능한 조사 결과가 없음');
        if (!(d?.constraints?.length >= 1)) reasons.push('창작 제약이 도출되지 않음');
        break;
      case 'WORLDBUILDER': {
        const ms = d?.world?.magic_system;
        if (!d?.world?.name) reasons.push('세계 이름 없음');
        if (ms && !ms.cost && !ms.limits) reasons.push('체계에 비용/한계가 없음 (만능 설정 반려)');
        if (!(d?.world?.factions?.length >= 2)) reasons.push('세력이 2개 미만 — 갈등 구조 부족');
        break;
      }
      case 'CHARACTER_DESIGNER': {
        const chars = d?.characters || [];
        if (chars.length < 2) reasons.push('주요 인물 2인 미만');
        for (const c of chars) {
          if (!c.goal || !c.flaw) reasons.push(`인물 ${c.name || '?'} 의 목표/결함 누락`);
        }
        break;
      }
      case 'SYNOPSIS_WRITER':
        if (!d?.logline) reasons.push('로그라인 없음');
        if (!d?.ending_direction) reasons.push('결말 방향 없음');
        break;
      case 'OUTLINER':
        if (!(d?.chapters?.length >= 1)) reasons.push('회차 구성이 비어 있음');
        break;
      case 'WRITER_1':
      case 'WRITER_2': {
        const chars = countChars(result.text);
        if (chars < 300) reasons.push(`본문이 너무 짧음 (${chars}자) — 요약본을 제출한 것으로 판단`);
        break;
      }
      case 'CRITIC':
        if (typeof d?.total !== 'number') reasons.push('총점이 숫자가 아님');
        break;
      default: break;
    }
    return { ok: reasons.length === 0, reasons };
  }

  /** 팀원 실행 + 팀장 게이트. 게이트 탈락 시 1회 재시도(사유 피드백 포함). */
  async _delegate(roleCode, opts) {
    const role = this.registry[roleCode];
    const leader = role.team;
    this._route('PM', leader, `${roleCode} 과제 배분`, opts.task, opts.outFile);
    this._route(leader, roleCode, `${leader} → ${roleCode} 세부 과제 지시`, opts.task, opts.outFile);

    this.bus.drain(leader, 'PM 지시 수령');

    let result = await this.runner.run(roleCode, opts);
    this.bus.drain(roleCode, '팀원이 지시를 수행함');
    let gate = this._gate(roleCode, result);

    if (!gate.ok) {
      this.logger.warn(`GATE ▸ ${leader} 가 ${roleCode} 산출물 반려: ${gate.reasons.join(' / ')}`);
      this.bus.publish(makeHandoff({
        trace_id: this.projectId, sender: leader, receiver: roleCode, status: 'ERROR',
        summary: `수용 기준 미달로 반려: ${gate.reasons.join(' / ')}`,
        next_action: '반려 사유를 모두 해소해 재제출하라.',
        data_payload_path: opts.outFile,
      }));
      result = await this.runner.run(roleCode, {
        ...opts,
        task: `${opts.task}\n\n### 재작업 사유 (반드시 해소)\n- ${gate.reasons.join('\n- ')}`,
      });
      this.bus.drain(roleCode, '반려 후 재제출 완료');
      gate = this._gate(roleCode, result);
      if (!gate.ok) {
        this.report.escalations.push({ role: roleCode, reasons: gate.reasons, stage: opts.stageKey });
        this.logger.error(`GATE ▸ ${roleCode} 재제출도 미달 — 기록 후 진행: ${gate.reasons.join(' / ')}`);
      }
    }

    this._route(leader, 'PM', `${roleCode} 산출물 검수 완료`, '다음 단계 진행', result.path);
    this.bus.drain('PM', '보고 수령 후 다음 단계 진행');
    this._checkpoint(opts.stageKey);
    return result;
  }

  _checkpoint(stage) {
    const res = this.ctx.checkpoint(() => ({
      stage,
      completed: Object.keys(this.state.completed),
      remaining: this._remainingStages(),
      canon_paths: ['canon/world.json', 'canon/characters.json', 'canon/synopsis.json', 'canon/outline.json'],
      chapters: this.state.chapters,
      last_handoff: this.bus.tail(1)[0] || null,
    }));
    if (res.reset) {
      this.logger.info('세션 재개 — 저장된 체크포인트로 컨텍스트를 재구성합니다.');
    }
    return res;
  }

  _remainingStages() {
    const all = ['research', 'world', 'characters', 'synopsis', 'outline', 'chapters', 'final'];
    return all.filter((s) => !this.state.completed[s]);
  }

  /** 캐논 산출물을 다시 읽어 메모리에 복원 (resume 시) */
  _rehydrate() {
    this.canon.research = readJson(path.join(this.projectDir, 'canon/research.json'), null);
    this.canon.world = readJson(path.join(this.projectDir, 'canon/world.json'), null);
    this.canon.characters = readJson(path.join(this.projectDir, 'canon/characters.json'), null);
    this.canon.synopsis = readJson(path.join(this.projectDir, 'canon/synopsis.json'), null);
    this.canon.outline = readJson(path.join(this.projectDir, 'canon/outline.json'), null);
  }

  async run() {
    const b = this.brief;
    const t0 = Date.now();
    this.logger.stage(`프로젝트 시작: ${this.projectId} / 장르=${this.genre.label} / 회차=${b.chapters}`);
    this._rehydrate();

    this.bus.publish(makeHandoff({
      trace_id: this.projectId, sender: 'HUMAN', receiver: 'PM', status: 'COMPLETE',
      summary: `아이디어 접수: ${b.idea}`,
      next_action: `${this.genre.label} 형식으로 ${b.chapters}회차 제작하라.`,
      data_payload_path: 'brief.json',
    }));
    this.guard.writeJson('brief.json', b);

    // ── 1. 리서치 ────────────────────────────────────────────
    if (!this.state.completed.research && b.research !== false) {
      this.logger.stage('1단계 · 리서치 (LEAD_RESEARCH)');
      const r = await this._delegate('RESEARCHER', {
        stageKey: 'research',
        task: `아이디어 "${b.idea}" 를 ${this.genre.label} 로 집필하기 위한 배경 조사를 수행하라. 시대·기술·경제·풍습 축으로 조사하고 창작 제약으로 번역하라.`,
        inputs: { 아이디어: b.idea, 추가지침: b.notes },
        meta: { idea: b.idea },
        outFile: 'canon/research.json',
      });
      this.canon.research = r.data;
      this.state.completed.research = r.path; this._save();
      this.logger.ok(`리서치 완료 → ${r.path}`);
    } else if (this.state.completed.research) {
      this.logger.ok('리서치 단계 건너뜀 (이미 완료)');
    }

    // ── 2. 세계관 ────────────────────────────────────────────
    if (!this.state.completed.world) {
      this.logger.stage('2단계 · 세계관 설계 (LEAD_STORY)');
      const r = await this._delegate('WORLDBUILDER', {
        stageKey: 'world',
        task: `아이디어 "${b.idea}" 를 담을 세계를 설계하라. 마법/기술 체계에는 반드시 비용과 한계를 넣어라.`,
        inputs: { 아이디어: b.idea, 리서치: this.canon.research, 추가지침: b.notes },
        meta: { idea: b.idea },
        outFile: 'canon/world.json',
      });
      this.canon.world = r.data;
      this.state.completed.world = r.path; this._save();
      this.logger.ok(`세계관 완료 → ${r.path}`);
    }

    // ── 3. 인물 ──────────────────────────────────────────────
    if (!this.state.completed.characters) {
      this.logger.stage('3단계 · 인물 설계 (LEAD_STORY)');
      const r = await this._delegate('CHARACTER_DESIGNER', {
        stageKey: 'characters',
        task: '세계관 위에서 충돌을 만들 인물들을 설계하라. 주인공과 적대자는 같은 자원을 두고 충돌해야 한다.',
        inputs: { 아이디어: b.idea, 세계관: this.canon.world },
        meta: { idea: b.idea },
        outFile: 'canon/characters.json',
      });
      this.canon.characters = r.data;
      this.state.completed.characters = r.path; this._save();
      this.logger.ok(`인물 완료 → ${r.path}`);
    }

    // ── 4. 시놉시스 ──────────────────────────────────────────
    if (!this.state.completed.synopsis) {
      this.logger.stage('4단계 · 시놉시스 (LEAD_STORY)');
      const r = await this._delegate('SYNOPSIS_WRITER', {
        stageKey: 'synopsis',
        task: '세계관과 인물을 하나의 이야기 줄기로 묶어라. 주인공이 마지막에 잃는 것을 반드시 정하라.',
        inputs: { 아이디어: b.idea, 세계관: this.canon.world, 인물: this.canon.characters },
        meta: { idea: b.idea },
        outFile: 'canon/synopsis.json',
      });
      this.canon.synopsis = r.data;
      this.state.completed.synopsis = r.path; this._save();
      this.logger.ok(`시놉시스 완료 → ${r.path}`);
    }

    // ── 5. 아웃라인 ──────────────────────────────────────────
    if (!this.state.completed.outline) {
      this.logger.stage('5단계 · 회차 구성 (LEAD_STORY → LEAD_WRITING)');
      const r = await this._delegate('OUTLINER', {
        stageKey: 'outline',
        task: `시놉시스를 ${b.chapters}개 회차로 분할하라. 회차당 목표 분량은 공백 제외 ${b.targetChars}자다.`,
        inputs: { 시놉시스: this.canon.synopsis, 인물: this.canon.characters, 세계관: this.canon.world },
        meta: { idea: b.idea, chapters: b.chapters, targetChars: b.targetChars },
        outFile: 'canon/outline.json',
      });
      this.canon.outline = r.data;
      this.state.completed.outline = r.path; this._save();
      this.logger.ok(`아웃라인 완료 → ${r.path} (${r.data?.chapters?.length || 0}회차)`);
    }

    // ── 6. 회차별 집필 루프 ──────────────────────────────────
    const chapters = (this.canon.outline?.chapters || []).slice(0, b.chapters);
    for (const ch of chapters) {
      const key = `ch${pad(ch.no)}`;
      if (this.state.chapters[key]?.final) {
        this.logger.ok(`${key} 건너뜀 (이미 완료)`);
        this.report.chapters.push(this.state.chapters[key]);
        continue;
      }
      const chReport = await this._writeChapter(ch, key);
      this.state.chapters[key] = chReport;
      this.report.chapters.push(chReport);
      this._save();
    }
    this.state.completed.chapters = true; this._save();

    // ── 7. 최종 조립 + PM 승인 ───────────────────────────────
    const manuscriptPath = this._assemble(chapters);
    this.logger.stage('7단계 · PM 최종 승인');
    this._route('LEAD_WRITING', 'PM', '전 회차 최종고 취합 완료', '최종 승인 판정 요청', manuscriptPath);
    this.bus.drain('PM', '최종 승인 심사 착수');

    const pmResult = await this.runner.run('PM', {
      stageKey: 'final',
      task: '전 회차 결과를 검수하고 승인 여부를 판정하라. 남은 위험과 다음 단계를 명시하라.',
      inputs: {
        브리프: b,
        회차별_점수: this.report.chapters.map((c) => ({ no: c.no, title: c.title, score: c.finalScore, revisions: c.revisions, chars: c.chars })),
        에스컬레이션: this.report.escalations,
        캐논: this.canonSummary(),
      },
      meta: { idea: b.idea, receiver: 'HUMAN' },
      receiver: 'HUMAN',
      outFile: 'reports/pm-final.json',
    });

    this.state.completed.final = pmResult.path; this._save();

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const summary = {
      project_id: this.projectId,
      project_dir: this.projectDir,
      manuscript: manuscriptPath,
      pm_report: pmResult.path,
      chapters: this.report.chapters,
      escalations: this.report.escalations,
      compliance_violations: this.runner.violations,
      bus: this.bus.stats(),
      usage: this.llm.usage,
      context: { resets: this.ctx.resets, ratio: Number(this.ctx.ratio.toFixed(3)) },
      elapsed_sec: Number(elapsed),
    };
    this.guard.writeJson('reports/run-summary.json', summary);
    this.ctx.snapshot({ stage: 'DONE', completed: Object.keys(this.state.completed), remaining: [], summary });
    return summary;
  }

  /** 한 회차: 작가1 → 검토 → 비평 → (개고 루프) → 연속성 → 윤문 */
  async _writeChapter(ch, key) {
    const b = this.brief;
    const passScore = b.passScore ?? this.cfg.quality.passScore;
    const maxRev = this.cfg.quality.maxRevisions;
    this.logger.stage(`6단계 · 제${ch.no}화 「${ch.title}」 집필 (LEAD_WRITING ↔ LEAD_QA)`);

    const chMeta = { idea: b.idea, chapterNo: ch.no, chapterTitle: ch.title, targetChars: ch.target_chars || b.targetChars };

    // 초고
    let draft = await this._delegate('WRITER_1', {
      stageKey: `${key}:draft`,
      task: `아웃라인에 따라 제${ch.no}화 「${ch.title}」 초고를 집필하라. 목표 분량 공백 제외 ${chMeta.targetChars}자.`,
      inputs: { 회차_아웃라인: ch, 인물: this.canon.characters, 세계관_요약: this.canonSummary(), 직전_회차_요약: this._prevSummary(ch.no) },
      meta: { ...chMeta, revision: 0 },
      outFile: `chapters/${key}.draft1.md`,
      receiver: 'REVIEWER',
    });

    let bestText = draft.text;
    let bestScore = -1;
    let revisions = 0;
    let prevScore = -1;
    let escalated = false;

    for (let round = 0; round <= maxRev; round++) {
      // 검토
      const review = await this._delegate('REVIEWER', {
        stageKey: `${key}:review${round}`,
        task: `제${ch.no}화 원고를 체크리스트로 검토하라. 목표 분량은 ${chMeta.targetChars}자다.`,
        inputs: { 원고: bestText === draft.text ? draft.text : bestText, 회차_아웃라인: ch, 캐논: this.canonSummary() },
        meta: { ...chMeta, revision: round },
        outFile: `chapters/${key}.review${round}.json`,
        receiver: 'CRITIC',
      });

      // 비평 (정량 채점)
      const critique = await this._delegate('CRITIC', {
        stageKey: `${key}:critique${round}`,
        task: `제${ch.no}화를 6개 축으로 채점하라. 통과선은 ${passScore}점이다.`,
        inputs: { 원고: bestText, 검토결과: review.data, 회차_아웃라인: ch },
        meta: { ...chMeta, revision: round },
        outFile: `chapters/${key}.critique${round}.json`,
        receiver: 'WRITER_2',
      });

      const total = Number(critique.data?.total ?? 0);
      if (total > bestScore) bestScore = total;
      this.logger.info(`  ▸ 라운드 ${round}: 총점 ${total} / 통과선 ${passScore} / 판정 ${critique.data?.verdict}`);

      if (total >= passScore || critique.data?.verdict === 'PASS') {
        // 통과했으므로 개고 지시는 소비되지 않는다. 미결로 남기지 않고 명시적으로 닫는다.
        this.bus.drain('WRITER_2', 'PASS 판정 — 개고 불필요');
        break;
      }

      if (round === maxRev) {
        escalated = true;
        this.report.escalations.push({
          chapter: ch.no, reason: `개고 ${maxRev}회 후에도 통과선 미달 (최고 ${bestScore}점)`, action: 'NEEDS_HUMAN',
        });
        this.bus.publish(makeHandoff({
          trace_id: this.projectId, sender: 'LEAD_QA', receiver: 'PM', status: 'NEEDS_HUMAN',
          summary: `제${ch.no}화 품질 정체 — 최고 ${bestScore}점 (통과선 ${passScore})`,
          next_action: '사용자 판단 필요: 통과선 조정 또는 방향 재지시',
          data_payload_path: `chapters/${key}.draft${revisions + 1}.md`,
        }));
        break;
      }

      // 개선 정체 감지 — 무한 굴레 차단
      if (prevScore >= 0 && total - prevScore < this.cfg.quality.minImprovementDelta) {
        escalated = true;
        this.report.escalations.push({
          chapter: ch.no, reason: `점수 개선 정체 (${prevScore} → ${total}, 임계 ${this.cfg.quality.minImprovementDelta})`, action: 'STOP_REVISION',
        });
        this.logger.warn(`  ▸ 개선 정체로 개고 중단 (${prevScore} → ${total})`);
        break;
      }
      prevScore = total;

      // 개고
      revisions += 1;
      const rewrite = await this._delegate('WRITER_2', {
        stageKey: `${key}:rewrite${revisions}`,
        task: `제${ch.no}화를 개고하라. must_fix 를 전부 반영하고 keep 은 건드리지 마라.`,
        inputs: { 원고: bestText, 검토_이슈: review.data?.issues, 비평: critique.data, 회차_아웃라인: ch },
        meta: { ...chMeta, revision: revisions },
        outFile: `chapters/${key}.draft${revisions + 1}.md`,
        receiver: 'CRITIC',
      });
      bestText = rewrite.text;
    }

    // 연속성 점검
    const cont = await this._delegate('CONTINUITY_KEEPER', {
      stageKey: `${key}:continuity`,
      task: `제${ch.no}화가 기존 캐논과 모순되지 않는지 점검하고 캐논을 갱신하라.`,
      inputs: { 원고: bestText, 캐논: this.canonSummary(), 기확정_사실: this.canon.established_facts, 미회수_복선: this.canon.open_threads },
      meta: chMeta,
      outFile: `canon/continuity.${key}.json`,
      receiver: 'PM',
    });
    const upd = cont.data?.canon_updates || {};
    this.canon.established_facts.push(...(upd.established_facts || []));
    this.canon.open_threads = upd.open_threads || this.canon.open_threads;
    if (cont.data?.ok === false) {
      this.report.escalations.push({ chapter: ch.no, reason: '연속성 충돌 발견', detail: cont.data.conflicts });
    }

    // 윤문
    const final = await this._delegate('EDITOR', {
      stageKey: `${key}:edit`,
      task: `제${ch.no}화를 납품 품질로 윤문하라. 사건과 설정은 바꾸지 마라.`,
      inputs: { 원고: bestText },
      meta: { ...chMeta, sourceText: bestText },
      outFile: `chapters/${key}.final.md`,
      receiver: 'PM',
    });

    return {
      no: ch.no, title: ch.title, key,
      finalScore: bestScore, revisions, escalated,
      chars: countChars(final.text),
      path: final.path,
      continuity_ok: cont.data?.ok !== false,
    };
  }

  _prevSummary(no) {
    if (no <= 1) return '';
    const prev = this.state.chapters[`ch${pad(no - 1)}`];
    if (!prev) return '';
    const text = this.guard.read(prev.path, '');
    return truncate(text, 1500);
  }

  _assemble(chapters) {
    const title = this.canon.synopsis?.logline ? this.brief.idea : this.brief.idea;
    const parts = [
      `# ${this.canon.world?.world?.name || '무제'} — ${this.brief.idea}`,
      '',
      `> ${this.canon.synopsis?.logline || ''}`,
      '',
      `- 장르: ${this.genre.label}`,
      `- 회차: ${chapters.length}`,
      `- 생성: ${nowIso()}`,
      '',
      '---',
      '',
    ];
    for (const ch of chapters) {
      const key = `ch${pad(ch.no)}`;
      const body = this.guard.read(`chapters/${key}.final.md`, '') || this.guard.read(`chapters/${key}.draft1.md`, '');
      parts.push(body.trim(), '', '---', '');
    }
    this.guard.write('MANUSCRIPT.md', parts.join('\n'));
    this.logger.ok(`최종 원고 조립 완료 → MANUSCRIPT.md`);
    void title;
    return 'MANUSCRIPT.md';
  }
}

module.exports = { Orchestrator };
