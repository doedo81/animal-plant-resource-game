# 내 PC에서 돌리기 — 설치 · 보안 설정 · 정리

디스코드 없이, 내 컴퓨터에서 CLI로만 돌리는 방법. **헤르메스는 나중 일이다.**

---

## 1. 설치 (10분)

### 1-1. Node.js

https://nodejs.org 에서 **LTS 버전** 설치. (18 이상이면 됨)

설치 확인:
```bash
node --version      # v18.17 이상이면 OK
```

### 1-2. 코드 받기

```bash
git clone https://github.com/doedo81/animal-plant-resource-game.git
cd animal-plant-resource-game
git checkout claude/fantasy-multi-agent-system-kzewb6
cd novel-factory
```

**의존성 설치 불필요.** `npm install` 안 해도 됩니다. 외부 패키지 0개로 만들었습니다.

### 1-3. 점검

```bash
node src/cli.js doctor
node test/smoke.test.js        # 23건 전부 통과해야 정상
```

### 1-4. API 키 없이 먼저 돌려보기

**방법 A — 브라우저 (추천)**: `소설공장-시작.bat` (윈도우) / `소설공장-시작.command` (맥) 더블클릭.
브라우저가 열리면 아이디어 입력 → 엔진 `mock` → 제작 시작.

**방법 B — 터미널**:
```bash
node src/cli.js run --idea "테스트" --chapters 2
```

전 구간이 도는지 확인용입니다. 내용은 고정된 더미 샘플이 나옵니다.

> 실제 집필도 브라우저에서 됩니다: API 키를 환경변수로 설정한 **다음** 실행 파일을 켜고,
> 엔진에서 `openai` 를 고르면 됩니다. (키 설정법은 아래 2-4)

---

## 2. 보안 설정 — **실제 집필 전에 반드시**

### 2-1. 프로젝트 폴더를 클라우드 동기화 밖으로

**가장 중요합니다.** 구글드라이브·원드라이브·드롭박스 동기화 폴더 안에 두면
작업물이 통째로 클라우드로 올라갑니다.

```
❌ C:\Users\내이름\Google Drive\animal-plant-resource-game\
❌ C:\Users\내이름\OneDrive\문서\animal-plant-resource-game\
✅ C:\Projects\animal-plant-resource-game\
✅ D:\novel\animal-plant-resource-game\
```

> **윈도우 주의**: `문서`, `바탕 화면`, `사진` 폴더는 원드라이브가 기본으로 동기화합니다.
> 윈도우 설치 시 자동으로 켜지는 경우가 많으니, 작업 표시줄의 원드라이브 아이콘 →
> 설정 → 백업 에서 **꺼져 있는지 확인**하세요.

### 2-2. 산출물만 다른 곳에 저장하고 싶다면

코드는 그대로 두고 결과물 위치만 바꿀 수 있습니다.
`config/local.json` 파일을 새로 만드세요 (이 파일은 `.gitignore`에 있어 커밋되지 않습니다):

```json
{
  "workspaceRoot": "D:/novel-output",
  "sessionStateRoot": "D:/novel-output/session_state"
}
```

윈도우 경로도 슬래시(`/`)를 쓰세요. 역슬래시는 JSON에서 이스케이프가 필요합니다.

### 2-3. 프롬프트 아카이브는 기본으로 꺼져 있습니다

`.cache/calls/` 에 **프롬프트와 응답 전문**이 평문으로 쌓이는 기능이 있는데,
개인정보·아이디어가 그대로 남으므로 **기본값을 꺼둔 상태**입니다.

디버깅 때문에 켜야 한다면 `config/local.json` 에:
```json
{ "llm": { "archiveCalls": true } }
```
켜두면 디스크 사용량이 약 2배가 되고, 그 폴더는 절대 공유하면 안 됩니다.

### 2-4. API 키

**환경변수로만 넣습니다.** 코드나 설정 파일에 절대 쓰지 마세요.

**윈도우 (PowerShell)**
```powershell
$env:OPENAI_API_KEY = "sk-..."          # 이 창에서만 유효
node src/cli.js run --idea "..." --provider openai
```

**윈도우 (영구 설정)** — 시스템 환경 변수 편집에서 `OPENAI_API_KEY` 추가

**맥 / 리눅스**
```bash
export OPENAI_API_KEY="sk-..."
node src/cli.js run --idea "..." --provider openai
```

> 키가 실수로 산출물에 섞여도 저장 직전에 `«REDACTED»` 로 마스킹됩니다(가드 기능).
> 하지만 **애초에 넣지 않는 것**이 원칙입니다.

