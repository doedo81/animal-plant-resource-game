'use strict';
/**
 * 오프라인 더미 작가 (provider: mock)
 *
 * API 키 없이도 PM→팀장→팀원→버스→핸드오프→검토→비판→재집필→납품
 * 전 구간을 그대로 돌려볼 수 있게 하는 결정론적 생성기다.
 * 실제 품질은 openai/anthropic provider 가 담당한다.
 */

/** 문자열 시드 기반 결정론적 난수 (mulberry32) */
function rng(seedStr) {
  let h = 1779033703 ^ String(seedStr).length;
  for (let i = 0; i < String(seedStr).length; i++) {
    h = Math.imul(h ^ String(seedStr).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

function handoffBlock(h) {
  return '\n\n```json\n' + JSON.stringify({ HANDOFF_EVENT: h }, null, 2) + '\n```\n';
}

function mockRespond(req) {
  const m = req.meta || {};
  const role = m.role || 'WRITER_1';
  const idea = m.idea || '이름 없는 이야기';
  const r = rng(`${role}|${idea}|${m.chapterNo || 0}|${m.revision || 0}`);
  const payload = m.payloadPath || 'workspace/output.md';
  const receiver = m.receiver || 'PM';

  const base = {
    sender: role,
    receiver,
    status: 'COMPLETE',
    summary: `${role} 작업 완료 (mock)`,
    next_action: `${receiver} 는 산출물을 검수하고 다음 단계로 전달하라.`,
    data_payload_path: payload,
  };

  switch (role) {
    case 'RESEARCHER':
      return JSON.stringify({
        findings: [
          { topic: '시대 배경', detail: `${idea} 의 배경으로 중세 후기 상업도시 모델이 적합. 길드·환전상·용병 계약 구조가 갈등의 연료가 된다.`, confidence: 0.7 },
          { topic: '기술 수준', detail: '인쇄술 이전. 정보는 사람과 서신으로만 이동하므로 "소문"이 서사 장치로 강력하다.', confidence: 0.8 },
          { topic: '경제', detail: '은본위 화폐와 물물교환 병존. 대가 지불의 개연성을 여기서 확보한다.', confidence: 0.65 },
        ],
        constraints: [
          '실존 인물·국가를 그대로 쓰지 않는다 (변형 고유명사 사용).',
          '고증과 재미가 충돌하면 재미를 택하되, 충돌 사실을 각주로 남긴다.',
        ],
        open_questions: ['마법이 경제에 미치는 영향의 범위를 어디까지 허용할 것인가?'],
        HANDOFF_EVENT: { ...base, summary: '역사·기술·경제 3개 축 고증 자료 정리, 제약 2건 도출' },
      }, null, 2);

    case 'WORLDBUILDER':
      return JSON.stringify({
        world: {
          name: pick(r, ['에르한 자유시', '카르네스 연합', '회색항 도시국가']),
          premise: idea,
          geography: '내해를 낀 항구도시와 그 배후의 석회암 고원. 고원 아래 폐광이 이야기의 지하 무대가 된다.',
          magic_system: {
            name: '대가율(代價律)',
            rule: '마력은 창조되지 않고 교환된다. 무언가를 얻으려면 같은 무게의 무언가를 내놓아야 한다.',
            cost: '기억, 수명, 감각, 이름 — 회수 불가.',
            limits: ['죽은 자를 되살릴 수 없다', '대가는 본인 것만 지불 가능', '거래는 취소되지 않는다'],
            taboo: '타인의 기억을 대가로 지불하는 행위 = 사형',
          },
          factions: [
            { name: '기억 상단', want: '대가율의 독점 유통', method: '계약과 부채' },
            { name: '항구 시의회', want: '질서 유지', method: '법과 감시' },
            { name: '무명자들', want: '이름을 잃은 자들의 복권', method: '폭력과 폭로' },
          ],
          history: ['30년 전 대붕괴로 고원의 광맥이 무너지며 대가율이 발견됨', '이후 상단이 도시를 실질 지배'],
          sensory_signature: ['젖은 석회 냄새', '동전 부딪는 소리', '기억을 판 자의 텅 빈 눈'],
        },
        HANDOFF_EVENT: { ...base, summary: '세계관 확정: 대가율 마법체계 + 3세력 구도 + 감각 시그니처' },
      }, null, 2);

    case 'CHARACTER_DESIGNER':
      return JSON.stringify({
        characters: [
          { name: '레이든', role: '주인공', age: 16, goal: '누이의 병을 고칠 값을 치른다', flaw: '대가를 과소평가한다', secret: '이미 어머니의 얼굴을 잊었다', arc: '거래자 → 거래의 대상 → 거래를 끝내는 자', voice: '짧고 건조한 문장, 감정은 행동으로만' },
          { name: '세이라', role: '조력자/대립자', age: 24, goal: '상단의 장부를 손에 넣는다', flaw: '누구도 믿지 않는다', secret: '레이든의 어머니를 사간 중개인', arc: '이용 → 흔들림 → 선택', voice: '농담으로 진심을 가린다' },
          { name: '금고지기 훈', role: '적대자', age: 51, goal: '대가율의 완전한 통제', flaw: '자기 규칙에 갇혀 있다', secret: '스스로는 한 번도 대가를 치른 적 없다', arc: '무결한 지배자 → 파산', voice: '존댓말로 위협한다' },
        ],
        relationship_map: [
          { from: '레이든', to: '세이라', type: '거래 → 신뢰 → 배신 → 화해' },
          { from: '레이든', to: '훈', type: '채무자 → 균열 → 전복' },
        ],
        HANDOFF_EVENT: { ...base, summary: '주요 인물 3인 + 관계도 확정 (목표/결함/비밀/화술 포함)' },
      }, null, 2);

    case 'SYNOPSIS_WRITER':
      return JSON.stringify({
        logline: `기억을 팔아 마력을 얻는 소년이, 누이를 살리려다 자신이 누구였는지를 잊어간다.`,
        themes: ['대가 없는 구원은 없다', '기억이 곧 자아인가', '부채로 지탱되는 사회'],
        hook: '첫 장면에서 주인공은 자기 어머니의 얼굴을 떠올리지 못한다 — 이미 팔았기 때문이다.',
        synopsis: `${idea}\n\n1막: 레이든은 누이의 약값을 위해 기억 상단과 첫 계약을 맺는다. 대가는 "가장 따뜻했던 겨울".\n2막: 계약이 쌓일수록 마력은 커지고 자아는 얇아진다. 세이라와 손잡고 상단 장부를 노리지만, 장부에서 어머니의 이름을 발견한다.\n3막: 훈은 레이든을 최후의 담보로 삼으려 한다. 레이든은 "대가를 치르는 자"에서 "거래 자체를 파기하는 자"로 넘어가며, 자신의 이름을 지불해 대가율을 무너뜨린다.`,
        ending_direction: '열린 결말 — 이름을 잃은 소년을 누이가 알아보지 못한 채 손을 잡는다.',
        HANDOFF_EVENT: { ...base, summary: '로그라인·3막 시놉시스·주제·결말 방향 확정' },
      }, null, 2);

    case 'OUTLINER': {
      const n = m.chapters || 3;
      const chapters = Array.from({ length: n }, (_, i) => ({
        no: i + 1,
        title: ['첫 번째 대가', '장부의 이름', '이름을 지불하다', '무너지는 저울', '텅 빈 손'][i] || `제${i + 1}화`,
        goal: '주인공이 한 단계 더 깊은 거래로 끌려들어간다',
        conflict: '얻는 것과 잃는 것이 동시에 커진다',
        beats: ['일상의 균열', '거래 제안', '대가 지불', '얻은 힘의 사용', '잃은 것의 자각'],
        cliffhanger: '다음 대가의 청구서가 도착한다',
        target_chars: m.targetChars || 3000,
      }));
      return JSON.stringify({
        chapters,
        HANDOFF_EVENT: { ...base, summary: `${n}개 회차 아웃라인 작성 (비트/클리프행어 포함)` },
      }, null, 2);
    }

    case 'WRITER_1':
    case 'WRITER_2': {
      const rev = role === 'WRITER_2' ? '개고' : '초고';
      const no = m.chapterNo || 1;
      const title = m.chapterTitle || `제${no}화`;
      const body = [
        `# 제${no}화 — ${title}`,
        '',
        `저울이 기울었다. 레이든은 그것을 소리로 먼저 알았다.`,
        '',
        `"이번 대가는 무엇으로 하시겠습니까." 금고지기의 존댓말은 언제나 칼처럼 정중했다.`,
        '',
        `레이든은 대답 대신 손을 내밀었다. 손바닥에 남은 굳은살이 낯설었다. 언제 생긴 것인지 기억나지 않았다 — 아니, 기억나지 않는다는 사실조차 오늘 처음 알았다.`,
        '',
        `저울 위에 놓인 것은 겨울이었다. 어머니가 아궁이 앞에서 등을 굽히고 있던 겨울. 그것이 동전 소리로 바뀌어 상단의 금고로 굴러 떨어졌다.`,
        '',
        `대가를 치른 자에게는 힘이 남는다. 레이든은 처음으로 자기 손끝에서 불이 도는 것을 보았다. 아름다웠고, 그래서 무서웠다.`,
        '',
        `골목 끝에서 세이라가 기다리고 있었다. "얼마 팔았어?" 그 여자는 늘 값부터 물었다.`,
        '',
        `"한 겨울."`,
        '',
        `"싸게 넘겼네." 세이라는 웃었다. 웃음 뒤에 무엇이 있는지 레이든은 아직 몰랐다.`,
        '',
        rev === '개고'
          ? `그날 밤, 누이의 기침이 멎었다. 레이든은 그 소리가 사라진 방에 오래 서 있었다. 무언가를 얻었는데 방은 더 조용해져 있었다.`
          : `그날 밤 누이의 기침이 멎었다. 레이든은 기뻤다.`,
        '',
        `청구서는 사흘 뒤에 도착했다.`,
      ].join('\n');
      return body + handoffBlock({
        ...base,
        summary: `제${no}화 ${rev} 작성 완료 (약 ${body.replace(/\s/g, '').length}자)`,
        next_action: 'REVIEWER 는 캐논 정합성과 장르 규약을 기준으로 검토하라.',
      });
    }

    case 'REVIEWER':
      return JSON.stringify({
        checklist: {
          canon_consistent: true, pov_stable: true, tense_stable: true,
          chapter_goal_met: true, cliffhanger_present: true, target_length_met: (m.revision || 0) > 0,
        },
        issues: (m.revision || 0) > 0 ? [
          { severity: 'low', where: '중반', what: '대사 태그 반복', fix: '행동 묘사로 대체' },
        ] : [
          { severity: 'high', where: '후반부', what: '감정 서술이 "기뻤다"로 직접 진술됨 (telling)', fix: '행동/감각으로 전환' },
          { severity: 'medium', where: '전반', what: '세이라의 동기가 아직 독자에게 보이지 않음', fix: '한 줄짜리 복선 삽입' },
          { severity: 'medium', where: '분량', what: '목표 분량 미달', fix: '거래 장면 감각 묘사 확장' },
        ],
        canon_violations: [],
        HANDOFF_EVENT: { ...base, summary: `검토 완료: 이슈 ${(m.revision || 0) > 0 ? 1 : 3}건 도출`, next_action: 'CRITIC 은 정량 채점하고 개고 필요 여부를 판정하라.' },
      }, null, 2);

    case 'CRITIC': {
      const boost = (m.revision || 0) * 9;
      const s = {
        plot: Math.min(100, 74 + boost + Math.floor(r() * 4)),
        character: Math.min(100, 72 + boost + Math.floor(r() * 5)),
        prose: Math.min(100, 70 + boost + Math.floor(r() * 6)),
        pacing: Math.min(100, 76 + boost + Math.floor(r() * 4)),
        originality: Math.min(100, 78 + boost + Math.floor(r() * 3)),
        genre_fit: Math.min(100, 80 + boost + Math.floor(r() * 3)),
      };
      const total = Math.round(Object.values(s).reduce((a, b) => a + b, 0) / Object.keys(s).length);
      return JSON.stringify({
        scores: s,
        total,
        verdict: total >= 82 ? 'PASS' : 'REVISE',
        must_fix: total >= 82 ? [] : [
          '결말 직전 감정을 직접 진술하지 말고 행동으로 보여줄 것',
          '세이라의 이해관계를 암시하는 복선 1개 추가',
          '거래 장면의 감각(냄새·소리) 밀도를 높여 분량과 몰입 동시 확보',
        ],
        keep: ['"청구서" 로 닫는 마지막 문장', '금고지기의 존댓말 위협'],
        HANDOFF_EVENT: {
          ...base,
          summary: `정량 채점 ${total}점 / 판정 ${total >= 82 ? 'PASS' : 'REVISE'}`,
          next_action: total >= 82 ? 'EDITOR 로 넘겨 최종 윤문하라.' : 'WRITER_2 는 must_fix 를 반영해 개고하라.',
        },
      }, null, 2);
    }

    case 'CONTINUITY_KEEPER':
      return JSON.stringify({
        ok: true,
        conflicts: [],
        canon_updates: {
          established_facts: ['레이든은 어머니의 얼굴을 이미 잃었다', '세이라는 값부터 묻는 인물'],
          open_threads: ['장부 속 어머니의 이름', '훈이 한 번도 대가를 치르지 않은 이유'],
        },
        HANDOFF_EVENT: { ...base, summary: '연속성 점검 통과, 캐논 2건·미회수 복선 2건 갱신' },
      }, null, 2);

    case 'EDITOR': {
      const src = m.sourceText || '';
      return (src ? src.replace(/```json[\s\S]*?```/g, '').trim() : '# 최종고\n\n(본문)') +
        '\n' + handoffBlock({ ...base, summary: '맞춤법·리듬·대사 태그 정리 후 최종고 확정', next_action: 'PM 은 최종 승인 후 사용자에게 납품하라.' });
    }

    case 'PM':
      return JSON.stringify({
        approved: true,
        title: '대가율',
        pitch: '기억을 팔아 마력을 얻는 소년의 이야기',
        quality_summary: '전 회차 기준선 통과',
        risks: ['중반부 세이라 동기 노출 타이밍', '대가율 규칙의 후반 일관성'],
        next_steps: ['4~6화 확장 집필', '표지/제목 A/B 테스트'],
        HANDOFF_EVENT: { ...base, sender: 'PM', receiver: 'HUMAN', summary: '최종 승인 및 납품' },
      }, null, 2);

    default:
      return JSON.stringify({ note: `mock: ${role}`, HANDOFF_EVENT: base }, null, 2);
  }
}

module.exports = { mockRespond, rng };
