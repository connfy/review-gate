# Review Gate

언어: [English](README.md) | 한국어

> AI가 "이 코드 깨끗해요"라고 했다. 근데 그 말만 믿고 바로 합쳐도 괜찮을까?

Review Gate는 딱 그 애매한 순간을 없애주는 작은 도구예요. Codex 같은 AI 리뷰 봇이
"이 PR 통과"라고 판단하면, GitHub의 PR 화면에 **초록색 통과 표시**를 켜줍니다.
리뷰 봇이 최신 코드를 보고 있다는 뜻으로 `eyes` 반응을 남겼다면, 리뷰가 진행 중인 동안
표시는 **진행 중(pending)** 상태가 됩니다. 반대로 아직 작성 중이거나, 안 끝난 리뷰 대화가
남아 있거나, 최근에 올린 코드를 아직 리뷰받지 못했다면 **빨간색 실패 표시**를 그대로
둬요.

한마디로 **"AI한테 리뷰를 시켰다"와 "이제 진짜 합쳐도 된다" 사이의 빈틈을 메워주는
도구**입니다. PR에는 이런 이름의 표시가 뜨고, 이게 곧 "합쳐도 된다"는 신호가 돼요.

`review-gate/codex-clean`

왜 쓰면 좋냐면:

- 기본은 이벤트 기반이고, GitHub가 따로 깨워주지 않는 PR 본문 반응만 가벼운 예약
  재확인으로 보완합니다. 같은 PR을 보려고 GitHub Actions 시간을 태우지는 않습니다.
- 도구 하나만 띄워두면 저장소 수십 개를 한꺼번에 관리할 수 있어요.
- 새 코드를 올리면 통과 표시가 알아서 다시 빨간불로 돌아갑니다. 옛날에 받은 통과를
  믿고 실수로 합치는 일이 없어요.
- 그냥 참고용 신호로 써도 되고, 아예 합치기 버튼 자체를 잠가버리도록 설정할 수도
  있습니다.

## 언제 초록불이 켜지나

지금 PR에 올라온 **가장 최근 코드**를 기준으로, 아래 세 가지가 전부 맞아야 통과(초록불)가
됩니다.

- PR이 "작성 중(draft)" 상태가 아니다
- 아직 안 끝난 리뷰 대화가 없다
- 정해둔 리뷰 봇이 최근 코드를 보고 "통과" 신호를 남겼다

여기서 "통과" 신호는 세 가지 중 하나면 인정돼요.

- 리뷰 봇이 PR에 통과 문구가 담긴 코멘트를 남겼거나
- 리뷰 봇이 지금 최신 코드에 대한 리뷰로 통과 문구를 남겼거나
- 리뷰 봇이 PR 본문에 `+1` 반응을 남겼고, 그 반응이 최신 코드 업데이트와 최신 리뷰 요청
  이후에 만들어진 경우입니다.

리뷰가 진행 중일 때는 정해둔 봇이 PR 본문이나 최신 리뷰 요청 코멘트에 `eyes` 반응을 남기면
표시가 `pending`이 됩니다. 이때 표시 문구는 특정 봇 이름을 박지 않고 이렇게 나갑니다.

`Review bot is reviewing the latest head.`

기본값으로는 아래 봇이 남긴 신호만 믿고,

- `chatgpt-codex-connector`
- `chatgpt-codex-connector[bot]`

아래 문구와 PR 본문의 `+1` 반응을 "통과" 신호로 봅니다.

`Codex Review: Didn't find any major issues.`

참고로 GitHub는 PR 본문 반응을 별도 알림으로 보내주지는 않아요. 대신 Review Gate는 다른
PR/리뷰/코멘트 알림 때문에 PR을 다시 계산할 때, GitHub의 issue reactions API로 PR 본문
반응을 같이 읽습니다. 또 PR 생성이나 리뷰 요청 직후에는 짧게 한 번 더 확인해서, 늦게 붙는
`eyes` 반응도 실패가 아니라 진행 중 상태로 바뀔 수 있게 합니다. 그리고 예약 sweep이 열린
PR을 가볍게 다시 계산해서, 늦게 붙은 PR 본문 `+1`만으로도 다음 sweep에서 초록불로 바뀔 수
있게 합니다.

