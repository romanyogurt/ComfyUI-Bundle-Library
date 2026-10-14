"""Runs Load Bundle with video and audio fields on a running ComfyUI.

Uploads the browser fixtures (tests/browser/fixtures) into a "[test] Media"
bundle, runs graphs of Load Bundle, core video nodes and preview nodes, and
removes the bundle at the end. Run inside the container while no generation
is running:
    docker compose exec -T -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library comfyui \\
        python tests/e2e/media_smoke.py
"""

import argparse
import json
from pathlib import Path

from api_smoke import LIBRARY_DIR, Api, expect
from node_smoke import error_text, forget_runs, run

NAME = "[test] Media"
FIXTURES = Path(__file__).resolve().parents[1] / "browser" / "fixtures"
SLOTS = [("clip", "video"), ("bgm", "audio"), ("empty_clip", "video")]


def graph(bundle_id, video_slot=0):
    spec = json.dumps({"v": 1, "slots": [{"name": n, "type": t} for n, t in SLOTS]})
    return {
        "1": {"class_type": "BundleLibraryLoad", "inputs": {"bundle_id": bundle_id, "slot_spec": spec}},
        "2": {"class_type": "GetVideoComponents", "inputs": {"video": ["1", video_slot]}},
        "3": {"class_type": "PreviewImage", "inputs": {"images": ["2", 0]}},
        "4": {"class_type": "PreviewAny", "inputs": {"source": ["2", 2]}},  # fps
        "5": {"class_type": "PreviewAudio", "inputs": {"audio": ["2", 1]}},  # the clip's own sound
        "6": {"class_type": "PreviewAudio", "inputs": {"audio": ["1", 1]}},  # the audio field
    }


def remove(api, library_dir):
    removed = []
    for bundle in api.call("GET", "/bundles")[1]["bundles"]:
        if bundle["name"] == NAME:
            api.call("DELETE", f"/bundles/{bundle['id']}?expected_revision={bundle['revision']}")
            removed.append(bundle["id"])
    trash = Path(library_dir) / "trash" if library_dir else None
    if removed and trash and trash.is_dir():
        for file in trash.iterdir():
            if file.name.split(".")[0] in removed:
                file.unlink()
    return removed


def checks(api):
    video = api.upload((FIXTURES / "clip.mp4").read_bytes(), "clip.mp4", kind="video")
    sound = api.upload((FIXTURES / "tone.mp3").read_bytes(), "tone.mp3", kind="audio")
    status, bundle, _ = api.call("POST", "/bundles", {"name": NAME, "tags": ["test"], "fields": [
        {"name": "clip", "type": "video", "asset": {"sha256": video, "original_name": "clip.mp4"}},
        {"name": "bgm", "type": "audio", "asset": {"sha256": sound, "original_name": "tone.mp3"}},
        {"name": "empty_clip", "type": "video", "asset": None},
    ]})
    expect(status == 201, f"created {NAME}")
    clip, bgm = bundle["fields"][0]["asset"], bundle["fields"][1]["asset"]
    expect((clip["ext"], clip["width"], clip["height"], clip["fps"], clip["has_audio"]) == ("mp4", 160, 120, 24.0, True)
           and abs(clip["duration"] - 2.0) < 0.05, f"video metadata from the file: {clip}")
    expect((bgm["ext"], bgm["sample_rate"], bgm["channels"]) == ("mp3", 44100, 2) and abs(bgm["duration"] - 1.5) < 0.1,
           f"audio metadata from the file: {bgm}")

    status, entry = run(api, graph(bundle["id"]))
    outputs = entry["outputs"] if status == 200 else {}
    expect(status == 200 and entry["status"]["status_str"] == "success",
           f"run succeeds: {error_text(entry)[:120] if status == 200 else entry}")
    expect(len(outputs.get("3", {}).get("images", [])) == 48, "VIDEO → GetVideoComponents: all 48 frames")
    expect(outputs.get("4", {}).get("text") == ["24.0"], f"VIDEO → GetVideoComponents: fps {outputs.get('4')}")
    expect(len(outputs.get("5", {}).get("audio", [])) == 1, "VIDEO → GetVideoComponents: the clip's sound")
    expect(len(outputs.get("6", {}).get("audio", [])) == 1, "AUDIO field → Preview Audio")

    status, entry = run(api, graph(bundle["id"], video_slot=2))
    failure = error_text(entry) if status == 200 else str(entry)
    expect(status == 200 and entry["status"]["status_str"] == "error" and "'empty_clip' has no video" in failure,
           f"a connected empty video field fails the loader: {failure[:100]}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8188")
    parser.add_argument("--library-dir", default=LIBRARY_DIR, help="for deleting the trash files ('' to keep them)")
    args = parser.parse_args()
    api = Api(args.base)
    remove(api, args.library_dir)  # left over from an interrupted run
    try:
        checks(api)
    finally:
        print("     ", f"removed {len(remove(api, args.library_dir))} test bundle(s)")
        forget_runs(api)


if __name__ == "__main__":
    main()
