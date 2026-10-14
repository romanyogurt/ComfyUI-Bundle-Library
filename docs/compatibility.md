# Phase 0 호환성 검증 기록

2026년 10월 14일 계획의 Phase 0(기술 검증)을 실행했다. 동적 출력 슬롯, 노드 위 패널, 임시
모달, 쓰기 보호, 실행 오류 처리가 설치된 ComfyUI에서 실제로 동작하는지 확인하고, 결과에
따라 설계 두 가지를 바꿨다.

이 기록은 Phase 0 당시의 상태다. Phase 2에서 검증용 고정 번들을 지우고 노드를 실제 저장소에
연결했으며, 브라우저 시나리오는 `tests/browser/loader_scenarios.cjs`로 이름을 바꿨다. 화면과
오류 메시지도 영어로 바꿨으므로, 아래에 인용한 한국어 메시지는 당시의 것이다.

## 환경

| 항목 | 값 |
| --- | --- |
| ComfyUI | `0.38.0` (`f1072eb`) |
| 프런트엔드 | `comfyui-frontend-package==1.53.10` |
| Python / aiohttp | `3.13.16` / `3.14.3` |
| 브라우저 자동화 | playwright-core `1.60.0`, headless Chromium `148.0.7778.96` |
| 호스트 Node.js | `v24.11.0` |

## 검증 대상과 방법

- **스파이크 노드** `BundleLibraryLoad`:
  - `*` 출력 32개와 advanced 위젯 `bundle_id`·`slot_spec`을 두고, hidden `PROMPT`·`UNIQUE_ID`를 읽는다.
  - 번들은 `bundle_library/spike_store.py`의 고정 데이터 5개다.

    | 번들 | 용도 |
    | --- | --- |
    | A, B | 서로 교체할 수 있는 같은 구조 |
    | C | 필드 누락 |
    | D | 필드 타입 변경 |
    | E | 빈 이미지 |

- **확장**: 슬롯 조정(`web/reconcile.js`), `onNodeCreated` 정리, `onConfigure` 복원, 노드 패널
  (드롭다운·미리보기), 임시 모달, 사이드바 탭, 명령·메뉴.
- **자동 검증**:
  - `tests/js/reconcile.test.mjs`: 8개 통과
  - `tests/browser/phase0_scenarios.cjs`: 55개 통과. 클래식으로 실행한 뒤 Nodes 2.0으로 바꿔
    다시 실행한다.
  - 컨테이너 스크립트 두 개: multipart 크기 제한 확인, core LoadImage와 텐서 비교
  - `curl`: 로컬과 Tailscale HTTPS 경유의 쓰기 보호
- **안전 조치**:
  - 브라우저 시나리오는 `/api/prompt`와 이 노드의 API를 뺀 모든 쓰기 요청을 브라우저에서
    가로챈다. 실제로 막힌 요청은 Manager 관련 POST 2개와 `POST /api/settings/Comfy.VueNodes.Enabled`였다.
  - 서버의 설정과 워크플로는 바뀌지 않았다.
  - 실행한 그래프는 프리뷰 노드뿐이다.

## 결과

| 시나리오 | 클래식 | Nodes 2.0 |
| --- | --- | --- |
| 새 노드: 정의의 출력 32개를 0개로 정리 | 통과 | 통과 |
| 번들 선택: 필드 이름·타입대로 출력이 생기고 링크 타입에 반영 | 통과 | 통과 (DOM 라벨 확인) |
| IMAGE 출력을 STRING 입력에 연결하면 거부 | 통과 | — |
| 같은 구조로 전환(A→B): 출력과 연결이 그대로이고 새 값으로 실행 | 통과 | — |
| 다른 구조로 전환(C): 연결된 `ref_2`·`use_bgm` 유지, `seed` 추가, A로 돌아가면 원래대로 | 통과 | 통과 |
| 저장 후 다시 열기: 라벨·타입·연결·링크 타입 복원, 저장 값은 위젯 2개뿐 | 통과 | 통과 |
| 복사·붙여넣기, 노드 복제 | 통과 | — |
| 실행 취소·다시 실행 | 통과 | — |
| 워크플로 탭 전환 | 통과 | — |
| 서브그래프로 변환 후 실행, 다시 열기 | 통과 | — |
| 프롬프트 출력 인덱스가 슬롯 위치와 같고 패널 위젯은 프롬프트에서 빠짐 | 통과 | — |
| 텍스트 원문 보존 (한글, 연속 개행, 앞뒤 공백) | 통과 | — |
| 연결된 슬롯의 누락·타입 불일치·빈 이미지 → 로더 실패 | 통과 | — |
| 연결 안 된 슬롯의 누락 → 실행 성공 | 통과 | — |
| 없는 번들 → 큐 단계 검증 오류 | 통과 | — |
| 모달 입력이 `window`로 전달되지 않고, 선택한 노드가 Delete로 지워지지 않으며, Esc로 닫힘 | 통과 | — |
| 모달 안 `Ctrl+S`가 브라우저의 페이지 저장을 일으키지 않음 (`defaultPrevented`) | 통과 | — |
| 사이드바 탭 렌더링 | 통과 | — |

