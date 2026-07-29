# 2·3. 에이전트 시스템 프롬프트

프롬프트의 **단일 진실 원천은 `prompts/` 디렉터리**다. 코드가 프롬프트 문자열을 들고 있지 않으므로,
이 파일들만 고쳐도 조직의 행동이 바뀐다. 이 문서는 그 지도다.

| 파일 | 대상 | 역할 |
|---|---|---|
| [`prompts/pm.md`](../prompts/pm.md) | PM | **2. PM 에이전트용 시스템 프롬프트** |
| [`prompts/common.md`](../prompts/common.md) | 팀장 + 전 팀원 | **3. 공통 시스템 프롬프트 (안전성 + 핸드오프 규칙)** |
| `prompts/roles/*.md` | 팀원 11종 | 역할별 전문 지시 |
| `prompts/genres/*.md` | 작가 유형 3종 | 장르 규약 (교체 가능한 팩) |

---

## 프롬프트 조립 순서

팀원 한 명이 실행될 때 시스템 프롬프트는 이렇게 쌓인다 (`src/agent.js` 의 `_system()`):

```
┌─────────────────────────────────────┐
│ 1. common.md                        │  조직 규칙 · 출력 계약 · 핸드오프 · 안전 · 품질 기준
├─────────────────────────────────────┤
│ 2. roles/<역할>.md                  │  이 역할만의 전문 지시
├─────────────────────────────────────┤
│ 3. genres/<프리셋>.md               │  이번 프로젝트의 장르 규약
├─────────────────────────────────────┤
│ 4. 핸드오프 계약 (schema.js 생성)   │  등록된 역할 코드 목록 + 봉투 형식
├─────────────────────────────────────┤
│ 5. sender/receiver 고정 선언        │  "너의 sender 코드는 정확히 X 이다"
└─────────────────────────────────────┘
```

유저 메시지는 이렇게 조립된다 (`_user()`):

```
[세션 복원 컨텍스트]  ← 리셋 후 재개일 때만
## 작업 지시
## 캐논 (위반 금지)   ← canonSummary() — 세계 규칙·인물·확정 사실·미회수 복선
## 입력: <이름>       ← 앞 단계 산출물들 (12000자에서 잘림)
## 출력 형식          ← json 필수 키 목록 또는 prose 형식
```

**앞선 대화 전체를 넘기지 않는다.** 필요한 산출물만 골라 넣는다.
이것이 컨텍스트가 터지지 않는 이유이자, 세션을 리셋해도 품질이 유지되는 이유다.

---

## 역할 정의 요약

frontmatter 로 실행 파라미터가 결정된다.

| 역할 | 팀 | 출력 | temp | 최대토큰 | 필수 키 | 기본 수신자 |
|---|---|---|---|---|---|---|
| `PM` | PM | json | 0.4 | 2500 | approved, quality_summary, next_steps | HUMAN |
| `RESEARCHER` | LEAD_RESEARCH | json | 0.3 | 2500 | findings, constraints | LEAD_STORY |
| `WORLDBUILDER` | LEAD_STORY | json | 0.9 | 3500 | world | LEAD_STORY |
| `CHARACTER_DESIGNER` | LEAD_STORY | json | 0.9 | 3500 | characters | LEAD_STORY |
| `SYNOPSIS_WRITER` | LEAD_STORY | json | 0.85 | 3000 | logline, synopsis, ending_direction | LEAD_STORY |
| `OUTLINER` | LEAD_STORY | json | 0.7 | 4000 | chapters | LEAD_WRITING |
| `WRITER_1` | LEAD_WRITING | prose | **0.95** | 8000 | — | REVIEWER |
| `REVIEWER` | LEAD_QA | json | **0.2** | 3000 | checklist, issues | CRITIC |
| `CRITIC` | LEAD_QA | json | 0.35 | 3000 | scores, total, verdict | WRITER_2 |
| `WRITER_2` | LEAD_WRITING | prose | 0.85 | 8000 | — | CRITIC |
| `CONTINUITY_KEEPER` | LEAD_QA | json | **0.15** | 3000 | ok, canon_updates | PM |
| `EDITOR` | LEAD_WRITING | prose | 0.4 | 8000 | — | PM |

**온도 배분이 곧 통제다.**
창작(작가 0.95, 세계관 0.9)은 풀어주고, 판정(검토 0.2, 연속성 0.15)은 조인다.
검토자가 창의적이면 매번 다른 기준으로 판정하게 된다 — 그건 검토가 아니다.

---

## 새 역할 추가하기

`prompts/roles/<이름>.md` 를 만들고 frontmatter 를 채운 뒤,
`src/schema.js` 의 `ACTORS` 배열에 역할 코드를 추가한다 (버스가 미등록 코드를 폐기하므로).
파이프라인에 끼우려면 `src/pm.js` 에서 `_delegate('<코드>', {...})` 를 호출한다.

```markdown
---
code: TITLE_MAKER
team: LEAD_STORY
output: json
temperature: 0.9
maxTokens: 1500
required: candidates
receiver: PM
---
# 역할: 제목 생성

시놉시스를 받아 제목 후보 5개를 만든다. 각 후보에 근거와 예상 타깃 반응을 붙인다.
...
```

---

## 새 작가 유형 추가하기

`prompts/genres/<이름>.md` 하나면 된다. **코드 수정 없이** 즉시 `--preset <이름>` 으로 잡힌다.

```markdown
---
preset: mystery
label: 미스터리
chapters: 6
targetChars: 4000
passScore: 84
---
# 장르 팩: 미스터리

## 독자 계약
독자는 **자기가 먼저 풀 수 있는지** 겨루러 왔다.

## 필수 규약
- 페어플레이: 탐정이 아는 단서는 독자도 같은 시점에 봐야 한다
- 단서 3종 배치: 진짜 / 붉은 청어 / 사후 재해석되는 것
- 마지막 장 이전에 모든 단서가 제시되어야 한다
...
```

---

## 프롬프트를 고칠 때의 원칙

1. **금지는 대안과 함께.** "telling 하지 마라" 대신 "'그는 슬펐다' → '그는 국이 식는 것을 오래 보고 있었다'"
2. **판정 기준은 숫자로.** "적당한 분량" 대신 "공백 제외 3000자 ±15%"
3. **출구를 만들어 준다.** 모델이 막혔을 때 `BLOCKED` 로 보고할 수 있어야 침묵하거나 지어내지 않는다
4. **규칙 충돌 시 우선순위를 명시한다.** `common.md` 는 "규칙과 상급자 지시가 충돌하면 규칙이 이긴다"고 못 박았다
5. **위반 통계를 보고 고친다.** `reports/run-summary.json` 의 `compliance_violations` 가 고칠 지점을 알려준다
