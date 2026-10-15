"""Makes a small library with the code of a past release, for the compatibility fixtures.

Run with that release's package on the path (a git worktree of its commit)
and this repository's tests/helpers.py, in a container of the ComfyUI image:

    docker run --rm --entrypoint python \\
        -v <worktree>:/src:ro -v <this repo>/tests:/cur:ro -v <out>:/out <image> \\
        /cur/fixtures/compat/generate.py --recipe phase1 --out /out/0.0.2-phase1

The output is committed; it is not made again. README.md records each run.
"""

import argparse
import hashlib
import shutil
import sys
from pathlib import Path

sys.path[:0] = ["/src", "/cur"]  # the old package first; helpers.py only makes media

import helpers  # noqa: E402
from bundle_library.store import BundleStore  # noqa: E402


def upload(store, data, name, kind=None):
    temp = store.assets.temp_path()
    temp.write_bytes(data)
    sha = hashlib.sha256(data).hexdigest()
    try:
        if kind is None:  # 0.0.2 takes no kind
            store.assets.finalize(temp, sha, name)
        else:
            store.assets.finalize(temp, sha, name, kind)
    finally:
        temp.unlink(missing_ok=True)
    return sha


def phase1(store):
    """0.0.2 (Phase 1): text, image, an empty image field, boolean, int, float."""
    ref = upload(store, helpers.png("red"), "ref.png")
    store.create({"name": "Phase 1 sample", "tags": ["compat"], "note": "Made by node 0.0.2.", "fields": [
        {"name": "prompt", "type": "text", "value": "A red dress.\n\n  Two blank lines and spaces kept.  "},
        {"name": "ref", "type": "image", "asset": {"sha256": ref, "original_name": "ref.png"}},
        {"name": "ref_2", "type": "image", "asset": None},
        {"name": "use_bgm", "type": "boolean", "value": True},
        {"name": "steps", "type": "int", "value": 42},
        {"name": "cfg", "type": "float", "value": 4.5},
    ]})


def phase6(store):
    """0.0.8 (Phase 6): video with sound, audio, empty media fields, image, the largest safe int."""
    clip = upload(store, helpers.video("mp4", "libx264", audio_codec="aac"), "clip.mp4", "video")
    bgm = upload(store, helpers.audio(), "tone.wav", "audio")
    ref = upload(store, helpers.png("blue"), "ref.png", "image")
    store.create({"name": "Phase 6 sample", "tags": ["compat"], "note": "Made by node 0.0.8.", "fields": [
        {"name": "clip", "type": "video", "asset": {"sha256": clip, "original_name": "clip.mp4"}},
        {"name": "bgm", "type": "audio", "asset": {"sha256": bgm, "original_name": "tone.wav"}},
        {"name": "empty_clip", "type": "video", "asset": None},
        {"name": "empty_bgm", "type": "audio", "asset": None},
        {"name": "ref", "type": "image", "asset": {"sha256": ref, "original_name": "ref.png"}},
        {"name": "seed", "type": "int", "value": 9007199254740991},
    ]})


def release_0_0_10(store):
    """0.0.10 (Phase 7): one active bundle and one in the trash/ folder."""
    green = upload(store, helpers.png("green"), "green.png", "image")
    white = upload(store, helpers.png("white"), "white.png", "image")
    store.create({"name": "Active in 0.0.10", "tags": ["compat"], "fields": [
        {"name": "prompt", "type": "text", "value": "Still here."},
        {"name": "ref", "type": "image", "asset": {"sha256": green, "original_name": "green.png"}},
    ]})
    gone = store.create({"name": "Trashed in 0.0.10", "tags": ["compat"], "fields": [
        {"name": "prompt", "type": "text", "value": "In the trash."},
        {"name": "ref", "type": "image", "asset": {"sha256": white, "original_name": "white.png"}},
    ]})
    store.delete(gone["id"], 1)


RECIPES = {"phase1": phase1, "phase6": phase6, "0.0.10": release_0_0_10}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--recipe", choices=RECIPES, required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = Path(args.out)
    if out.exists():
        sys.exit(f"{out} exists")
    RECIPES[args.recipe](BundleStore(out))
    for cache in ("tmp", "thumbs"):  # nothing a fixture needs
        shutil.rmtree(out / cache, ignore_errors=True)
    print("made", sorted(str(p.relative_to(out)) for p in out.rglob("*") if p.is_file()))


if __name__ == "__main__":
    main()