## 설치하기 (생각보다 금방 끝나요)

총 5단계예요. GitHub 앱 만들기 → 열쇠 파일 변환 → 도구 올리기 → 앱 연결 → 끝.

### 1. GitHub 앱 만들기

GitHub에서 내 계정이나 조직(organization) 아래에 새 GitHub 앱을 하나 만들어요. 설정할 게
몇 개 있는데, 아래 표대로만 따라오면 됩니다.

먼저 **권한(Repository permissions)**을 이렇게 줍니다.

| 권한 | 허용 범위 | 왜 필요한가 |
| --- | --- | --- |
| Commit statuses | Read and write | PR에 통과/실패 표시를 직접 써야 해서요. |
| Pull requests | Read-only | PR 상태와 리뷰, 코멘트, 리뷰 대화를 읽으려고요. |
| Issues | Read-only | PR에 달리는 코멘트를 받고 PR 본문 반응을 읽으려고요. GitHub는 PR 코멘트와 PR 본문을 내부적으로 이슈로 다룹니다. |

다음으로 **받을 알림(Subscribe to events)**에서 아래 다섯 개를 체크하세요.

- Pull request
- Pull request review
- Pull request review comment
- Pull request review thread
- Issue comment

특히 마지막 **Issue comment**는 절대 빼먹지 마세요. 리뷰 봇의 통과 코멘트는 대부분 PR에
달리는 일반 코멘트로 오는데, GitHub는 그걸 "이슈 코멘트" 알림으로 보냅니다. 이걸 빼면
"왜 안 되지?" 하고 한참 헤매게 돼요.

**Webhook URL** 칸은 지금 당장 정확할 필요 없어요. `https://example.com/review-gate` 같은
임시 주소를 넣어두고, 도구를 올린 뒤에 진짜 주소로 바꾸면 됩니다.

**Webhook secret** 칸에는 충분히 긴 무작위 문자열을 만들어 넣고, 어딘가에 잠깐
복사해두세요. 다음 단계에서 씁니다.

### 2. 열쇠 파일 변환하기