---

## 3. 실제 집필

```bash
node src/cli.js run \
  --idea "몰락한 변방 영지를 물려받은 전생자" \
  --preset estate --chapters 6 \
  --style "짧고 건조한 문장, 숫자는 감각과 함께" \
  --provider openai --model gpt-4o
```

5~6회차면 **20~50분** 걸립니다. 대부분 API 응답 대기 시간이라 그동안 컴퓨터는 놀고 있습니다.
다른 일 하셔도 됩니다.

**중간에 끊겨도 괜찮습니다.** 전원이 나가거나 창을 닫아도:
```bash
node src/cli.js resume prj_xxxxx
```
완료된 단계는 건너뛰고 중단점부터 이어갑니다.

---

## 4. 결과물과 정리

### 4-1. 어디에 뭐가 있나

```
workspace/prj_xxxxx/
├── MANUSCRIPT.md          ← 이것만 있으면 됩니다
├── chapters/
│   ├── ch01.final.md      최종고
│   ├── ch01.draft1.md     초고        ┐
│   ├── ch01.review0.json  검토 결과    │ 과정 기록
│   └── ch01.critique0.json 비평 점수   ┘
├── canon/                 세계관·인물·문체 시트
├── reports/               PM 보고서, 퇴고 진단서
└── bus/events.jsonl       모든 핸드오프 원장
```

### 4-2. 납품 후 정리

원고를 받아서 확인했으면 중간 파일을 지울 수 있습니다.

```bash
node src/cli.js clean prj_xxxxx           # 무엇을 지울지 먼저 보여줌 (실행 안 함)
node src/cli.js clean prj_xxxxx --yes     # 실제 삭제 — 초고·검토·비평·버스 제거
node src/cli.js clean prj_xxxxx --all --yes   # MANUSCRIPT.md 만 남기고 전부 제거
```

기본 모드는 **원고·최종고·캐논·보고서를 남기고** 나머지를 지웁니다 (약 80% 감소).

> **정리하면 그 프로젝트는 resume 할 수 없습니다.** 원고를 확인한 뒤에 하세요.
> `--yes` 가 없으면 목록만 보여주고 아무것도 지우지 않습니다.

### 4-3. 백업

`workspace/` 는 `.gitignore` 에 있어 저장소에 올라가지 않습니다. 의도된 설계입니다
(작업물이 공개 저장소로 새는 것을 막기 위해).

**완성 원고는 따로 백업하세요.** 미니PC든 내 PC든 저장장치는 언젠가 죽습니다.
`MANUSCRIPT.md` 만 챙기면 되므로 파일 하나 복사로 끝납니다.

---

## 5. 자주 겪는 문제

| 증상 | 원인과 해결 |
|---|---|
| `node: command not found` | Node.js 미설치 또는 PATH 미반영. 터미널을 새로 여세요 |
| `OPENAI_API_KEY 환경변수가 없습니다` | 키를 설정한 창과 실행하는 창이 다름. 같은 창에서 하세요 |
| 한글이 깨져 보임 | PowerShell에서 `chcp 65001` 실행 후 재시도 |
| `HTTP 429` | API 요청 한도 초과. 자동으로 4회까지 재시도합니다. 계속되면 잠시 후에 |
| 회차 분량이 목표보다 짧음 | 프롬프트 조정이 필요한 지점. `prompts/roles/writer1.md` 수정 |
| 진행이 멈춘 것 같음 | 정상입니다. 한 번의 API 호출이 1분 넘게 걸릴 수 있습니다 |

---

## 6. 다음 단계 — 디스코드는 언제?

**지금은 아닙니다.** 순서가 있습니다.

1. **지금**: 내 PC에서 CLI로 실제 API를 붙여 1~2작품 뽑아본다
2. **그 다음**: `reports/run-summary.json` 의 점수·비용·에스컬레이션을 보고 프롬프트를 손본다
3. **품질이 만족스러워지면**: 그때 헤르메스(디스코드)를 ChatGPT에게 발주한다

품질이 안 나오는 상태에서 디스코드를 붙이면 **안 좋은 결과물이 더 빨리 배달될 뿐**입니다.
CLI로 손맛을 익힌 다음에 자동화하는 것이 맞습니다.

디스코드 서버·채널·봇 등록은 **사람만 할 수 있는 일**이라 헤르메스에게 시킬 수 없지만,
급하지 않습니다. 발주 계획은 [DISCORD_PLAN.md](DISCORD_PLAN.md) 에 준비돼 있습니다.
