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

`docker compose` 명령은 comfy-docker 저장소 루트에서 실행한다.

```bash
# Python 단위 테스트 (ComfyUI 서버가 필요 없음)
docker compose exec -T -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library comfyui \
    python -m unittest discover -s tests -t .

# 이미지·비디오·오디오 변환이 core LoadImage·LoadVideo·LoadAudio와 같은지 (CPU 모드, 서버와 별개)
docker compose exec -T -e CUDA_VISIBLE_DEVICES= -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library \
    comfyui python tests/e2e/compare_load_image.py
docker compose exec -T -e CUDA_VISIBLE_DEVICES= -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library \
    comfyui python tests/e2e/compare_media.py

# 실행 중인 서버: 테스트 번들 두 개를 만들어 API로 확인하고 지운다
docker compose exec -T -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library comfyui \
    python tests/e2e/api_smoke.py            # 재시작 확인: --keep, 재시작 뒤 --verify-only

# 실행 중인 서버: 테스트 번들로 Load Bundle을 실행해 출력, 캐시, 오류를 확인하고 지운다
docker compose exec -T -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library comfyui \
    python tests/e2e/node_smoke.py

# 실행 중인 서버: 비디오·오디오 필드로 Load Bundle을 실행해 VIDEO·AUDIO 출력을 확인하고 지운다
docker compose exec -T -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library comfyui \
    python tests/e2e/media_smoke.py

# 실행 중인 서버: 쓰기 보호와 제한값 (거부되는 요청만 보내므로 아무것도 바뀌지 않는다)
python3 custom_nodes/ComfyUI-Bundle-Library/tests/e2e/security_smoke.py   # --base로 Tailscale 주소 지정

# 번들 100개·1,000개에서 저장소 속도 (임시 폴더, 서버와 별개)
docker compose exec -T -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library comfyui \
    python tests/e2e/bench_store.py --count 100 --count 1000

# 슬롯 조정 순수 함수 (호스트의 Node.js)
node --test "custom_nodes/ComfyUI-Bundle-Library/tests/js/*.test.mjs"

# 실행 중인 ComfyUI 대상 브라우저 시나리오
npm install --prefix /tmp/bl-pw playwright-core@1.60.0
BL_LIBRARY_DIR=user/bundle_library NODE_PATH=/tmp/bl-pw/node_modules \
    node custom_nodes/ComfyUI-Bundle-Library/tests/browser/loader_scenarios.cjs
BL_LIBRARY_DIR=user/bundle_library NODE_PATH=/tmp/bl-pw/node_modules \
    node custom_nodes/ComfyUI-Bundle-Library/tests/browser/library_scenarios.cjs
BL_LIBRARY_DIR=user/bundle_library NODE_PATH=/tmp/bl-pw/node_modules \
    node custom_nodes/ComfyUI-Bundle-Library/tests/browser/media_scenarios.cjs
```

- `api_smoke.py`와 `node_smoke.py`는 `[test] Sample A (red)`, `[test] Sample B (blue)`를 만들고
  끝나면 지운다. 컨테이너 안에서는 휴지통으로 옮겨진 파일까지 지운다(`--library-dir`).
  `node_smoke.py`는 도중에 Sample A를 고쳤다가 되돌려 캐시를 확인한다.
- `security_smoke.py`는 표준 라이브러리만 써서 호스트에서도 실행된다. 루프백 주소에서는
  ComfyUI 자체의 Origin 검사가 먼저 거부하기도 하므로, 이 API의 검사까지 보려면 Tailscale
  주소로도 실행한다.
- 브라우저 시나리오는 `http://127.0.0.1:8188`(`COMFY_URL`로 변경)에 접속한다.
  - 설정·워크플로 저장 같은 쓰기 요청은 브라우저에서 가로채 서버로 보내지 않는다.
  - `loader_scenarios.cjs`는 프리뷰 노드만 있는 작은 그래프를 실행한다.
    `library_scenarios.cjs`와 `media_scenarios.cjs`는 실행하지 않는다.
  - `media_scenarios.cjs`는 `tests/browser/fixtures/`의 작은 비디오·오디오 파일을 올린다. 이
    파일은 `tests/browser/make_fixtures.py`(컨테이너에서 실행)로 다시 만들 수 있다.
  - 시작할 때 `[test] …` 번들 5개를 만들고 끝나면 지운다. 라이브러리 시나리오가 화면에서
    만든 `[test] UI made …` 번들도 지운다. `BL_LIBRARY_DIR`을 주면 휴지통에 옮겨진 파일까지
    지운다.
  - 테스트 이미지는 `assets/`에 남는다. 내용이 매번 같아서 실행할 때마다 늘지는 않는다.
- 실행 중인 서버를 쓰는 테스트는 생성 작업이 없을 때 실행한다.
- 프롬프트를 실행하는 테스트(`node_smoke.py`, `media_smoke.py`, `loader_scenarios.cjs`)는 끝날 때
  자기가 넣은 작업을 ComfyUI 작업 기록(job history)에서 지운다. 테스트의 client id로 골라 지우므로
  다른 작업은 남는다.