GitHub 앱 설정 화면에서 비밀 열쇠 파일(private key)을 내려받습니다. 그런데 GitHub가 주는
파일은 `PKCS#1`이라는 옛날 형식이고, 우리가 쓸 Cloudflare는 `PKCS#8`이라는 형식을 원해요.
그래서 한 번 변환해줘야 합니다. 아래 명령어를 그대로 복사해서 붙여넣으면 돼요.

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in your-app.private-key.pem -out your-app.pkcs8.pem
```

`your-app.private-key.pem` 자리에 방금 내려받은 파일 이름을 넣으면 됩니다. 그러면
`your-app.pkcs8.pem` 파일이 새로 생기는데, 이걸 다음 단계에서 씁니다.

### 3. 도구 올리기 (배포)

이제 이 도구를 Cloudflare에 올립니다. 아래 명령어를 순서대로 실행하세요.

```bash
cd review-gate
npm install
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler deploy
```

`wrangler secret put`을 실행하면 값을 붙여넣으라고 물어봐요. 각각 이렇게 넣어주세요.

- `GITHUB_APP_ID`: GitHub 앱의 숫자 ID (앱 설정 화면 맨 위에 있어요)
- `GITHUB_WEBHOOK_SECRET`: 1단계에서 만든 암호 문자열
- `GITHUB_APP_PRIVATE_KEY`: 2단계에서 변환한 파일의 전체 내용
  (`-----BEGIN`부터 `END-----`까지 통째로)

다 끝나면 화면에 인터넷 주소(URL)가 하나 뜹니다. 그걸 복사해두세요.

### 4. GitHub 앱에 도구 연결하기

다시 GitHub 앱 설정으로 가서, 아까 임시로 넣어둔 **Webhook URL**을 방금 복사한 진짜
주소로 바꿔줍니다.

연결이 잘 됐는지 확인하려면 **Advanced > Recent deliveries**에서 `ping`이라는 신호를 다시
보내보세요(redeliver). `200`과 함께 `pong`이 돌아오면 성공입니다.

마지막으로, 이 기능을 켜고 싶은 저장소에 앱을 설치하면 끝이에요.

> 나중에 앱 권한을 바꾸면, 저장소 주인이 새 권한을 한 번 승인해줘야 적용됩니다. 까먹기
> 쉬우니 기억해두세요.

### 5. 실제 PR에서 써보기

PR을 새로 열거나 코드를 올리면, Review Gate가 통과/실패 표시를 달기 시작해요.
최근 코드가 통과 리뷰를 받고 모든 리뷰 대화가 끝날 때까지는 계속 실패 표시로 남아
있습니다.

Codex를 쓰고 있다면 보통 이렇게 리뷰를 부르면 돼요.

```text
@codex review
```

리뷰 봇이 통과 코멘트를 남기거나, 이후 다른 알림을 계기로 PR 본문의 `+1` 반응이 확인되거나,
예약 sweep이 그 `+1`을 발견하면 Review Gate가 다시 계산하고 실패인지 통과인지 알려줍니다.
봇이 아직 `eyes`로 리뷰 진행만 표시한 상태라면 통과가 아니라 진행 중으로 표시됩니다.

## 참고용으로 쓸까, 아예 막아버릴까

Review Gate는 기본적으로 통과/실패를 "표시"만 해요. 사실 이것만으로 충분한 경우가 많아요.
사람이든 AI든 "초록불 아니면 합치지 말기"라는 약속만 지키면 되니까요. 이게 **참고용
방식**입니다.

GitHub가 아예 합치기 버튼을 못 누르게 막아주길 원한다면, 보호하려는 브랜치 설정에서
`review-gate/codex-clean`을 "꼭 통과해야 하는 검사"로 추가하세요. 이게 **강제 방식**이고요.

참고로 이 앱은 브랜치 설정을 대신 만들어주겠다며 강한 관리자 권한을 요구하지 않아요.
그런 권한이 없는 편이 설치하는 사람 입장에서 훨씬 마음 편하고 안전하니까요.

## 설정값 바꾸기

비밀이 아닌 설정은 `wrangler.toml` 파일에 들어 있어요. 다른 리뷰 봇을 쓰거나 인정할 문구를
바꾸고 싶으면 여기를 고치면 됩니다.

| 설정값 | 기본값 | 의미 |
| --- | --- | --- |
| `STATUS_CONTEXT` | `review-gate/codex-clean` | PR에 다는 표시의 이름 |
| `REVIEW_BOT_LOGINS` | `chatgpt-codex-connector,chatgpt-codex-connector[bot]` | 통과로 인정할 봇 계정 목록 (쉼표로 구분) |
| `CLEAN_REVIEW_TEXT` | `Codex Review: Didn't find any major issues.` | 통과로 인정할 문구 |
| `CLEAN_REACTION_CONTENT` | `+1` | 통과로 인정할 PR 본문 반응 |
| `REVIEW_IN_PROGRESS_REACTION_CONTENT` | `eyes` | 최신 코드를 리뷰 중이라고 볼 반응 |
| `REVIEW_REQUEST_TEXT` | `@codex review` | PR 본문 반응이 최신인지 판단할 때 쓰는 리뷰 요청 문구 |
| `REVIEW_START_RETRY_DELAY_MS` | `15000` | PR 생성/리뷰 요청 직후 늦게 붙는 `eyes`를 다시 확인하기 전 기다리는 시간 |
| `REVIEW_PENDING_RETRY_INTERVAL_MS` | `7000` | 진행 중 리뷰에서 제한 재확인 사이에 기다리는 시간 |
| `REVIEW_PENDING_RETRY_ATTEMPTS` | `2` | PR 본문 `+1`이나 최종 리뷰 결과를 확인할 최대 재확인 횟수. `0`이면 끕니다. |
| `SWEEP_MAX_INSTALLATIONS` | `25` | 예약 sweep 한 번에서 확인할 GitHub App 설치 수 상한 |
| `SWEEP_MAX_REPOSITORIES` | `100` | 예약 sweep 한 번에서 확인할 저장소 수 상한 |
| `SWEEP_MAX_PULL_REQUESTS` | `50` | 예약 sweep 한 번에서 평가할 열린 PR 수 상한 |

기본 cron은 `wrangler.toml`에서 3분마다 실행되도록 잡혀 있습니다.

