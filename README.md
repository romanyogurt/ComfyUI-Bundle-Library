# ComfyUI Bundle Library

텍스트·이미지·비디오·오디오·값을 이름 붙은 **번들**로 묶어 보관하고, **Load Bundle** 노드에서 번들을
고르면 그 번들의 필드가 그대로 출력 슬롯이 되는 커스텀 노드 팩이다. 같은 이름의 필드를
가진 번들끼리는 선택만 바꿔도 연결이 유지된다.

## 상태

Phase 5(안정화와 설치)까지 마쳐 MVP를 완성했다. comfy-docker에서의 설치·백업·복원 기록은
comfy-docker 저장소의 `docs/bundle-library.md`에 있다.

- 번들과 이미지는 ComfyUI 사용자 디렉토리의 `bundle_library/`에 저장되고, HTTP API로 만들고
  고칠 수 있다. 형식과 API는 [docs/data-format.md](docs/data-format.md)에 있다.
- Load Bundle은 저장소의 번들을 읽는다. 이미지는 core Load Image와 같은 텐서로 변환한다.
- 노드 패널에서 번들을 고르고 내용을 미리 본다. 이미지는 노드 너비에 맞춰 크게 보이고
  (최대 높이 240px), 누르면 원본 크기로 볼 수 있다. 패널은 접을 수 있다. 라이브러리에서
  번들의 필드가 바뀌면 "Update outputs"로 출력 슬롯을 맞춘다.
- 라이브러리 창에서 번들을 만들고, 고치고, 복제하고, 지운다. 이미지는 파일 선택, 붙여넣기
  (Ctrl+V), 끌어 놓기로 올린다.
- 비디오와 오디오 필드(Phase 6)는 core Load Video·Load Audio와 같은 VIDEO·AUDIO를 내보낸다.
  편집기와 노드 미리보기에서 재생할 수 있다.

설계와 단계는 comfy-docker 저장소의 `docs/bundle-library-plan.md`, Phase 0 검증 결과는
[docs/compatibility.md](docs/compatibility.md)에 있다.

## 라이브러리 열기

- Load Bundle 노드의 📚 버튼: 번들 고르기 모드로 열린다. "Use this bundle"을 누르면 그 노드의
  번들이 바뀐다. 노드에서 연결해 둔 출력에 맞는 필드가 없는 번들에는 ⚠ 표시가 붙는다.
- 상단 메뉴: Extensions → Open Bundle Library
- 왼쪽 사이드바의 Bundle Library 탭: 번들 이름을 누르면 라이브러리가 그 번들을 연 채로 열린다.
- 명령 `BundleLibrary.Open`: 기본 단축키는 없다. 설정의 Keybinding에서 지정할 수 있다.

창 안에서 Ctrl+S는 저장, Esc는 닫기다. 저장하지 않은 변경이 있으면 닫거나 다른 번들로
옮기기 전에 묻는다.

## 개발 규칙

- 코드에 나오는 문자열(UI, 오류·로그 메시지, 자동으로 만드는 이름)은 영어로 쓴다. 문서는
  한국어로 쓴다.

## 테스트

테스트는 운영 ComfyUI가 아니라 테스트 서버에서 실행한다. comfy-docker의
`scripts/bundle-library-test-server.sh`가 같은 이미지로 컨테이너 `bundle-library-test`를 띄운다.

- GPU 없이(`--cpu`) 이 노드만 불러온다.
- ComfyUI 소스와 `custom_nodes`는 읽기 전용으로 붙인다.
- user·temp·output·input 폴더는 컨테이너의 `/tmp` 안에 있어서, 컨테이너를 멈추면 함께 사라진다.
- `127.0.0.1:8189`로 연다. 10초 남짓이면 준비되고, 메모리는 0.9 GiB 정도 쓴다.

명령은 comfy-docker 저장소 루트에서 실행한다.

```bash
npm install --prefix /tmp/bl-pw playwright-core@1.60.0   # 브라우저 시나리오용, 처음 한 번

scripts/bundle-library-test-server.sh run     # 서버를 띄워 모든 테스트를 실행하고 멈춘다
```

