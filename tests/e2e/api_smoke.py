"""Smoke test against a running ComfyUI: makes sure the sample bundles exist and
reads them back through the API.

Run inside the container (it needs Pillow), for example:
    docker compose exec -T -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library \\
        comfyui python tests/e2e/api_smoke.py            # create if missing, then verify
    ... python tests/e2e/api_smoke.py --verify-only      # e.g. after a restart

The two bundles, "Sample A (red)" and "Sample B (blue)", stay in the library
as examples; delete them from the library when no longer wanted.
"""

import argparse
import hashlib
import io
import json
import sys
import urllib.error
import urllib.request
import uuid

from PIL import Image, ImageDraw, ImageFont

P = "/bundle-library/v1"
SAMPLES = {
    "Sample A (red)": ("#b3261e", "#e8710a", "An adult woman in a red dress.\n\n  빨간 드레스, 앞뒤 공백 유지  ", True),
    "Sample B (blue)": ("#1a56db", "#0e7490", "An adult woman in a blue shirt.\n\n  파란 셔츠  ", False),
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

    def upload(self, data, filename):
        boundary = uuid.uuid4().hex
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
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


def ensure_samples(api):
    existing = {b["name"]: b["id"] for b in api.call("GET", "/bundles")[1]["bundles"]}
    for name, (color_1, color_2, prompt, bgm) in SAMPLES.items():
        if name in existing:
            print("     ", name, "already exists:", existing[name])
            continue
        letter = name.split()[1]
        refs = [api.upload(sample_image(c, f"{letter} ref_{i}"), f"{letter.lower()}_ref_{i}.png")
                for i, c in ((1, color_1), (2, color_2))]
        status, bundle, _ = api.call("POST", "/bundles", {
            "name": name,
            "tags": ["sample"],
            "note": "Phase 1 API smoke test",
            "fields": [
                {"name": "prompt", "type": "text", "value": prompt},
                {"name": "ref_1", "type": "image", "asset": {"sha256": refs[0], "original_name": f"{letter.lower()}_ref_1.png"}},
                {"name": "ref_2", "type": "image", "asset": {"sha256": refs[1], "original_name": f"{letter.lower()}_ref_2.png"}},
                {"name": "use_bgm", "type": "boolean", "value": bgm},
            ],
        })
        expect(status == 201, f"created {name}: {bundle.get('id', bundle)}")


def verify(api):
    status, health, _ = api.call("GET", "/health")
    expect(status == 200 and health["writable"] and not health["corrupt"], f"health {health}")
    listing = api.call("GET", "/bundles?tag=sample")[1]["bundles"]
    found = {b["name"]: b for b in listing}
    expect(set(SAMPLES) <= set(found), f"both samples listed ({len(listing)} with tag 'sample')")
    for name, (_, _, prompt, bgm) in SAMPLES.items():
        status, bundle, _ = api.call("GET", f"/bundles/{found[name]['id']}")
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
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    api = Api(args.base)
    if not args.verify_only:
        ensure_samples(api)
    verify(api)


if __name__ == "__main__":
    main()
