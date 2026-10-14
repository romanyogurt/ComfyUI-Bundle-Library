"""Runs Load Bundle on a running ComfyUI through API-format prompts.

Creates the test bundles of api_smoke.py, runs graphs of Load Bundle and
preview nodes only, and removes the bundles it created at the end. Sample A is
edited and restored on the way to check that a changed bundle is not served
from the cache. Meant for the test server (see api_smoke.py), the default --base.
"""

import argparse
import io
import json
import time
import urllib.parse

from PIL import Image

from api_smoke import SAMPLES, TEST_SERVER, Api, create_samples, expect, remove_created, sample_image

SLOTS = [("prompt", "text"), ("ref_1", "image"), ("ref_2", "image"), ("use_bgm", "boolean")]


def spec(slots):
    return json.dumps({"v": 1, "slots": [{"name": n, "type": t} for n, t in slots]})


def graph(bundle_id, slots=SLOTS, links=None):
    """Load Bundle (node 1) plus one preview node per (output index, preview class)."""
    links = links if links is not None else [(0, "PreviewAny"), (1, "PreviewImage"), (2, "PreviewImage"), (3, "PreviewAny")]
    prompt = {"1": {"class_type": "BundleLibraryLoad", "inputs": {"bundle_id": bundle_id, "slot_spec": spec(slots)}}}
    for n, (index, preview) in enumerate(links, start=2):
        name = "source" if preview == "PreviewAny" else "images"
        prompt[str(n)] = {"class_type": preview, "inputs": {name: ["1", index]}}
    return prompt


CLIENT_ID = "bundle-library-node-smoke"  # marks the runs these scripts queue


def run(api, prompt):
    """(HTTP status, history entry or error body)."""
    status, body, _ = api.call("POST", "/api/prompt", {"prompt": prompt, "client_id": CLIENT_ID}, prefix="")
    if status != 200:
        return status, body
    prompt_id = body["prompt_id"]
    for _ in range(400):
        entry = api.call("GET", f"/api/history/{prompt_id}", prefix="")[1].get(prompt_id)
        if entry and entry.get("status", {}).get("status_str"):
            return 200, entry
        time.sleep(0.15)
    expect(False, f"prompt {prompt_id} did not finish")