하나씩 실행할 때는 서버를 띄워 둔다(`start`, `status`, `stop`).

```bash
scripts/bundle-library-test-server.sh start
docker exec -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library bundle-library-test \
    python tests/e2e/node_smoke.py
NODE_PATH=/tmp/bl-pw/node_modules \
    node custom_nodes/ComfyUI-Bundle-Library/tests/browser/library_scenarios.cjs
scripts/bundle-library-test-server.sh stop
```

| 테스트 | 확인하는 것 |
| --- | --- |
| `tests/test_*.py` (`python -m unittest discover -s tests -t .`) | 저장소, 모델, API, 변환, 미디어 검사 |
| `tests/js/*.test.mjs` (호스트의 `node --test`) | 슬롯 조정 순수 함수 |
| `tests/e2e/compare_load_image.py`, `compare_media.py` | 변환 결과가 core LoadImage·LoadVideo·LoadAudio와 같은지 |
| `tests/e2e/api_smoke.py` | 테스트 번들 두 개를 만들어 API로 확인한다 |
| `tests/e2e/node_smoke.py` | Load Bundle을 실행해 출력, 캐시, 오류를 확인한다 |
| `tests/e2e/media_smoke.py` | 비디오·오디오 필드로 Load Bundle을 실행해 VIDEO·AUDIO 출력을 확인한다 |
| `tests/e2e/security_smoke.py` | 쓰기 보호와 제한값 (거부되는 요청만 보낸다) |
| `tests/browser/*_scenarios.cjs` | 헤드리스 Chromium으로 노드, 라이브러리, 비디오·오디오 화면을 조작한다 |
| `tests/e2e/bench_store.py --count 100 --count 1000` | 번들 수에 따른 저장소 속도 (임시 폴더, `run`에는 없음) |

- e2e 스크립트와 브라우저 시나리오의 기본 주소는 테스트 서버다. 다른 서버는 Python 스크립트의
  `--base`, 브라우저 시나리오의 `COMFY_URL`로 지정한다.
- 테스트는 자기가 만든 번들만 id로 골라 지운다. 브라우저 시나리오는 시작할 때 있던 번들이 끝날
  때도 모두 남아 있는지 확인한다. `run`은 테스트가 만들지 않은 번들을 하나 먼저 만들고, 마지막에
  그 번들이 남아 있는지 확인한다.
- 프롬프트를 실행하는 테스트(`node_smoke.py`, `media_smoke.py`, `loader_scenarios.cjs`)는 끝날 때
  자기가 넣은 작업을 작업 기록(job history)에서 client id로 골라 지운다.
- `security_smoke.py`는 표준 라이브러리만 써서 호스트에서도 실행된다. 루프백 주소에서는
  ComfyUI 자체의 Origin 검사가 먼저 거부하므로, `run`은 `--host 192.0.2.1:8189`로 한 번 더
  실행해 Tailscale 주소로 들어온 요청처럼 이 API의 Origin 검사가 답하는지 본다.
- 브라우저 시나리오
  - 설정·워크플로 저장 같은 쓰기 요청은 브라우저에서 가로채 서버로 보내지 않는다.
  - 브라우저 콘솔 오류는 예상한 것만 허용한다: 새 user 폴더에 없는 파일, 시나리오가 일부러
    일으킨 오류 응답, 프런트엔드 시작 때의 경고. 그 밖의 오류가 있으면 실패한다.
  - `loader_scenarios.cjs`만 프리뷰 노드로 된 작은 그래프를 실행한다.
  - `media_scenarios.cjs`는 `tests/browser/fixtures/`의 작은 비디오·오디오 파일을 올린다. 이
    파일은 `tests/browser/make_fixtures.py`(컨테이너에서 실행)로 다시 만들 수 있다.
  - 스크린샷과 결과(`results.json`)는 `/tmp/bundle-library-<시나리오>/`(`BL_TEST_OUT`로 변경)에 남는다.