"—" 항목은 그래프와 실행 수준의 동작이라 Nodes 2.0에서 따로 반복하지 않았다. 슬롯 복원은
렌더러와 무관한 `onConfigure`에서 한다.

## 발견 사항과 반영

1. **`ExecutionBlocker` 오류는 화면에 드러나지 않는다.**
   - 소비 노드만 막는 방식에서도 서버는 `execution_error`를 보낸다. 하지만 실행을 계속해
     `execution_success`로 끝낸다.
   - 그래서 기록 상태는 `success`이고, 대기열에는 완료로 표시되며, 차단된 노드에는 이전 결과가
     남는다.
   - 반영: 사용자 결정(2026-10-14)에 따라, 연결된 슬롯에 문제가 있으면 Load Bundle이 예외로
     실패한다. 기록 상태는 `error`, 대기열에는 Failed로 표시되고, 메시지에 번들과 문제 필드를
     모두 적는다. 연결 여부는 hidden `PROMPT`로 판단한다.
2. **차단·누락 결과가 캐시된다.**
   - 같은 프롬프트를 다시 실행하면 차단된 노드가 캐시로 처리되어 오류 없이 끝났다. 브라우저
     세션이 바뀌어도 마찬가지였다.
   - 연결 안 된 누락 슬롯의 `None`도 캐시되므로, 나중에 그 슬롯을 연결하면 같은 문제가 생긴다.
   - 반영: 스펙에 문제 있는 슬롯이 하나라도 있으면 `fingerprint_inputs`가 NaN을 돌려줘 매번
     다시 실행한다. 다시 실행해도 다시 실패하는 것을 확인했다.
3. **클래식 렌더러는 `advanced` 입력을 숨기지 않는다.**
   - Nodes 2.0은 이 입력을 "Show advanced inputs" 뒤로 숨긴다.
   - 반영: 확장이 `widget.hidden = true`를 설정한다. 클래식 렌더러에만 영향이 있다. Nodes 2.0은
     `options.hidden`을 보기 때문이다.
4. **출력을 정리하는 위치.**
   - 프로토타입 `onNodeCreated`는 생성 직후 동기로 호출되고, 불러올 때도 `configure`보다 먼저
     실행된다.
   - 여기서 출력을 비우고 `onConfigure`에서 `slot_spec`으로 복원하면, 다시 열기·붙여넣기·실행
     취소·탭 전환·서브그래프가 모두 같은 결과를 낸다.
   - 확장 훅 `nodeCreated`는 비동기로 호출되므로 이 용도로 쓰지 않는다.
5. **Nodes 2.0은 슬롯 변경을 자동으로 반영한다.** 출력의 추가·삭제와 라벨·타입 변경이 별도
   갱신 없이 DOM에 나타났다. obvpm이 1.52용으로 넣은 강제 갱신 우회는 필요 없다.
6. **Tailscale을 거쳐도 Host 헤더가 보존된다.**
   - 같은 Origin의 쓰기 요청은 통과했다. 다른 Origin은 core 미들웨어가 아니라 이 노드의 검사
     (`origin_mismatch`)에서 막혔다.
   - 로컬 접속에서는 core 미들웨어가 먼저 403을 돌려준다.
   - 헤더가 없거나 `Sec-Fetch-Site: same-site`인 요청도 거부된다.
7. **multipart 스트리밍은 업로드 크기 제한을 받지 않는다.**
   - `client_max_size`가 1MiB인 앱에 3MiB를 보내면, `request.multipart()`는 끝까지 읽고
     `request.post()`만 413을 낸다.
   - 반영: Phase 1의 업로드는 스트리밍하면서 크기를 직접 센다.
8. **이미지 디코딩은 core 경로를 쓴다.**
   - 이 버전의 LoadImage는 `InputImpl.VideoFromFile(path).get_components()`(PyAV)로 디코딩하고,
     실패하면 Pillow로 돌아간다. Pillow로 직접 변환하면 결과가 다르다.

     | 이미지 | 크기·방향 | 최대 차이 |
     | --- | --- | --- |
     | EXIF 방향 6 JPEG | 같음 (양쪽 모두 회전 적용) | 0.204 (색 경계의 크로마 업샘플링 차이) |
     | 반투명 RGBA PNG | 같음 | 0 |
     | 16비트 그레이 PNG | 같음 (Pillow 경로는 별도 처리 필요) | 0 |
     | 무손실 WebP | 같음 | 0.0038 |

   - 반영: Phase 2의 변환은 LoadImage와 같은 경로(첫 프레임, intermediate device·dtype)를 써서,
     같은 파일을 Load Image로 불렀을 때와 같은 텐서를 낸다.