def center_pixel(api, image):
    """The middle pixel of an image a Preview Image node wrote."""
    query = urllib.parse.urlencode({"filename": image["filename"], "subfolder": image.get("subfolder", ""),
                                    "type": image.get("type", "temp")})
    status, data, _ = api.call("GET", f"/api/view?{query}", raw=True, prefix="")
    with Image.open(io.BytesIO(data)) as picture:
        return picture.convert("RGB").getpixel((picture.width // 2, picture.height // 2))


def messages(entry, kind):
    return [m[1] for m in entry["status"]["messages"] if m[0] == kind]


def error_text(entry):
    return " | ".join(m["exception_message"] for m in messages(entry, "execution_error"))


def forget_runs(api):
    """Delete the runs these scripts queued from ComfyUI's job history, so the
    user's queue panel does not fill up with test jobs. Others' runs stay."""
    history = api.call("GET", "/api/history?max_items=10000", prefix="")[1]
    ours = [prompt_id for prompt_id, entry in history.items()
            if len(entry["prompt"]) > 3 and entry["prompt"][3].get("client_id") == CLIENT_ID]
    if ours:
        api.call("POST", "/api/history", {"delete": ours}, prefix="", raw=True)
    print("     ", f"removed {len(ours)} test run(s) from the job history")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=TEST_SERVER)
    api = Api(parser.parse_args().base)
    created = []
    try:
        checks(api, create_samples(api, created))
    finally:
        remove_created(api, created)
        forget_runs(api)


def checks(api, ids):
    for name, (_, _, text, bgm) in SAMPLES.items():
        status, entry = run(api, graph(ids[name]))
        outputs = entry["outputs"] if status == 200 else {}
        expect(status == 200 and entry["status"]["status_str"] == "success", f"{name}: run succeeds")
        expect(outputs.get("2", {}).get("text") == [text], f"{name}: text output is the bundle text, exactly")
        expect(len(outputs.get("3", {}).get("images", [])) == 1 and len(outputs.get("4", {}).get("images", [])) == 1,
               f"{name}: both images reach Preview Image")
        expect(outputs.get("5", {}).get("text") == [str(bgm)], f"{name}: boolean output {bgm}")

    sample_a = ids["[test] Sample A (red)"]
    run(api, graph(sample_a))  # running B replaced A's cached outputs (same node ids)
    status, entry = run(api, graph(sample_a))
    cached = [n for m in messages(entry, "execution_cached") for n in m["nodes"]]
    expect("1" in cached, "unchanged bundle: the loader is served from the cache")

    red, green = (179, 38, 30), (21, 128, 61)  # Sample A's ref_1 and its stand-in
    bundle = api.call("GET", f"/bundles/{sample_a}")[1]
    original = bundle["fields"][0]["value"]
    long_text = "".join(f"line {i:04d}: 긴 여러 줄 텍스트 with emoji 🎨 and  double  spaces\n" for i in range(2000)) + "\n\n  end  "
    stand_in = api.upload(sample_image("#15803d", "A ref_1 replaced"), "a_ref_1_replaced.png")
    fields = [{**bundle["fields"][0], "value": long_text},
              {**bundle["fields"][1], "asset": {"sha256": stand_in, "original_name": "a_ref_1_replaced.png"}},
              *bundle["fields"][2:]]
    status, saved, _ = api.call("PUT", f"/bundles/{sample_a}", {**bundle, "expected_revision": bundle["revision"], "fields": fields})
    expect(status == 200, f"Sample A edited: long text and another ref_1 (revision {saved.get('revision')})")
    try:
        status, entry = run(api, graph(sample_a))
        expect(entry["outputs"]["2"]["text"] == [long_text],
               f"edited bundle: {len(long_text):,} characters of multi-line text come out exactly")
        expect(center_pixel(api, entry["outputs"]["3"]["images"][0]) == green, "edited bundle: the replaced image comes out")
    finally:
        restore = {**saved, "expected_revision": saved["revision"], "fields": bundle["fields"]}
        status, restored, _ = api.call("PUT", f"/bundles/{sample_a}", restore)
        expect(status == 200, f"Sample A restored (revision {restored.get('revision')})")
    status, entry = run(api, graph(sample_a))
    expect(entry["outputs"]["2"]["text"] == [original] and center_pixel(api, entry["outputs"]["3"]["images"][0]) == red,
           "restored bundle: the original text and image come out again")

    with_seed = SLOTS + [("seed", "int")]
    linked = [(0, "PreviewAny"), (4, "PreviewAny")]
    for attempt in ("first", "second"):
        status, entry = run(api, graph(sample_a, with_seed, linked))
        expect(entry["status"]["status_str"] == "error" and "'seed' is missing from the bundle" in error_text(entry),
               f"linked field missing from the bundle: the loader fails ({attempt} run): {error_text(entry)[:90]}…")
    status, entry = run(api, graph(sample_a, with_seed, [(0, "PreviewAny")]))
    expect(entry["status"]["status_str"] == "success", "missing field on an unlinked output: the run succeeds")
    wrong_type = [("prompt", "int")] + SLOTS[1:]
    status, entry = run(api, graph(sample_a, wrong_type, [(0, "PreviewAny")]))
    expect(entry["status"]["status_str"] == "error" and "is text, not int" in error_text(entry),
           "linked output of another type: the loader fails")

    for bundle_id, slot_spec, wanted in (("", spec(SLOTS), "No bundle selected."),
                                          ("5a1e0000-0000-4000-8000-0000000000ff", spec(SLOTS), "Bundle not found"),
                                          (sample_a, "{broken", "Invalid slot_spec")):
        prompt = graph(sample_a)
        prompt["1"]["inputs"] = {"bundle_id": bundle_id, "slot_spec": slot_spec}
        status, body = run(api, prompt)
        expect(status == 400 and wanted in json.dumps(body), f"validation refuses the prompt: {wanted}")


if __name__ == "__main__":
    main()
