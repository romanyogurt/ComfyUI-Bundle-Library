"""Checks the write protection and limits of a running Bundle Library API.

Every request here must be refused, so nothing in the library changes. Only
the standard library is used, so it also runs on the host. The default --base
is the test server (see api_smoke.py).

On a loopback host ComfyUI's own Origin check answers a foreign Origin before
this API sees it. --host sends another Host header, as a request through the
Tailscale domain would; then this API's own Origin check must answer:
    python3 tests/e2e/security_smoke.py --host 192.0.2.1:8189
"""

import argparse
import json
import sys
import urllib.error
import urllib.request
import uuid

P = "/bundle-library/v1"
WRITE = {"X-Bundle-Library": "1"}
# Text that would reveal where the server keeps its files.
PATH_HINTS = ("/opt/", "/home/", "/tmp/", "user/bundle_library", "\\\\")
failures = []
host = None  # the Host header to send, from --host


def call(base, method, path, body=None, headers=None):
    """(status, decoded JSON body or {}, headers). Never raises for HTTP errors."""
    headers = dict(headers or {})
    if host:
        headers["Host"] = host
    if isinstance(body, dict):
        body = json.dumps(body).encode()
        headers.setdefault("Content-Type", "application/json")
    request = urllib.request.Request(base + path, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read()
            status, reply_headers = response.status, response.headers
    except urllib.error.HTTPError as e:
        raw, status, reply_headers = e.read(), e.code, e.headers
    try:
        payload = json.loads(raw or b"{}")
    except ValueError:
        payload = {"_text": raw[:200].decode("utf-8", "replace")}
    return status, payload, reply_headers


def check(condition, label, detail=""):
    print(("ok  " if condition else "FAIL"), label, detail if not condition else "")
    if not condition:
        failures.append(label)


def refused(base, label, method, path, status, code, body=None, headers=None, core_may_refuse=False):
    """`core_may_refuse`: on a loopback address ComfyUI's own origin check answers
    a foreign Origin with a bare 403 before this API sees the request."""
    got, payload, _ = call(base, method, path, body, headers)
    error = payload.get("error", {})
    leaked = [hint for hint in PATH_HINTS if hint in json.dumps(payload)]
    by_core = core_may_refuse and got == 403 and not error
    check((by_core or (got == status and error.get("code") == code)) and not leaked,
          f"{label}: {status} {'(refused by ComfyUI itself)' if by_core else code}",
          f"got {got} {payload} leaked={leaked}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8189")
    parser.add_argument("--host", help="Host header to send, a name that is not loopback")
    args = parser.parse_args()
    global host
    host = args.host
    # Only for a loopback Host may ComfyUI's Origin check answer first.
    core_origin = host is None
    api = args.base.rstrip("/") + "/api"
    some_id = str(uuid.uuid4())
    bundle = {"name": "[test] must not be created", "fields": []}

    # Writes need the header, and no other site may send them.
    refused(api, "create without the header", "POST", P + "/bundles", 403, "missing_header", bundle)
    refused(api, "create from another origin", "POST", P + "/bundles", 403, "origin_mismatch", bundle,
            {**WRITE, "Origin": "https://evil.example"}, core_may_refuse=core_origin)
    refused(api, "create with Origin: null", "POST", P + "/bundles", 403, "origin_mismatch", bundle,
            {**WRITE, "Origin": "null"}, core_may_refuse=core_origin)
    refused(api, "create from a cross-site page", "POST", P + "/bundles", 403, "cross_site", bundle,
            {**WRITE, "Sec-Fetch-Site": "cross-site"}, core_may_refuse=True)
    refused(api, "update without the header", "PUT", f"{P}/bundles/{some_id}", 403, "missing_header",
            {**bundle, "expected_revision": 1})
    refused(api, "delete without the header", "DELETE", f"{P}/bundles/{some_id}?expected_revision=1",
            403, "missing_header")
    refused(api, "duplicate without the header", "POST", f"{P}/bundles/{some_id}/duplicate", 403,
            "missing_header", {"mode": "values"})
    refused(api, "upload from another origin", "POST", P + "/assets", 403, "origin_mismatch", b"x",
            {**WRITE, "Origin": "https://evil.example", "Content-Type": "multipart/form-data; boundary=x"},
            core_may_refuse=core_origin)

    # A browser on another site cannot even send the header: the preflight is not allowed.
    status, _, headers = call(api, "OPTIONS", P + "/bundles", headers={
        "Origin": "https://evil.example", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-bundle-library,content-type"})
    allowed = headers.get("Access-Control-Allow-Origin")
    check(allowed not in ("*", "https://evil.example"), "preflight from another origin is not allowed",
          f"status {status}, Access-Control-Allow-Origin={allowed!r}")

    # Ids are checked before any file is touched; errors name no paths.
    refused(api, "bundle id with ../", "GET", P + "/bundles/..%2F..%2Fetc%2Fpasswd", 400, "invalid_id")
    refused(api, "bundle id that is not a UUID", "GET", P + "/bundles/not-a-uuid", 400, "invalid_id")
    refused(api, "unknown bundle", "GET", f"{P}/bundles/{some_id}", 404, "not_found")
    refused(api, "asset id in upper case", "GET", f"{P}/assets/{'A' * 64}", 400, "invalid_id")
    refused(api, "unknown asset", "GET", f"{P}/assets/{'0' * 64}", 404, "not_found")
    for path in ("/assets/..%2F..%2Fbundles", "/assets/%2e%2e", "/assets/" + "a" * 63 + "%2F"):
        got, payload, _ = call(api, "GET", P + path)
        check(got in (400, 404) and "error" in payload, f"asset path trick {path}: refused", f"got {got}")

    # Size limits (the header is present, so these reach the limits).
    huge_json = b'{"name": "' + b"a" * (4 * 1024 * 1024) + b'"}'
    refused(api, "JSON body over 4 MB", "POST", P + "/bundles", 413, "too_large", huge_json,
            {**WRITE, "Content-Type": "application/json"})
    boundary = uuid.uuid4().hex
    upload = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.png"\r\n'
              "Content-Type: image/png\r\n\r\n").encode() + b"\0" * (50 * 1024 * 1024 + 1) + f"\r\n--{boundary}--\r\n".encode()
    refused(api, "upload over 50 MB", "POST", P + "/assets", 413, "too_large", upload,
            {**WRITE, "Content-Type": f"multipart/form-data; boundary={boundary}"})
    refused(api, "form body where JSON is expected", "POST", P + "/bundles", 415, "unsupported_media_type",
            b"name=x", {**WRITE, "Content-Type": "application/x-www-form-urlencoded"})

    status, health, _ = call(api, "GET", P + "/health")
    check(status == 200 and not any(hint in json.dumps(health) for hint in PATH_HINTS), "health names no paths")
    names = [b["name"] for b in call(api, "GET", P + "/bundles")[1].get("bundles", [])]
    check(bundle["name"] not in names, "nothing was created")

    print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'all checks passed'}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
