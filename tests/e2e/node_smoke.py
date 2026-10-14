"""Runs Load Bundle on a running ComfyUI through API-format prompts.

Uses the sample bundles from api_smoke.py (creating them if missing) and only
preview nodes. Sample A is edited and then restored to check that a changed
bundle is not served from the cache. Run inside the container:
    docker compose exec -T -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library \\
        comfyui python tests/e2e/node_smoke.py
"""

import argparse
import json
import time

from api_smoke import SAMPLES, Api, ensure_samples, expect

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


def run(api, prompt):
    """(HTTP status, history entry or error body)."""
    status, body, _ = api.call("POST", "/api/prompt", {"prompt": prompt, "client_id": "bundle-library-node-smoke"},
                               prefix="")
    if status != 200:
        return status, body
    prompt_id = body["prompt_id"]
    for _ in range(400):
        entry = api.call("GET", f"/api/history/{prompt_id}", prefix="")[1].get(prompt_id)
        if entry and entry.get("status", {}).get("status_str"):
            return 200, entry
        time.sleep(0.15)
    expect(False, f"prompt {prompt_id} did not finish")


def messages(entry, kind):
    return [m[1] for m in entry["status"]["messages"] if m[0] == kind]


def error_text(entry):
    return " | ".join(m["exception_message"] for m in messages(entry, "execution_error"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8188")
    api = Api(parser.parse_args().base)
    ensure_samples(api)
    ids = {b["name"]: b["id"] for b in api.call("GET", "/bundles?tag=sample")[1]["bundles"]}

    for name, (_, _, text, bgm) in SAMPLES.items():
        status, entry = run(api, graph(ids[name]))
        outputs = entry["outputs"] if status == 200 else {}
        expect(status == 200 and entry["status"]["status_str"] == "success", f"{name}: run succeeds")
        expect(outputs.get("2", {}).get("text") == [text], f"{name}: text output is the bundle text, exactly")
        expect(len(outputs.get("3", {}).get("images", [])) == 1 and len(outputs.get("4", {}).get("images", [])) == 1,
               f"{name}: both images reach Preview Image")
        expect(outputs.get("5", {}).get("text") == [str(bgm)], f"{name}: boolean output {bgm}")

    sample_a = ids["Sample A (red)"]
    run(api, graph(sample_a))  # running B replaced A's cached outputs (same node ids)
    status, entry = run(api, graph(sample_a))
    cached = [n for m in messages(entry, "execution_cached") for n in m["nodes"]]
    expect("1" in cached, "unchanged bundle: the loader is served from the cache")

    bundle = api.call("GET", f"/bundles/{sample_a}")[1]
    original = bundle["fields"][0]["value"]
    edited = {**bundle, "expected_revision": bundle["revision"],
              "fields": [{**bundle["fields"][0], "value": original + " (edited)"}, *bundle["fields"][1:]]}
    status, saved, _ = api.call("PUT", f"/bundles/{sample_a}", edited)
    expect(status == 200, f"Sample A edited (revision {saved.get('revision')})")
    try:
        status, entry = run(api, graph(sample_a))
        expect(entry["outputs"]["2"]["text"] == [original + " (edited)"], "edited bundle: the next run uses the new text")
    finally:
        restore = {**saved, "expected_revision": saved["revision"],
                   "fields": [{**saved["fields"][0], "value": original}, *saved["fields"][1:]]}
        status, restored, _ = api.call("PUT", f"/bundles/{sample_a}", restore)
        expect(status == 200, f"Sample A restored (revision {restored.get('revision')})")

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