```toml
[triggers]
crons = [ "*/3 * * * *" ]
```

비밀값은 `wrangler secret put` 명령으로 Cloudflare에 따로 저장합니다.

| 비밀값 | 의미 |
| --- | --- |
| `GITHUB_APP_ID` | GitHub 앱의 숫자 ID |
| `GITHUB_APP_PRIVATE_KEY` | 변환한 비밀 열쇠 파일 내용 |
| `GITHUB_WEBHOOK_SECRET` | GitHub 앱에 넣은 암호 문자열 |

## 안 될 때 (문제 해결)

### 통과/실패 표시가 아예 안 보여요

- 앱이 그 저장소에 진짜 설치돼 있나요?
- 4단계에서 진짜 주소를 GitHub 앱 설정에 넣었나요?
- `ping` 신호를 다시 보냈을 때 `200 pong`이 오나요?
- 그래도 안 되면 Cloudflare 쪽 기록(로그)에서 오류가 있는지 봐보세요.

### Codex는 통과라는데 계속 실패로 떠요

- 통과 코멘트가 가장 최근 코드를 올린 "뒤"에 달렸나요? 그 전에 달린 건 인정 안 돼요.
- PR 본문의 `+1` 반응을 쓰는 경우, 그 반응이 최신 코드 업데이트와 최신 `@codex review`
  요청 뒤에 만들어졌나요?
- 봇이 아직 리뷰 중이라면 PR 본문이나 최신 리뷰 요청 코멘트에 정해둔 봇의 최신 `eyes`
  반응이 있나요? 이 경우 실패가 아니라 진행 중으로 보여야 합니다.
- 봇이 PR 본문 `+1`만 남기는 경우라면 다음 예약 sweep을 잠시 기다려보세요.
  GitHub는 그 반응만으로 별도 알림을 보내지 않습니다.
- 아직 안 끝난 리뷰 대화가 남아 있진 않나요?
- GitHub 앱 설정의 **Advanced > Recent deliveries**에 그 코멘트가 달린 시각의
  이슈 코멘트 알림이 도착해 있나요?
- 알림 자체가 없다면, `Issues: Read-only` 권한과 `Issue comment` 알림 설정을 둘 다 다시
  확인하세요. (제일 흔한 원인이에요.)
- 알림은 도착했고 `202 Accepted`로 떴다면, 신호는 잘 받은 거예요. 그럼 문제는 그 이후
  처리 단계에 있으니 Cloudflare 쪽 기록을 봐보세요.

### 실패로 떠 있는데 GitHub가 합치기를 막지 않아요

그건 이 표시가 아직 "꼭 통과해야 하는 검사"로 지정되지 않았다는 뜻이에요. 참고용으로만
쓸 거면 "실패면 합치지 말기"로 약속하면 되고, GitHub가 직접 막게 하려면
`review-gate/codex-clean`을 꼭 통과해야 하는 검사로 추가하세요.

## 직접 고쳐보고 싶다면 (로컬 개발)

```bash
npm test
npm run dev
```

코드를 둘러볼 때 참고하면 좋은 파일들이에요.

- `src/gate.js` - 통과/실패를 판단하는 핵심 로직 (읽기 편하게 정리돼 있어요)
- `src/webhook.js` - 알림이 진짜인지 검증하고, 종류별로 처리하며, 불필요한 코멘트
  알림을 거르는 부분
- `src/github.js` - GitHub 앱 인증과 GitHub와 주고받는 통신 부분
- `src/index.js` - 도구의 시작점
- `test/` - `node --test`로 돌리는 테스트

## 보안 관련 한마디

- 보안은 코드를 숨기는 게 아니라, 비밀값을 잘 지키는 데서 나와요.
- 들어오는 알림은 암호 문자열로 진짜인지 검증합니다.
- 통과는 정해둔 봇 계정이 작성했을 때만 인정해요. 아무나 문구만 따라 적는다고 통과되지
  않습니다.
- 비밀 열쇠 파일이나 `.dev.vars`는 절대 코드 저장소에 올리지 마세요. 혹시 실수로 올렸다면
  바로 새 것으로 바꾸세요.

## License

MIT. 자세한 건 `LICENSE` 참고하세요.
