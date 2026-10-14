"""Library files -> the values the loader outputs."""

import av
import numpy as np
import torch
from PIL import Image, ImageOps

import comfy.model_management
import node_helpers
from comfy_api.latest import InputImpl

from .assets import audio_overflow
from .constants import MAX_AUDIO_SAMPLES, MAX_AUDIO_SECONDS

AUDIO_LIMITS = {"seconds": MAX_AUDIO_SECONDS, "samples": MAX_AUDIO_SAMPLES}


def load_image(path):
    """An IMAGE tensor [1, H, W, 3] of the file's first frame, decoded the way
    core LoadImage decodes it so the same file gives the same tensor: PyAV
    first, Pillow for what PyAV cannot read (animated WebP)."""
    dtype = comfy.model_management.intermediate_dtype()
    device = comfy.model_management.intermediate_device()
    images = InputImpl.VideoFromFile(str(path)).get_components().images
    if images.shape[0] > 0:
        # A copy, so the output does not hold the storage of every frame.
        return images[:1].clone().to(device=device, dtype=dtype)
    image = node_helpers.pillow(Image.open, path)
    try:
        frame = node_helpers.pillow(ImageOps.exif_transpose, image).convert("RGB")
    finally:
        image.close()
    array = np.array(frame).astype(np.float32) / 255.0
    return torch.from_numpy(array)[None,].to(device=device, dtype=dtype)


def load_video(path):
    """A VIDEO as core LoadVideo gives it: the file, decoded where it is used."""
    return InputImpl.VideoFromFile(str(path))


def load_audio(path, limits=AUDIO_LIMITS):
    """An AUDIO decoded the way core LoadAudio decodes it, so the same file
    gives the same waveform: {"waveform": [1, channels, samples], "sample_rate":
    rate}. The waveform is float32, or float64 for a 64-bit float file, as in
    core. Written out here rather than imported from comfy_extras, whose
    functions are not a stable interface.

    Decoding stops with ValueError as soon as the audio passes `limits`
    (seconds, and samples of all channels), the limits uploads are held to."""
    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        rate = stream.codec_context.sample_rate
        channels = stream.channels
        frames = []
        samples = 0
        for frame in container.decode(streams=stream.index):
            buf = torch.from_numpy(frame.to_ndarray())
            if buf.shape[0] != channels:  # interleaved samples
                buf = buf.view(-1, channels).t()
            frames.append(buf)
            samples += buf.shape[1]
            problem = audio_overflow(samples, channels, rate, limits)
            if problem:
                raise ValueError(f"{problem[1]} It was not loaded.")
    if not frames:
        raise ValueError(f"No audio frames decoded from {path.name}.")
    waveform = torch.cat(frames, dim=1)
    frames.clear()  # the pieces are in the waveform now
    if not waveform.dtype.is_floating_point:
        scale = {torch.int16: 2 ** 15, torch.int32: 2 ** 31}.get(waveform.dtype)
        if scale is None:
            raise ValueError(f"Unsupported audio sample format: {waveform.dtype}")
        waveform = waveform.float() / scale
    return {"waveform": waveform.unsqueeze(0), "sample_rate": rate}
