"""Times the bundle store with many bundles. Works in a temporary folder, so the
real library is not touched. Run inside the container (it needs Pillow):
    docker compose exec -T -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library \\
        comfyui python tests/e2e/bench_store.py --count 100 --count 1000
"""

import argparse
import hashlib
import io
import json
import shutil
import statistics
import sys
import tempfile
import time
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # the node folder, for bundle_library
from bundle_library.store import BundleStore  # noqa: E402

WORDS = ("anime girl blonde braids calm expression blue cloak courtyard soft light detailed background "
         "cinematic framing standing looking viewer smile wind hair dress red night city rain").split()


def picture(index):
    """A 832×1216 PNG with a different gradient for each index (about 10 KB)."""
    image = Image.linear_gradient("L").resize((832, 1216)).convert("RGB")
    image = Image.merge("RGB", [band.point(lambda v, k=k: (v + 37 * index * (k + 1)) % 256)
                                for k, band in enumerate(image.split())])
    out = io.BytesIO()
    image.save(out, "PNG")
    return out.getvalue()


def add_image(store, data):
    temp = store.assets.temp_path()
    temp.write_bytes(data)
    info, _ = store.assets.finalize(temp, hashlib.sha256(data).hexdigest(), "bench.png")
    return info["sha256"]


def prompt(index):
    words = [WORDS[(index * 7 + i * 3) % len(WORDS)] for i in range(100)]
    return f"<Subject 1> number {index}: " + " ".join(words)  # about 600 characters


def timed(function, repeat=5):
    """(median seconds, last result)."""
    times, result = [], None
    for _ in range(repeat):
        start = time.perf_counter()
        result = function()
        times.append(time.perf_counter() - start)
    return statistics.median(times), result


def bench(count, images):
    root = Path(tempfile.mkdtemp(prefix="bundle-bench-"))
    try:
        store = BundleStore(root)
        shas = [add_image(store, data) for data in images]
        ids, create_times = [], []
        for i in range(count):
            data = {"name": f"Bench {i:04d}", "tags": [("character", "scene", "style")[i % 3]], "fields": [
                {"name": "prompt", "type": "text", "value": prompt(i)},
                {"name": "reference", "type": "image", "asset": {"sha256": shas[i % len(shas)]}},
                {"name": "frame", "type": "image", "asset": {"sha256": shas[(i + 1) % len(shas)]}},
                {"name": "use frame", "type": "boolean", "value": i % 2 == 0},
                {"name": "steps", "type": "int", "value": 20 + i % 10},
            ]}
            start = time.perf_counter()
            ids.append(store.create(data)["id"])
            create_times.append(time.perf_counter() - start)
        cold, listing = timed(lambda: BundleStore(root).list(), repeat=3)  # a fresh store reads every file
        warm, _ = timed(lambda: store.list())
        search, found = timed(lambda: store.list(query="number 7"))
        by_tag, _ = timed(lambda: store.list(tag="scene"))
        get, _ = timed(lambda: store.get(ids[count // 2]))
        body = json.dumps(listing)
        serialize, _ = timed(lambda: json.dumps(listing))
        target = store.get(ids[count // 2])

        def save():
            nonlocal target
            target = store.update(target["id"], {**target, "note": f"edit {time.perf_counter()}"}, target["revision"])

        update, _ = timed(save)
        return {
            "bundles": count,
            "create (avg / last 10%)": f"{statistics.mean(create_times) * 1e3:.1f} / "
                                       f"{statistics.mean(create_times[-max(count // 10, 1):]) * 1e3:.1f} ms",
            "list, first read": f"{cold * 1e3:.1f} ms",
            "list, cached": f"{warm * 1e3:.1f} ms",
            "search 'number 7'": f"{search * 1e3:.1f} ms ({len(found['bundles'])} found)",
            "list by tag": f"{by_tag * 1e3:.1f} ms",
            "get one": f"{get * 1e3:.2f} ms",
            "update one": f"{update * 1e3:.1f} ms",
            "list JSON": f"{len(body) / 1024:.0f} KB, {serialize * 1e3:.1f} ms to encode",
        }
    finally:
        shutil.rmtree(root)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, action="append", help="number of bundles (repeatable)")
    counts = parser.parse_args().count or [100]
    images = [picture(i) for i in range(10)]
    results = [bench(count, images) for count in counts]
    keys = list(results[0])
    print("| " + " | ".join(keys) + " |")
    print("|" + " --- |" * len(keys))
    for row in results:
        print("| " + " | ".join(str(row[k]) for k in keys) + " |")


if __name__ == "__main__":
    main()
