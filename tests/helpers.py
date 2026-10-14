"""Small images made on the fly for the tests."""

import io

import numpy as np
from PIL import Image


def encode(image, fmt, **options):
    out = io.BytesIO()
    image.save(out, fmt, **options)
    return out.getvalue()


def png(color="red", size=(64, 48), mode="RGB"):
    return encode(Image.new(mode, size, color), "PNG")


def jpeg_turned(size=(300, 200)):
    """A JPEG stored `size` wide, with EXIF orientation 6 (shown turned by 90°)."""
    exif = Image.Exif()
    exif[0x0112] = 6
    return encode(Image.new("RGB", size, (200, 30, 30)), "JPEG", exif=exif.tobytes(), quality=90)


def webp(size=(40, 30)):
    return encode(Image.new("RGB", size, (1, 2, 250)), "WEBP", lossless=True)


def png16(size=(32, 32)):
    ramp = np.linspace(0, 65535, size[0] * size[1]).reshape(size[1], size[0]).astype(np.uint16)
    return encode(Image.fromarray(ramp), "PNG")  # uint16 -> mode I;16


def gif():
    return encode(Image.new("P", (8, 8)), "GIF")
