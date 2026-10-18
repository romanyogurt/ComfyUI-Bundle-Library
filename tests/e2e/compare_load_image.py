"""Checks that Load Bundle decodes images exactly like core LoadImage.

Imports ComfyUI in CPU mode, so it can run beside the server, in the test
server's container (tests/test-server.sh start):
    docker exec -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library bundle-library-test \\
        python tests/e2e/compare_load_image.py
"""

import os
import sys
import tempfile

PACKAGE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.argv = [sys.argv[0], "--cpu"]
sys.path[:0] = [PACKAGE, "/opt/ComfyUI"]  # this package first: ComfyUI has a "tests" package too

import comfy.options  # noqa: E402

comfy.options.enable_args_parsing()

import torch  # noqa: E402
from PIL import Image  # noqa: E402

import folder_paths  # noqa: E402
import nodes  # noqa: E402
from bundle_library.convert import load_image  # noqa: E402
from tests import helpers  # noqa: E402

CASES = {
    "plain.png": helpers.png(),
    "rgba.png": helpers.png(color=(10, 200, 10, 128), mode="RGBA"),
    "gray16.png": helpers.png16(),
    "turned.jpg": helpers.jpeg_turned(),
    "noise.jpg": helpers.encode(Image.effect_noise((320, 240), 80).convert("RGB"), "JPEG", quality=85),
    "lossless.webp": helpers.webp(),
}
ANIMATED = {"animated.png": helpers.apng()}  # core gives every frame, Load Bundle the first


def main():
    folder = tempfile.mkdtemp()
    paths = {}
    for name, data in {**CASES, **ANIMATED}.items():
        paths[name] = os.path.join(folder, name)
        with open(paths[name], "wb") as f:
            f.write(data)
    folder_paths.get_annotated_filepath = lambda name: paths[name]
    failed = 0
    for name in CASES:
        path = paths[name]
        core = nodes.LoadImage().load_image(name)[0]
        ours = load_image(path)
        same = core.dtype == ours.dtype and core.device == ours.device and torch.equal(core, ours)
        failed += not same
        print("ok  " if same else "FAIL", f"{name:14s} {tuple(ours.shape)} {ours.dtype} {ours.device}")
    for name in ANIMATED:
        core = nodes.LoadImage().load_image(name)[0]
        ours = load_image(paths[name])
        held = ours.untyped_storage().nbytes()  # not the storage of every frame
        same = core.shape[0] > 1 and torch.equal(core[:1], ours) and held == ours.numel() * ours.element_size()
        failed += not same
        print("ok  " if same else "FAIL", f"{name:14s} first of {core.shape[0]} frames {tuple(ours.shape)}, holds {held} bytes")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
