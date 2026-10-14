"""Uploaded media, kept once under its SHA-256 and never changed afterwards."""

import os
import uuid
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from .constants import IMAGE_FORMATS, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, THUMBNAIL_SIZES
from .model import LibraryError, check_sha256, clean_original_name

MIME_TYPES = dict(IMAGE_FORMATS.values())  # extension -> MIME type
_FORMATS = list(IMAGE_FORMATS)  # the only decoders Pillow may use here
_SWAPS_SIDES = {5, 6, 7, 8}  # EXIF orientations that turn the image by 90°


def _open(path):
    return Image.open(path, formats=_FORMATS)


class AssetStore:
    def __init__(self, root, tmp_dir, max_bytes=MAX_IMAGE_BYTES, max_pixels=MAX_IMAGE_PIXELS):
        self.files = Path(root) / "assets" / "sha256"
        self.thumbs = Path(root) / "thumbs"
        self.tmp_dir = Path(tmp_dir)
        self.max_bytes = max_bytes
        self.max_pixels = max_pixels
        self._sizes = {}  # sha256 -> (width, height); files never change

    def temp_path(self):
        return self.tmp_dir / f"{uuid.uuid4().hex}.part"

    def finalize(self, temp, sha256, original_name=None):
        """Check an uploaded file and keep it under its hash.

        `temp` holds the received bytes and `sha256` their digest, computed
        while streaming. Returns (info, created); created is False when the
        same content was stored before, in which case `temp` is left for the
        caller to delete.
        """
        width, height, image_format = self._check(temp)
        ext, mime = IMAGE_FORMATS[image_format]
        target = self.files / sha256[:2] / f"{sha256}.{ext}"
        created = not target.exists()
        if created:
            target.parent.mkdir(parents=True, exist_ok=True)
            os.chmod(temp, 0o644)
            os.replace(temp, target)
        self._sizes[sha256] = (width, height)
        info = {"sha256": sha256, "ext": ext, "mime": mime, "width": width, "height": height,
                "bytes": target.stat().st_size}
        if original_name:
            info["original_name"] = clean_original_name(original_name)
        return info, created

    def _check(self, path):
        """(width, height, format) of a file that must be a whole PNG, JPEG or
        WebP image of at most max_pixels. Width and height are as displayed,
        after the EXIF orientation."""
        try:
            with _open(path) as image:
                width, height = image.size
                if width * height > self.max_pixels:
                    raise LibraryError(
                        413, "too_many_pixels",
                        f"이미지가 너무 큽니다 ({width}×{height}). {self.max_pixels:,}픽셀까지 올릴 수 있습니다.")
                turned = image.getexif().get(0x0112) in _SWAPS_SIDES
                image.load()  # decode it all: a broken file is refused now, not at run time
                image_format = image.format
        except LibraryError:
            raise
        except Image.DecompressionBombError:
            raise LibraryError(413, "too_many_pixels", "이미지가 너무 큽니다.") from None
        except UnidentifiedImageError:
            raise LibraryError(415, "unsupported_format", "PNG, JPEG, WebP 이미지만 올릴 수 있습니다.") from None
        except (OSError, SyntaxError, ValueError):
            raise LibraryError(400, "corrupt_image", "이미지를 끝까지 읽을 수 없습니다. 손상된 파일일 수 있습니다.") from None
        return (height, width, image_format) if turned else (width, height, image_format)

    def path(self, sha256):
        """The stored file for `sha256`, or None. Links are never followed."""
        check_sha256(sha256)
        folder = self.files / sha256[:2]
        if folder.is_symlink():
            return None
        for ext in MIME_TYPES:
            candidate = folder / f"{sha256}.{ext}"
            if candidate.is_file() and not candidate.is_symlink():
                return candidate
        return None

    def info(self, sha256):
        """Metadata of a stored file (without original_name), or None."""
        path = self.path(sha256)
        if path is None:
            return None
        if sha256 not in self._sizes:
            with _open(path) as image:
                width, height = image.size
                if image.getexif().get(0x0112) in _SWAPS_SIDES:
                    width, height = height, width
            self._sizes[sha256] = (width, height)
        width, height = self._sizes[sha256]
        ext = path.suffix[1:]
        return {"sha256": sha256, "ext": ext, "mime": MIME_TYPES[ext], "width": width, "height": height,
                "bytes": path.stat().st_size}

    def thumbnail(self, sha256, size):
        """A WebP preview at most `size` pixels on a side, made on first request."""
        if size not in THUMBNAIL_SIZES:
            raise LibraryError(400, "invalid", f"썸네일 크기는 {', '.join(map(str, THUMBNAIL_SIZES))} 중 하나입니다.")
        source = self.path(sha256)
        if source is None:
            return None
        target = self.thumbs / sha256[:2] / f"{sha256}_{size}.webp"
        if target.is_file():
            return target
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = self.temp_path()
        try:
            with _open(source) as image:
                preview = _displayable(ImageOps.exif_transpose(image))
                preview.thumbnail((size, size))
                preview.save(temp, "WEBP", quality=80)
            os.chmod(temp, 0o644)
            os.replace(temp, target)
        finally:
            temp.unlink(missing_ok=True)
        return target


def _displayable(image):
    """`image` in a mode WebP can hold. 16-bit greyscale is scaled, not clipped."""
    if image.mode in ("I;16", "I;16B", "I;16L", "I"):
        return image.convert("I").point(lambda v: v * (1 / 256)).convert("RGB")
    if image.mode in ("RGB", "RGBA"):
        return image
    has_alpha = "A" in image.getbands() or "transparency" in image.info
    return image.convert("RGBA" if has_alpha else "RGB")
