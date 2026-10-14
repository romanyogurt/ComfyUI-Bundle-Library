# ComfyUI Bundle Library

텍스트·이미지·값을 이름 붙은 **번들**로 묶어 보관하고, **Load Bundle** 노드에서 번들을
고르면 그 번들의 필드가 그대로 출력 슬롯이 되는 커스텀 노드 팩이다. 같은 이름의 필드를
가진 번들끼리는 선택만 바꿔도 연결이 유지된다.

## 상태

Phase 1(번들 저장소와 API)까지 진행했다.

- 번들과 이미지는 ComfyUI 사용자 디렉토리의 `bundle_library/`에 저장되고 HTTP API로 만들고
  고칠 수 있다. 형식과 API는 [docs/data-format.md](docs/data-format.md)에 있다.
- Load Bundle 노드는 아직 Phase 0의 검증용 고정 번들(`bundle_library/spike_store.py`)을 쓴다.
  Phase 2에서 저장소의 번들을 읽도록 바꾼다.
- 편집 화면은 Phase 4에서 만든다.

설계와 단계는 comfy-docker 저장소의 `docs/bundle-library-plan.md`, Phase 0 검증 결과는
[docs/compatibility.md](docs/compatibility.md)에 있다.

## 테스트

```bash
# Python 단위 테스트 (컨테이너 안, ComfyUI 서버가 필요 없음)
docker compose exec -T -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library comfyui \
    python -m unittest discover -s tests -t .

# 실행 중인 서버의 API: 샘플 번들 "Sample A (red)", "Sample B (blue)"를 만들고 확인
docker compose exec -T -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library comfyui \
    python tests/e2e/api_smoke.py            # --verify-only 는 확인만

# 슬롯 조정 순수 함수 (호스트의 Node.js)
node --test "tests/js/*.test.mjs"

# 실행 중인 ComfyUI 대상 브라우저 시나리오
npm install --prefix /tmp/bl-pw playwright-core@1.60.0
NODE_PATH=/tmp/bl-pw/node_modules node tests/browser/phase0_scenarios.cjs
```

`docker compose` 명령은 comfy-docker 저장소 루트에서 실행한다. 브라우저 시나리오는
`http://127.0.0.1:8188`(`COMFY_URL`로 변경)에 접속한다. 설정·워크플로 저장 같은 쓰기 요청은
브라우저에서 가로채 서버로 보내지 않으며, 프리뷰 노드만 있는 작은 그래프를 실행한다. 생성
작업이 없을 때 실행한다.
