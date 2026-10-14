"""Smoke test against a running ComfyUI: creates two test bundles, reads them
back through the API and removes them again.

Run inside the container (it needs Pillow), for example:
    docker compose exec -T -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library \\
        comfyui python tests/e2e/api_smoke.py            # create, verify, remove
    ... python tests/e2e/api_smoke.py --keep             # create and verify, keep them
    ... python tests/e2e/api_smoke.py --verify-only      # verify kept ones (after a restart), remove

The bundles are "[test] Sample A (red)" and "[test] Sample B (blue)". Removing
moves them to the library's trash; their trash files are deleted as well when
the library folder is reachable (--library-dir, the container's path by default).
"""

import argparse
import hashlib
import io
import json
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

P = "/bundle-library/v1"
LIBRARY_DIR = "/opt/ComfyUI/user/bundle_library"  # inside the container
SAMPLES = {
    "[test] Sample A (red)": ("#b3261e", "#e8710a", "An adult woman in a red dress.\n\n  빨간 드레스, 앞뒤 공백 유지  ", True),
    "[test] Sample B (blue)": ("#1a56db", "#0e7490", "An adult woman in a blue shirt.\n\n  파란 셔츠  ", False),
}


class Api:
    def __init__(self, base):
        self.base = base.rstrip("/")

    def call(self, method, path, body=None, headers=None, raw=False, prefix=P):
        """`path` is under the Bundle Library API unless `prefix` says otherwise."""
        headers = dict(headers or {})
        if method != "GET":
            headers["X-Bundle-Library"] = "1"
        if isinstance(body, dict):
            body = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + prefix + path, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = response.read()
                return response.status, (data if raw else json.loads(data)), response.headers
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}"), e.headers

    def upload(self, data, filename, kind=None):
        """Upload a file; `kind` (image, video, audio) goes first, as the browser sends it."""
        boundary = uuid.uuid4().hex
        body = f'--{boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n{kind}\r\n'.encode() if kind else b""
        body += (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                 f"Content-Type: application/octet-stream\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
        status, payload, _ = self.call("POST", "/assets", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
        expect(status in (200, 201), f"upload {filename}: HTTP {status} {payload}")
        return payload["asset"]["sha256"]


def expect(condition, message):
    if not condition:
        print("FAIL", message)
        sys.exit(1)
    print("ok  ", message)


def sample_image(color, label):
    image = Image.new("RGB", (512, 768), color)
    ImageDraw.Draw(image).text((32, 32), label, fill="white", font=ImageFont.load_default(size=64))
    out = io.BytesIO()
    image.save(out, "PNG")
    return out.getvalue()


def sample_ids(api):
    """{name: id} of the test bundles in the library."""
    return {b["name"]: b["id"] for b in api.call("GET", "/bundles")[1]["bundles"] if b["name"] in SAMPLES}


def ensure_samples(api):
    """Create the test bundles that are missing; returns {name: id}."""
    existing = sample_ids(api)
    for name, (color_1, color_2, prompt, bgm) in SAMPLES.items():
        if name in existing:
            print("     ", name, "already exists:", existing[name])
            continue
        letter = name.split()[2]
        refs = [api.upload(sample_image(c, f"{letter} ref_{i}"), f"{letter.lower()}_ref_{i}.png")
                for i, c in ((1, color_1), (2, color_2))]
        status, bundle, _ = api.call("POST", "/bundles", {
            "name": name,
            "tags": ["test"],
            "note": "API smoke test",
            "fields": [
                {"name": "prompt", "type": "text", "value": prompt},
                {"name": "ref_1", "type": "image", "asset": {"sha256": refs[0], "original_name": f"{letter.lower()}_ref_1.png"}},
                {"name": "ref_2", "type": "image", "asset": {"sha256": refs[1], "original_name": f"{letter.lower()}_ref_2.png"}},
                {"name": "use_bgm", "type": "boolean", "value": bgm},
            ],
        })
        expect(status == 201, f"created {name}: {bundle.get('id', bundle)}")
    return sample_ids(api)


def remove_samples(api, library_dir):
    """Delete the test bundles, and their trash files when `library_dir` is reachable."""
    removed = []
    for bundle in api.call("GET", "/bundles")[1]["bundles"]:
        if bundle["name"] in SAMPLES:
            status, _, _ = api.call("DELETE", f"/bundles/{bundle['id']}?expected_revision={bundle['revision']}")
            expect(status == 200, f"removed {bundle['name']}")
            removed.append(bundle["id"])
    trash = Path(library_dir) / "trash" if library_dir else None
    if removed and trash and trash.is_dir():
        purged = [f for f in trash.iterdir() if f.name.split(".")[0] in removed]
        for file in purged:
            file.unlink()
        print("     ", f"deleted {len(purged)} trash file(s)")


def verify(api):
    status, health, _ = api.call("GET", "/health")
    expect(status == 200 and health["writable"] and not health["corrupt"], f"health {health}")
    found = sample_ids(api)
    expect(set(SAMPLES) <= set(found), "both test bundles listed")
    for name, (_, _, prompt, bgm) in SAMPLES.items():
        status, bundle, _ = api.call("GET", f"/bundles/{found[name]}")
        expect(status == 200, f"{name}: GET revision {bundle['revision']}")
        fields = {f["name"]: f for f in bundle["fields"]}
        expect(fields["prompt"]["value"] == prompt, f"{name}: text kept exactly")
        expect(fields["use_bgm"]["value"] is bgm, f"{name}: boolean {bgm}")
        for ref in ("ref_1", "ref_2"):
            asset = fields[ref]["asset"]
            status, data, headers = api.call("GET", f"/assets/{asset['sha256']}", raw=True)
            expect(status == 200 and hashlib.sha256(data).hexdigest() == asset["sha256"]
                   and headers["Content-Type"] == "image/png",
                   f"{name}: {ref} original ({asset['width']}x{asset['height']}, {len(data)} bytes)")
            status, data, headers = api.call("GET", f"/assets/{asset['sha256']}/thumb?size=256", raw=True)
            expect(status == 200 and headers["Content-Type"] == "image/webp", f"{name}: {ref} thumbnail")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8188")
    parser.add_argument("--keep", action="store_true", help="leave the test bundles in the library")
    parser.add_argument("--verify-only", action="store_true", help="verify test bundles kept earlier")
    parser.add_argument("--library-dir", default=LIBRARY_DIR, help="for deleting the trash files ('' to keep them)")
    args = parser.parse_args()
    api = Api(args.base)
    try:
        if not args.verify_only:
            ensure_samples(api)
        verify(api)
    finally:
        if not args.keep:
            remove_samples(api, args.library_dir)


if __name__ == "__main__":
    main()
