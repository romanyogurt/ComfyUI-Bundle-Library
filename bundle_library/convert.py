"""Library files -> the values the loader outputs."""

import av
import numpy as np
import torch
from PIL import Image, ImageOps

import comfy.model_management
import node_helpers
from comfy_api.latest import InputImpl


def load_image(path):
    """An IMAGE tensor [1, H, W, 3] of the file's first frame, decoded the way
    core LoadImage decodes it so the same file gives the same tensor: PyAV
    first, Pillow for what PyAV cannot read (animated WebP)."""
    dtype = comfy.model_management.intermediate_dtype()
    device = comfy.model_management.intermediate_device()
    images = InputImpl.VideoFromFile(str(path)).get_components().images
    if images.shape[0] > 0:
        return images[:1].to(device=device, dtype=dtype)
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


def load_audio(path):
    """An AUDIO decoded the way core LoadAudio decodes it, so the same file
    gives the same waveform: {"waveform": [1, channels, samples] float32,
    "sample_rate": rate}. Written out here rather than imported from
    comfy_extras, whose functions are not a stable interface."""
    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        rate = stream.codec_context.sample_rate
        channels = stream.channels
        frames = []
        for frame in container.decode(streams=stream.index):
            buf = torch.from_numpy(frame.to_ndarray())
            if buf.shape[0] != channels:  # interleaved samples
                buf = buf.view(-1, channels).t()
            frames.append(buf)
    if not frames:
        raise ValueError(f"No audio frames decoded from {path.name}.")
    waveform = torch.cat(frames, dim=1)
    if not waveform.dtype.is_floating_point:
        scale = {torch.int16: 2 ** 15, torch.int32: 2 ** 31}.get(waveform.dtype)
        if scale is None:
            raise ValueError(f"Unsupported audio sample format: {waveform.dtype}")
        waveform = waveform.float() / scale
    return {"waveform": waveform.unsqueeze(0), "sample_rate": rate}
