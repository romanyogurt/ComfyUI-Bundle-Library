"""Writes the small video and audio files the browser scenarios upload.
Run inside the container (it needs PyAV); the files are kept in the repository:
    docker compose exec -T -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library comfyui \\
        python tests/browser/make_fixtures.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # the node folder, for tests.helpers
from tests import helpers  # noqa: E402

FIXTURES = {
    "clip.mp4": lambda: helpers.video("mp4", "libx264", size=(160, 120), frames=48, fps=24, audio_codec="aac"),
    "clip.webm": lambda: helpers.video("webm", "libvpx-vp9", size=(160, 120), frames=48, fps=24, audio_codec="libopus"),
    "tone.mp3": lambda: helpers.audio("mp3", "libmp3lame", seconds=1.5, rate=44100),
    "tone.wav": lambda: helpers.audio(seconds=1.0),
}

if __name__ == "__main__":
    folder = Path(__file__).resolve().parent / "fixtures"
    folder.mkdir(exist_ok=True)
    for name, make in FIXTURES.items():
        data = make()
        (folder / name).write_bytes(data)
        print(f"{name:10s} {len(data):7,d} bytes")
