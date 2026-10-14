"""Checks that Load Bundle gives video and audio exactly like core LoadVideo
and LoadAudio.

Imports ComfyUI in CPU mode, so it can run beside the server without touching
the GPU:
    docker compose exec -T -e CUDA_VISIBLE_DEVICES= \\
        -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library comfyui python tests/e2e/compare_media.py
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

import folder_paths  # noqa: E402
from comfy_extras.nodes_audio import LoadAudio  # noqa: E402
from comfy_extras.nodes_video import LoadVideo  # noqa: E402
from bundle_library.convert import load_audio, load_video  # noqa: E402
from tests import helpers  # noqa: E402

AUDIO = {
    "tone.wav": helpers.audio(),
    "tone.flac": helpers.audio("flac", "flac"),
    "tone.mp3": helpers.audio("mp3", "libmp3lame", rate=44100),
    "tone.ogg": helpers.audio("ogg", "libopus", rate=48000),
    "tone.m4a": helpers.audio("ipod", "aac", rate=48000),
    "song.mp3": helpers.mp3_with_cover(),
}
VIDEO = {
    "clip.mp4": helpers.video("mp4", "libx264", audio_codec="aac"),
    "clip.webm": helpers.video("webm", "libvpx-vp9", audio_codec="libopus"),
    "clip.mov": helpers.video("mov", "libx264"),
}


def same_audio(a, b):
    return a["sample_rate"] == b["sample_rate"] and torch.equal(a["waveform"], b["waveform"])


def main():
    folder = tempfile.mkdtemp()
    paths = {}
    for name, data in {**AUDIO, **VIDEO}.items():
        paths[name] = os.path.join(folder, name)
        with open(paths[name], "wb") as f:
            f.write(data)
    folder_paths.get_annotated_filepath = lambda name: paths[name]
    failed = 0
    for name in AUDIO:
        core = LoadAudio.execute(name).result[0]
        ours = load_audio(paths[name])
        same = same_audio(core, ours) and ours["waveform"].dtype == torch.float32
        failed += not same
        print("ok  " if same else "FAIL", f"{name:10s} audio {tuple(ours['waveform'].shape)} at {ours['sample_rate']} Hz")
    for name in VIDEO:
        core = LoadVideo.execute(name).result[0].get_components()
        ours = load_video(paths[name]).get_components()
        same = (torch.equal(core.images, ours.images) and core.frame_rate == ours.frame_rate
                and (core.audio is None) == (ours.audio is None)
                and (core.audio is None or same_audio(core.audio, ours.audio)))
        failed += not same
        print("ok  " if same else "FAIL", f"{name:10s} video {tuple(ours.images.shape)} at {float(ours.frame_rate)} fps,"
              f" audio {None if ours.audio is None else tuple(ours.audio['waveform'].shape)}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
