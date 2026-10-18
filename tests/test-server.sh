#!/usr/bin/env bash
# A throwaway ComfyUI for this pack's end-to-end and browser tests, in a Docker
# container: CPU only, with this checkout (mounted read-only) as its only custom
# node, its user, temp, input and output folders inside the container (gone
# when it stops), published on 127.0.0.1:8189. No other ComfyUI is touched.
#
#   tests/test-server.sh start    # start it, wait until it answers
#   tests/test-server.sh status
#   tests/test-server.sh stop
#   tests/test-server.sh run      # start it, run every suite, stop it
#
# The image is built from tests/test-server.Dockerfile on first use: ComfyUI
# COMFYUI_VERSION (default the oldest this pack supports) on Python 3.13 with
# CPU-only PyTorch. Or name another with COMFYUI_IMAGE: one with ComfyUI's
# requirements installed, and ComfyUI in /opt/ComfyUI or in COMFYUI_DIR, a
# ComfyUI folder then mounted there read-only.
#
# The browser suites need Node.js and Playwright's headless Chromium, once:
#   npm ci --prefix tests && tests/node_modules/.bin/playwright-core install chromium-headless-shell
set -euo pipefail

NODE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME=bundle-library-test
PORT="${BUNDLE_LIBRARY_TEST_PORT:-8189}"
COMFYUI_VERSION="${COMFYUI_VERSION:-v0.38.0}"
DATA=/tmp/bundle-library-test
NODE_DIR=/opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library
URL="http://127.0.0.1:$PORT"
API="$URL/api/bundle-library/v1"

running() { docker container inspect "$NAME" >/dev/null 2>&1; }

image() {
    if [ -n "${COMFYUI_IMAGE:-}" ]; then
        echo "$COMFYUI_IMAGE"
        return
    fi
    local tag="bundle-library-test-comfyui:$COMFYUI_VERSION"
    if ! docker image inspect "$tag" >/dev/null 2>&1; then
        echo "Building $tag, once (some minutes)" >&2
        docker build -t "$tag" --build-arg "COMFYUI_VERSION=$COMFYUI_VERSION" - \
            <"$NODE/tests/test-server.Dockerfile" >&2
    fi
    echo "$tag"
}

start() {
    if running; then
        echo "$NAME is already running at $URL"
        return
    fi
    local image comfyui=()
    image=$(image)
    if [ -n "${COMFYUI_DIR:-}" ]; then
        comfyui=(--mount "type=bind,source=$COMFYUI_DIR,target=/opt/ComfyUI,readonly")
    fi
    # custom_nodes is an empty tmpfs that holds only this checkout, whatever the ComfyUI folder has there.
    docker run -d --rm --name "$NAME" --init -p "127.0.0.1:$PORT:$PORT" -e CUDA_VISIBLE_DEVICES= \
        ${comfyui[@]+"${comfyui[@]}"} \
        --mount "type=tmpfs,target=/opt/ComfyUI/custom_nodes" \
        --mount "type=bind,source=$NODE,target=$NODE_DIR,readonly" \
        -w /opt/ComfyUI --entrypoint sh "$image" -c "
            mkdir -p $DATA/user/default $DATA/temp $DATA/output $DATA/input &&
            printf '%s' '{\"Comfy.VueNodes.Enabled\": false, \"Comfy.TutorialCompleted\": true}' \
                > $DATA/user/default/comfy.settings.json &&
            exec python main.py --cpu --listen 0.0.0.0 --port $PORT --disable-auto-launch --preview-method none \
                --user-directory $DATA/user --temp-directory $DATA/temp --output-directory $DATA/output \
                --input-directory $DATA/input --database-url sqlite:///:memory: \
                --disable-all-custom-nodes --whitelist-custom-nodes ComfyUI-Bundle-Library" >/dev/null
    for _ in $(seq 1 90); do
        if curl -sf --max-time 2 "$API/health" >/dev/null; then
            echo "$NAME ready at $URL"
            return
        fi
        sleep 1
    done
    echo "$NAME did not answer; the end of its log:" >&2
    docker logs --tail 40 "$NAME" >&2
    stop
    exit 1
}

stop() {
    if running; then
        docker stop "$NAME" >/dev/null
        echo "$NAME stopped"
    else
        echo "$NAME is not running"
    fi
}

status() {
    if running; then
        echo "$NAME is running at $URL: $(curl -s --max-time 2 "$API/health")"
        docker stats --no-stream --format '{{.Name}}: memory {{.MemUsage}}, CPU {{.CPUPerc}}' "$NAME"
    else
        echo "$NAME is not running"
    fi
}

# A bundle the suites did not create: it must still be there when they finish.
OWNED='{"name": "[test] User owned", "tags": ["test"], "fields": [{"name": "note", "type": "text", "value": "keep me"}]}'

run() {
    start
    trap stop EXIT
    local failed=() in_test=(docker exec -w "$NODE_DIR" "$NAME")
    local owned
    owned=$(curl -sf -X POST "$API/bundles" -H "X-Bundle-Library: 1" -H "Content-Type: application/json" \
        -d "$OWNED" | python3 -c "import json, sys; print(json.load(sys.stdin)['id'])")
    step() {  # step NAME COMMAND...
        local name=$1
        shift
        echo "=== $name"
        "$@" || failed+=("$name")
    }
    step "Python unit tests" "${in_test[@]}" python -m unittest discover -s tests -t .
    step "JS unit tests" node --test "$NODE"/tests/js/*.test.mjs
    step "LoadImage equality" "${in_test[@]}" python tests/e2e/compare_load_image.py
    step "LoadVideo/LoadAudio equality" "${in_test[@]}" python tests/e2e/compare_media.py
    step "cache with the real executor" "${in_test[@]}" python tests/e2e/cache_race.py
    step "choices with the real executor" "${in_test[@]}" python tests/e2e/choice_run.py
    for script in api_smoke node_smoke media_smoke security_smoke; do
        step "$script" "${in_test[@]}" python "tests/e2e/$script.py" --base "http://127.0.0.1:$PORT"
    done
    # As through another host name (a VPN, a reverse proxy): on a loopback host ComfyUI's own Origin check
    # answers first, on another this API's own check must.
    step "security_smoke, another host" "${in_test[@]}" python tests/e2e/security_smoke.py \
        --base "http://127.0.0.1:$PORT" --host "192.0.2.1:$PORT"
    if (cd "$NODE/tests/browser" && node -e 'require.resolve("playwright-core")') 2>/dev/null; then
        # BL_TEST_*: the scenarios that place, read or back-date library files do it in the container.
        for suite in loader library media race trash compat category list batch window tags export import i18n choice; do
            step "$suite browser scenarios" env COMFY_URL="$URL" BL_TEST_CONTAINER="$NAME" \
                BL_TEST_LIBRARY="$DATA/user/bundle_library" node "$NODE/tests/browser/${suite}_scenarios.cjs"
        done
    else
        echo "=== the browser scenarios need playwright-core (see the top of $0)"
        failed+=("browser scenarios: no playwright-core")
    fi
    if curl -sf "$API/bundles/$owned" >/dev/null; then
        echo "=== the bundle the suites did not create is still there"
    else
        failed+=("a bundle the suites did not create was removed")
    fi
    if [ ${#failed[@]} -eq 0 ]; then
        echo "=== all passed"
    else
        printf '=== FAILED: %s\n' "${failed[@]}"
        return 1
    fi
}

case "${1:-}" in
    start) start ;;
    stop) stop ;;
    status) status ;;
    run) run ;;
    *) echo "usage: $0 start|stop|status|run" >&2; exit 2 ;;
esac
