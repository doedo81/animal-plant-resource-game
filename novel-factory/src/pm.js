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
const { makeHandoff, ACTORS } = require('./schema');
const { newId, nowIso, ensureDir, writeJson, readJson, pad, countChars, truncate } = require('./util');

class Orchestrator {
  constructor({ cfg, logger, brief, projectId = null, resume = false }) {
    this.cfg = cfg;
    this.logger = logger;
    this.brief = brief;
    this.registry = loadRoles();
    this.genres = loadGenres();
    this.genre = this.genres[brief.preset] || this.genres.webnovel;
    // 이 프로젝트를 총괄하는 장르 스튜디오 팀장. 산하 기능 팀(스토리/집필/품질/리서치)을
    // 조직하는 주체이며, 사용자(HUMAN)는 이 팀장의 최종 보고만 받는다.
    this.studio = ACTORS.includes(this.genre.studio) ? this.genre.studio : 'STUDIO_LEAD';

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
      research: null, trend: null, style: null,
      world: null, characters: null, synopsis: null, outline: null,
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
    if (c.trend) {
      const t = c.trend;
      if (t.winning_codes?.length) lines.push(`- 흥행 코드: ${t.winning_codes.map((w) => w.how_to_apply || w.code).join(' / ')}`);
      if (t.avoid_list?.length) lines.push(`- 회피(구식): ${t.avoid_list.join(' / ')}`);
      if (t.differentiation?.length) lines.push(`- 차별화 지점: ${t.differentiation.join(' / ')}`);
    }
    if (c.style?.style_sheet) {
      const s = c.style.style_sheet;
      lines.push('- 문체 시트 (전 집필 역할 준수):');
      lines.push(`  · 문장: 평균 ${s.sentence?.avg_chars || '-'}자, 리듬 ${s.sentence?.rhythm || '-'}`);
      lines.push(`  · 문단: ${s.paragraph?.lines || '-'} / ${s.paragraph?.open_with || '-'}(으)로 열기`);
      lines.push(`  · 은유: ${s.metaphor?.density || '-'} (${s.metaphor?.source || '-'})`);
      lines.push(`  · 대사: ${s.dialogue?.ratio || '-'}, ${s.dialogue?.tag_rule || '-'}`);
      lines.push(`  · 감정: ${s.emotion || '-'}`);
      if (s.signature_device) lines.push(`  · 반복 장치: ${s.signature_device}`);
      if (s.forbidden_words?.length) lines.push(`  · 금지어: ${s.forbidden_words.join(', ')}`);
      if (c.style.ai_tells_to_avoid?.length) {
        lines.push(`  · AI 문체 금지: ${c.style.ai_tells_to_avoid.join(' / ')}`);
      }
      for (const v of (c.style.character_voices || []).slice(0, 6)) {
        lines.push(`  · 목소리 ${v.name}: ${[v.sentence_len, v.ending, v.habit].filter(Boolean).join(', ')} (회피: ${v.avoid || '-'})`);
      }
      if (c.style.sample_paragraph) lines.push(`  · 기준 예시: ${truncate(c.style.sample_paragraph, 400)}`);
    }
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
      case 'TREND_ANALYST':
        if (!(d?.winning_codes?.length >= 1)) reasons.push('흥행 코드가 도출되지 않음');
        if (!(d?.differentiation?.length >= 1)) reasons.push('차별화 지점 없음 — 트렌드 복제는 반려');
        for (const w of (d?.winning_codes || [])) {
          if (!w.how_to_apply) reasons.push(`흥행 코드 "${w.code || '?'}" 에 작가 실행 문장이 없음`);
        }
        break;
      case 'STYLE_ARCHITECT': {
        const s = d?.style_sheet;
        if (!s) reasons.push('문체 시트 없음');
        if (s && !s.sentence?.avg_chars) reasons.push('문장 길이가 수치로 지정되지 않음 (형용사 문체는 반려)');
        if (!(d?.ai_tells_to_avoid?.length >= 3)) reasons.push('AI 문체 금지 목록이 3개 미만');
        if (!d?.sample_paragraph) reasons.push('기준 예시 문단 없음');
        break;
      }
      case 'POLISHER':
        if (!Array.isArray(d?.chapter_directives)) reasons.push('회차별 퇴고 지시가 배열이 아님');
        for (const dir of (d?.chapter_directives || [])) {
          if (!Array.isArray(dir.keep)) reasons.push(`${dir.no}화 지시에 keep 누락 — 장점이 지워질 위험`);
        }
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
    this._route(this.studio, leader, `${roleCode} 과제 배분`, opts.task, opts.outFile);
    this._route(leader, roleCode, `${leader} → ${roleCode} 세부 과제 지시`, opts.task, opts.outFile);

    this.bus.drain(leader, '스튜디오 팀장 지시 수령');

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

    this._route(leader, this.studio, `${roleCode} 산출물 검수 완료`, '다음 단계 진행', result.path);
    this.bus.drain(this.studio, '보고 수령 후 다음 단계 진행');
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
    const all = ['research', 'trend', 'world', 'characters', 'synopsis', 'style', 'outline', 'chapters', 'polish', 'final'];
    return all.filter((s) => !this.state.completed[s]);
  }