9. **실패 표시.** 실제 브라우저에서는 표준 오류 대화상자("Node threw an error during
   execution.")에 노드 ID·타입과 메시지가 표시된다 (아래 수동 확인). 헤드리스 화면에서는 이
   대화상자가 재현되지 않아, 자동 검사는 기록 상태 `error`로 판정한다.
10. **휠.** 스크롤할 내용이 없는 패널 위에서 휠을 돌려도 캔버스가 확대·축소되지 않았다 (배율
    0.9 유지). 스크롤할 내용이 있으면 패널이 휠 이벤트를 막는다.
11. **테스트 환경.**
    - `node --test`는 디렉터리 인자를 받지 않으므로 glob을 쓴다.
    - 헤드리스 Chromium에는 한글 글꼴이 없어 스크린샷의 한글이 네모로 보이지만, DOM 텍스트는
      정상이다.
    - 콘솔 오류 중 이 노드와 관련된 것은 없었다. 기록된 것은 Manager 관련 404, assets 기능의
      `Unknown message type assets.seed.*`, 테스트 스크립트가 초기화 전에 앱에 접근해 생긴
      경고, 일부러 일으킨 검증 오류의 400이다.

## 수동 확인

자동화로 확인하지 못한 항목을 2026년 10월 14일 사용자 브라우저(클래식 렌더러)에서 확인했다.

1. **패널 표시**: Load Bundle에서 `Spike A`를 고르면 한글과 썸네일이 정상으로 보였다.
   - 여러 줄 텍스트가 세로 가운데 정렬되어, 이름·타입 칸이 문단 중간에 붙었다. 행을 위쪽
     정렬로 바꿨다.
   - 노드 아래에 빈 공간이 남는다. Phase 3에서 패널 높이를 내용에 맞춰 계산한다.
2. **실패 표시**: `ref_2`를 Preview Image에 연결하고 `Spike C`로 바꾸면 패널과 드롭다운에 누락
   경고가 보였다. 실행하면 표준 오류 대화상자에 메시지가 표시됐다.
3. **모달 안 `Ctrl+S`**: 브라우저의 페이지 저장 대화상자가 떴다.
   - 원인: 평소에는 ComfyUI의 단축키 처리기가 `Ctrl+S`의 브라우저 기본 동작을 취소한다.
     모달이 키 이벤트 전파를 막아 그 처리기가 이벤트를 받지 못했다.
   - 수정: 모달이 `Ctrl/Cmd+S`를 직접 취소한다. 브라우저 시나리오에 `defaultPrevented` 검사를
     추가했다 (헤드리스 Chromium은 저장 대화상자를 띄우지 않아 처음 검사에서 놓쳤다).
   - Phase 4의 편집기는 자기가 쓰는 단축키를 직접 처리해야 한다. ComfyUI가 가로채던 다른
     단축키(`Ctrl+O` 등)의 브라우저 기본 동작도 막을지는 Phase 4에서 정한다.
   - Phase 4에서 정했다: 모달은 `Ctrl/Cmd+S`(번들 저장)와 `Ctrl/Cmd+O`(취소만)를 직접 처리한다.
     편집기가 다시 그려지면서 포커스가 `<body>`로 빠지는 경우도 있어서, 모달이 열려 있는 동안
     모달 밖을 대상으로 한 키·붙여넣기 이벤트를 `window` 캡처 단계에서 막고 포커스를 모달로
     되돌린다.
4. (선택) Nodes 2.0에서 1~2를 반복하는 항목은 진행하지 않았다.

## 남은 제약

- 서브그래프 안의 로더에서 번들을 바꿀 때 서브그래프 출력의 타입이 갱신되는지는 확인하지
  않았다. 변환, 실행, 다시 열기는 통과했다. (Phase 3에서 확인했다. 연결된 슬롯은 타입을 바꾸지
  않으므로 서브그래프 출력도 그대로 유지된다.)
- 프런트엔드를 업데이트한 뒤에는 브라우저 시나리오를 다시 실행한다.

## 재현

```bash
node --test "tests/js/*.test.mjs"
npm install --prefix /tmp/bl-pw playwright-core@1.60.0
BL_LIBRARY_DIR=<comfy-docker>/user/bundle_library NODE_PATH=/tmp/bl-pw/node_modules \
    node tests/browser/loader_scenarios.cjs
BL_LIBRARY_DIR=<comfy-docker>/user/bundle_library NODE_PATH=/tmp/bl-pw/node_modules \
    node tests/browser/library_scenarios.cjs
```

브라우저 시나리오는 스크린샷과 `results.json`을 `$TMPDIR/bundle-library-loader`,
`$TMPDIR/bundle-library-library`에 저장한다 (`BL_TEST_OUT`으로 변경). Phase 2부터는 시작할 때
`[test] …` 번들 5개를 만들고 끝나면 지운다. 생성 작업이 없을 때 실행한다.
