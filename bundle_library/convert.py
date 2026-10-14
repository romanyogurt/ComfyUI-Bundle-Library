"""Library files -> the values the loader outputs."""

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