  /** 캐논 산출물을 다시 읽어 메모리에 복원 (resume 시) */
  _rehydrate() {
    this.canon.research = readJson(path.join(this.projectDir, 'canon/research.json'), null);
    this.canon.trend = readJson(path.join(this.projectDir, 'canon/trend.json'), null);
    this.canon.style = readJson(path.join(this.projectDir, 'canon/style.json'), null);
    this.canon.world = readJson(path.join(this.projectDir, 'canon/world.json'), null);
    this.canon.characters = readJson(path.join(this.projectDir, 'canon/characters.json'), null);
    this.canon.synopsis = readJson(path.join(this.projectDir, 'canon/synopsis.json'), null);
    this.canon.outline = readJson(path.join(this.projectDir, 'canon/outline.json'), null);
  }

  async run() {
    const b = this.brief;
    const t0 = Date.now();
    this.logger.stage(`프로젝트 시작: ${this.projectId} / 담당 팀장=${this.studio} (${this.genre.label}) / 회차=${b.chapters}`);
    this._rehydrate();

    this.bus.publish(makeHandoff({
      trace_id: this.projectId, sender: 'HUMAN', receiver: this.studio, status: 'COMPLETE',
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

    // ── 1.5 트렌드 분석 ──────────────────────────────────────
    // 본문 크롤링은 하지 않는다. 사용자가 합법적으로 모은 공개 메타데이터(--trend 파일)를
    // 넣으면 그걸 분석하고, 없으면 모델 내재 지식으로 추정하되 그 사실을 명시하게 한다.
    if (!this.state.completed.trend && b.trend) {
      this.logger.stage('1.5단계 · 트렌드 분석 (LEAD_RESEARCH)');
      const observed = b.trendData
        ? truncate(b.trendData, 20000)
        : '(관측 자료 없음 — 내재 지식으로 추정하고 knowledge_cutoff_warning 에 명시할 것)';
      const r = await this._delegate('TREND_ANALYST', {
        stageKey: 'trend',
        task: `${this.genre.label} 시장의 현재 트렌드를 분석해 창작 규약으로 번역하라. 흥행 코드를 그대로 복제하지 말고 비틀 지점을 반드시 제안하라.`,
        inputs: { 아이디어: b.idea, 관측_자료: observed, 장르: this.genre.label },
        meta: { idea: b.idea, hasData: !!b.trendData },
        outFile: 'canon/trend.json',
      });
      this.canon.trend = r.data;
      this.state.completed.trend = r.path; this._save();
      if (r.data?.knowledge_cutoff_warning) {
        this.logger.warn(`트렌드 분석 주의: ${r.data.knowledge_cutoff_warning}`);
        this.report.escalations.push({ stage: 'trend', reason: '최신 관측 자료 없이 내재 지식으로 추정됨', action: 'REVIEW_RECOMMENDED' });
      }
      this.logger.ok(`트렌드 분석 완료 → ${r.path}`);
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

    // ── 4.5 문체 설계 ────────────────────────────────────────
    // 회차마다 다른 사람이 쓴 것처럼 읽히는 것이 AI 티가 나는 가장 큰 이유다.
    // 여기서 만든 문체 시트가 캐논에 실려 작가1·작가2·윤문 전부에게 매 호출 주입된다.
    if (!this.state.completed.style) {
      this.logger.stage('4.5단계 · 문체 설계 (LEAD_WRITING)');
      const r = await this._delegate('STYLE_ARCHITECT', {
        stageKey: 'style',
        task: '이 작품만의 문체 시트를 만들어라. 형용사가 아니라 검토자가 위반을 셀 수 있는 수치와 규칙으로 쓰고, AI 문체 습관 금지 목록과 기준 예시 문단을 반드시 포함하라.',
        inputs: {
          아이디어: b.idea,
          시놉시스: this.canon.synopsis,
          인물: this.canon.characters,
          사용자_문체_지시: b.style || '(지정 없음 — 작품에 맞게 스스로 설계하라)',
          트렌드_규약: this.canon.trend?.reader_contract,
        },
        meta: { idea: b.idea, styleHint: b.style },
        outFile: 'canon/style.json',
      });
      this.canon.style = r.data;
      this.state.completed.style = r.path; this._save();
      this.logger.ok(`문체 시트 확정 → ${r.path} (${r.data?.style_sheet?.name || '무명'})`);
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

    // ── 7. 전면 퇴고 ─────────────────────────────────────────
    // 회차별 검토는 회차 안에서만 본다. 전체를 한 덩어리로 읽어야 보이는 것을 여기서 잡는다.
    if (this.cfg.quality.polishPass !== false && !this.state.completed.polish) {
      await this._polishPass(chapters);
      this.state.completed.polish = true; this._save();
    }

    // ── 8. 최종 조립 + PM 승인 ───────────────────────────────
    const manuscriptPath = this._assemble(chapters);
    this.logger.stage(`8단계 · ${this.studio} 최종 검수 및 보고`);
    this._route('LEAD_WRITING', this.studio, '전 회차 최종고 취합 완료', '최종 승인 판정 요청', manuscriptPath);
    this.bus.drain(this.studio, '최종 승인 심사 착수');

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

    // 스튜디오 팀장의 최종 결과 보고 — 사용자는 이 한 건만 보면 된다.
    const scoreLine = this.report.chapters.map((c) => `${c.no}화 ${c.finalScore}점`).join(', ');
    this.bus.publish(makeHandoff({
      trace_id: this.projectId, sender: this.studio, receiver: 'HUMAN', status: 'COMPLETE',
      summary: `[${this.genre.label}] 제작 완료 — ${scoreLine}${this.report.escalations.length ? ` / 에스컬레이션 ${this.report.escalations.length}건` : ''}`,
      next_action: 'MANUSCRIPT.md 를 검토하고 확장 여부를 지시해 주세요.',
      data_payload_path: manuscriptPath,
    }));

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const summary = {
      project_id: this.projectId,
      project_dir: this.projectDir,
      manuscript: manuscriptPath,
      pm_report: pmResult.path,
      chapters: this.report.chapters,
      polish: this.report.polish || null,
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
          trace_id: this.projectId, sender: 'LEAD_QA', receiver: this.studio, status: 'NEEDS_HUMAN',
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
      receiver: this.studio,
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
      receiver: this.studio,
    });

    return {
      no: ch.no, title: ch.title, key,
      finalScore: bestScore, revisions, escalated,
      chars: countChars(final.text),
      path: final.path,
      continuity_ok: cont.data?.ok !== false,
    };
  }

  /**
   * 전면 퇴고 — 전 회차를 통독하고 회차별 퇴고 지시를 내린 뒤, 지시가 있는 회차만 다시 다듬는다.
   *
   * 회차 루프의 개고(WRITER_2)와는 목적이 다르다.
   *   개고 = 이 회차가 기준을 넘는가          (회차 안에서만 본다)
   *   퇴고 = 전체가 한 작품으로 읽히는가       (회차를 건너서 본다)
   * 미회수 복선, 반복되는 비유, 인물 말투의 표류는 전자로는 절대 안 잡힌다.
   */
  async _polishPass(chapters) {
    this.logger.stage('7단계 · 전면 퇴고 (LEAD_WRITING)');

    const fullText = chapters.map((ch) => {
      const key = `ch${pad(ch.no)}`;
      return this.guard.read(`chapters/${key}.final.md`, '');
    }).join('\n\n---\n\n');

    const diag = await this._delegate('POLISHER', {
      stageKey: 'polish:diagnose',
      task: '전 회차를 통독하고 회차별 퇴고 지시를 작성하라. 회차 단위 검토가 놓친 것 — 미회수 복선, 반복, 인물 말투 표류, 감정선 낙차 — 을 잡는 것이 목적이다.',
      inputs: {
        전체_원고: truncate(fullText, 60000),
        캐논: this.canonSummary(),
        미회수_복선: this.canon.open_threads,
        회차_점수: this.report.chapters.map((c) => ({ no: c.no, score: c.finalScore })),
      },
      meta: { idea: this.brief.idea, chapters: chapters.length },
      outFile: 'reports/polish-diagnosis.json',
      receiver: 'EDITOR',
    });

    const directives = diag.data?.chapter_directives || [];
    this.report.polish = {
      overall_read: diag.data?.overall_read || '',
      unresolved_foreshadow: diag.data?.unresolved_foreshadow || [],
      repetition: diag.data?.repetition || [],
      structural_risk: diag.data?.structural_risk || [],
      touched_chapters: directives.map((d) => d.no),
    };

    if (diag.data?.structural_risk?.length) {
      this.report.escalations.push({
        stage: 'polish', reason: '구조 수준의 문제 지적됨', detail: diag.data.structural_risk, action: 'NEEDS_HUMAN',
      });
      this.bus.publish(makeHandoff({
        trace_id: this.projectId, sender: 'LEAD_WRITING', receiver: this.studio, status: 'NEEDS_HUMAN',
        summary: `퇴고 단계에서 구조적 문제 발견: ${diag.data.structural_risk.join(' / ')}`,
        next_action: '사용자 판단 필요: 구조 변경은 개고 범위를 넘는다',
        data_payload_path: 'reports/polish-diagnosis.json',
      }));
    }

    if (!directives.length) {
      this.logger.ok('퇴고 지시 없음 — 전 회차 통과');
      return;
    }

    this.logger.info(`퇴고 대상 ${directives.length}개 회차: ${directives.map((d) => `${d.no}화`).join(', ')}`);

    for (const d of directives) {
      const ch = chapters.find((c) => c.no === d.no);
      if (!ch) continue;
      const key = `ch${pad(d.no)}`;
      const before = this.guard.read(`chapters/${key}.final.md`, '');
      if (!before) continue;

      await this._delegate('EDITOR', {
        stageKey: `polish:${key}`,
        task: `제${d.no}화에 전면 퇴고 지시를 반영하라. must_fix 는 전부 적용하고 keep 은 절대 건드리지 마라. 사건과 설정은 바꾸지 않는다.`,
        inputs: {
          원고: before,
          퇴고_지시: d,
          전체_통독_인상: diag.data?.overall_read,
          반복_지적: (diag.data?.repetition || []).filter((r) => (r.chapters || []).includes(d.no)),
        },
        meta: { idea: this.brief.idea, chapterNo: d.no, chapterTitle: ch.title, sourceText: before },
        outFile: `chapters/${key}.final.md`,
        receiver: this.studio,
      });

      const after = this.guard.read(`chapters/${key}.final.md`, '');
      const entry = this.state.chapters[key];
      if (entry) {
        entry.polished = true;
        entry.chars = countChars(after);
      }
      this.logger.ok(`${key} 퇴고 반영 (${countChars(before)}자 → ${countChars(after)}자)`);
    }
    this._save();
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
