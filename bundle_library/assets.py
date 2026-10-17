"""Uploaded media, kept once under its SHA-256 and never changed afterwards.

Images are checked with Pillow, video and audio with PyAV (the library core's
LoadVideo and LoadAudio use). A file's kind follows from its stored extension.
"""

import os
import threading
import uuid
from pathlib import Path

import av
from PIL import Image, ImageOps, UnidentifiedImageError

from .constants import (
    AUDIO_EXTENSIONS, AUDIO_SAMPLE_FORMATS, IMAGE_FORMATS, MAX_AUDIO_BYTES, MAX_AUDIO_CHANNELS, MAX_AUDIO_RATE,
    MAX_AUDIO_SAMPLES, MAX_AUDIO_SECONDS, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS,
    MAX_VIDEO_BYTES, MAX_VIDEO_PIXELS, THUMBNAIL_SIZES, VIDEO_EXTENSIONS,
)
from .model import SHA256_RE, LibraryError, check_sha256, clean_original_name
from .text import Text

MIME_TYPES = {**dict(IMAGE_FORMATS.values()), **VIDEO_EXTENSIONS, **AUDIO_EXTENSIONS}  # extension -> MIME type
KINDS = {**{ext: "image" for ext, _ in IMAGE_FORMATS.values()},
         **{ext: "video" for ext in VIDEO_EXTENSIONS}, **{ext: "audio" for ext in AUDIO_EXTENSIONS}}
_FORMATS = list(IMAGE_FORMATS)  # the only decoders Pillow may use here
_SWAPS_SIDES = {5, 6, 7, 8}  # EXIF orientations that turn the image by 90°

# PyAV demuxer names; one demuxer reads several file types.
_MOV = "mov,mp4,m4a,3gp,3g2,mj2"
_MATROSKA = "matroska,webm"
_WEBM_VIDEO = {"vp8", "vp9", "av1"}
_WEBM_AUDIO = {"opus", "vorbis"}
_AUDIO_DEMUXERS = {"wav": "wav", "flac": "flac", "mp3": "mp3", "ogg": "ogg"}
_OGG_AUDIO = {"opus", "vorbis"}
_CODEC_NAMES = {"mp3float": "mp3"}  # decoder name -> the codec's usual name
_REFUSED = {
    "image": Text("file.only_image"),
    "video": Text("file.only_video"),
    "audio": Text("file.only_audio"),
}


def _open(path):
    return Image.open(path, formats=_FORMATS)

# A file kind's name, as a word a page translates (text.py).
_KIND_NAMES = {"image": Text("kind.image"), "video": Text("kind.video"), "audio": Text("kind.audio")}


class AssetStore:
    def __init__(self, root, tmp_dir, max_bytes=MAX_IMAGE_BYTES, max_pixels=MAX_IMAGE_PIXELS):
        self.files = Path(root) / "assets" / "sha256"
        self.thumbs = Path(root) / "thumbs"
        self.tmp_dir = Path(tmp_dir)
        # Per kind: the largest upload, and a limit on the content itself.
        self.limits = {
            "image": {"bytes": max_bytes, "pixels": max_pixels},
            "video": {"bytes": MAX_VIDEO_BYTES, "pixels": MAX_VIDEO_PIXELS},
            "audio": {"bytes": MAX_AUDIO_BYTES, "seconds": MAX_AUDIO_SECONDS, "samples": MAX_AUDIO_SAMPLES,
                      "channels": MAX_AUDIO_CHANNELS, "rate": MAX_AUDIO_RATE},
        }
        self._meta = {}  # sha256 -> metadata read from the file; files never change
        self._lock = threading.Lock()  # storing and removing a file, so neither misses the other

    def temp_path(self):
        return self.tmp_dir / f"{uuid.uuid4().hex}.part"

    def finalize(self, temp, sha256, original_name=None, kind="image"):
        """Check an uploaded file of `kind` (image, video or audio) and keep it
        under its hash.

        `temp` holds the received bytes and `sha256` their digest, computed
        while streaming. Returns (info, created); created is False when the
        same content was stored before, in which case `temp` is left for the
        caller to delete.
        """
        if kind == "image":
            width, height, image_format = self._check_image(temp)
            ext, meta = IMAGE_FORMATS[image_format][0], {"width": width, "height": height}
        else:
            ext, meta = self._check_media(temp, kind)
        target = self.files / sha256[:2] / f"{sha256}.{ext}"
        with self._lock:
            created = not target.exists()
            if created:
                target.parent.mkdir(parents=True, exist_ok=True)
                os.chmod(temp, 0o644)
                os.replace(temp, target)
            else:
                _touch(target)  # uploaded again: a cleanup waits the grace time anew
        self._meta[sha256] = meta
        info = self._info(sha256, target)
        if original_name:
            info["original_name"] = clean_original_name(original_name)
        return info, created

    def _check_image(self, path):
        """(width, height, format) of a file that must be a whole PNG, JPEG or
        WebP image within the pixel limit. Width and height are as displayed,
        after the EXIF orientation."""
        limit = self.limits["image"]["pixels"]
        try:
            with _open(path) as image:
                width, height = image.size
                if width * height > limit:
                    raise LibraryError(
                        413, "too_many_pixels",
                        Text("file.image_too_large_size", width=width, height=height, limit=format(limit, ',')))
                turned = image.getexif().get(0x0112) in _SWAPS_SIDES
                image.load()  # decode it all: a broken file is refused now, not at run time
                image_format = image.format
        except LibraryError:
            raise
        except Image.DecompressionBombError:
            raise LibraryError(413, "too_many_pixels", Text("file.image_too_large")) from None
        except UnidentifiedImageError:
            raise LibraryError(415, "unsupported_format", _REFUSED["image"]) from None
        except (OSError, SyntaxError, ValueError):
            raise LibraryError(400, "corrupt_image", Text("file.image_incomplete")) from None
        return (height, width, image_format) if turned else (width, height, image_format)

    def _check_media(self, path, kind):
        """(extension, metadata) of a file that must be a video or audio file of
        an accepted kind within the limits. A video's first frame must decode;
        audio is decoded to the end, since it is loaded whole when it runs."""
        limits = self.limits[kind]
        try:
            container = av.open(str(path))
        except (av.error.FFmpegError, OSError, ValueError):
            raise LibraryError(415, "unsupported_format", _REFUSED[kind]) from None
        with container:
            ext, meta = _describe(container, kind)
            if kind == "video" and meta["width"] * meta["height"] > limits["pixels"]:
                raise LibraryError(
                    413, "too_many_pixels",
                    Text("file.video_too_large", width=meta['width'], height=meta['height'], pixels=format(limits['pixels'], ',')))
            if kind == "audio":
                _check_audio_shape(meta, limits)
            try:
                if kind == "video":
                    next(container.decode(_video_stream(container)))  # a broken file is refused now, not at run time
                else:
                    seconds = _decode_audio(container, limits, meta.get("duration"))
                    meta.setdefault("duration", seconds)  # the header's length is shown when it has one
            except LibraryError:
                raise
            except (StopIteration, av.error.FFmpegError, OSError, ValueError):
                raise LibraryError(400, "corrupt_media",
                                   Text("file.not_decoded", kind=_KIND_NAMES.get(kind, kind))) from None
        return ext, meta

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

    def stored(self):
        """(sha256, path) of every stored file. Anything else in the folder is
        not the library's and is left alone."""
        found = []
        if not self.files.is_dir():
            return found
        for folder in os.scandir(self.files):
            if len(folder.name) != 2 or not folder.is_dir(follow_symlinks=False):
                continue
            for entry in os.scandir(folder.path):
                sha256, dot, ext = entry.name.partition(".")
                if (dot and ext in MIME_TYPES and SHA256_RE.match(sha256) and sha256[:2] == folder.name
                        and entry.is_file(follow_symlinks=False)):
                    found.append((sha256, Path(entry.path)))
        return found

    def remove(self, sha256, stored_before):
        """Delete a stored file and its thumbnails, but only if it was stored
        (or uploaded again) before the time `stored_before`. Its size, or None
        when it is kept or not there."""
        with self._lock:
            path = self.path(sha256)
            if path is None:
                return None
            stat = path.stat()
            if stat.st_mtime >= stored_before:
                return None
            path.unlink()
            self._meta.pop(sha256, None)
        for thumb in (self.thumbs / sha256[:2]).glob(f"{sha256}_*.webp"):
            thumb.unlink(missing_ok=True)
        return stat.st_size

    def remove_stray_thumbnails(self):
        """Delete the thumbnails whose file is no longer stored; how many."""
        removed = 0
        if not self.thumbs.is_dir():
            return removed
        for folder in os.scandir(self.thumbs):
            if not folder.is_dir(follow_symlinks=False):
                continue
            for entry in os.scandir(folder.path):
                sha256 = entry.name.partition("_")[0]
                if (entry.name.endswith(".webp") and SHA256_RE.match(sha256) and entry.is_file(follow_symlinks=False)
                        and self.path(sha256) is None):
                    os.unlink(entry.path)
                    removed += 1
        return removed

    def keep(self, sha256):
        """A draft takes this stored file (picked from the library, 0.0.29): as
        after an upload of the same content, a cleanup waits the grace time
        anew. Its metadata (as info()), or None when it is not stored."""
        with self._lock:  # a cleanup removing it meanwhile either sees the new time or has removed it
            path = self.path(sha256)
            if path is None:
                return None
            _touch(path)
        return self._info(sha256, path)

    def kind(self, sha256):
        """"image", "video" or "audio" for a stored file, or None."""
        path = self.path(sha256)
        return None if path is None else KINDS[path.suffix[1:]]

    def info(self, sha256):
        """Metadata of a stored file (without original_name), or None."""
        path = self.path(sha256)
        return None if path is None else self._info(sha256, path)

    def _info(self, sha256, path):
        ext = path.suffix[1:]
        if sha256 not in self._meta:
            self._meta[sha256] = _read_meta(path, KINDS[ext])
        return {"sha256": sha256, "ext": ext, "mime": MIME_TYPES[ext], **self._meta[sha256],
                "bytes": path.stat().st_size}

    def thumbnail(self, sha256, size):
        """A WebP preview at most `size` pixels on a side, made on first
        request: the image itself, or a frame near the start of a video.
        None for audio and for unknown files."""
        if size not in THUMBNAIL_SIZES:
            raise LibraryError(400, "invalid", Text("file.thumb_size", list=', '.join(map(str, THUMBNAIL_SIZES))))
        source = self.path(sha256)
        if source is None or KINDS[source.suffix[1:]] == "audio":
            return None
        target = self.thumbs / sha256[:2] / f"{sha256}_{size}.webp"
        if target.is_file():
            return target
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = self.temp_path()
        try:
            if KINDS[source.suffix[1:]] == "video":
                preview = _poster(source)
            else:
                with _open(source) as image:
                    preview = _displayable(ImageOps.exif_transpose(image))
                    preview.load()
            preview.thumbnail((size, size))
            preview.save(temp, "WEBP", quality=80)
            os.chmod(temp, 0o644)
            os.replace(temp, target)
        finally:
            temp.unlink(missing_ok=True)
        return target


def _touch(path):
    try:
        os.utime(path)
    except OSError:  # a file this process may not change; it then keeps its first time
        pass


def _video_stream(container):
    """The first real video stream: a cover picture (an MP3's or M4A's album
    art) also shows as a video stream, flagged as an attached picture."""
    attached = av.stream.Disposition.attached_pic
    return next((s for s in container.streams.video if not s.disposition & attached), None)


def _describe(container, kind):
    """(extension, metadata) of an open container, or LibraryError if it is not
    an accepted file of `kind`."""
    video = _video_stream(container)
    audio = container.streams.audio[0] if container.streams.audio else None
    video_codec = _codec(video)
    audio_codec = _codec(audio)
    name = container.format.name
    if name == _MOV and video:
        ext = "mov" if (container.metadata.get("major_brand") or "").strip() == "qt" else "mp4"
    elif name == _MATROSKA and video_codec in _WEBM_VIDEO and audio_codec in _WEBM_AUDIO | {None}:
        ext = "webm"
    elif name == _MOV and audio:
        ext = "m4a"
    elif name in _AUDIO_DEMUXERS and audio and not video and (name != "ogg" or audio_codec in _OGG_AUDIO):
        ext = _AUDIO_DEMUXERS[name]
    else:
        ext = None
    found = KINDS.get(ext)
    if found != kind:
        message = {("video", "audio"): "This file has no video; use an audio field for it.",
                   ("audio", "video"): "This file is a video; use a video field for it."}.get(
            (kind, found), _REFUSED[kind])
        raise LibraryError(415, "unsupported_format", message)
    duration = _duration(container, video or audio)
    if kind == "video":
        context = video.codec_context
        meta = {"width": context.width, "height": context.height, "codec": video_codec,
                "has_audio": audio is not None}
        if video.average_rate:
            meta["fps"] = round(float(video.average_rate), 3)
        if audio:
            meta["audio_codec"] = audio_codec
    else:
        meta = {"sample_rate": audio.codec_context.sample_rate, "channels": audio.codec_context.channels,
                "codec": audio_codec}
    if duration is not None:
        meta["duration"] = duration
    return ext, meta


def _read_meta(path, kind):
    """Metadata of a file that was checked when it was stored."""
    if kind == "image":
        with _open(path) as image:
            width, height = image.size
            if image.getexif().get(0x0112) in _SWAPS_SIDES:
                width, height = height, width
        return {"width": width, "height": height}
    with av.open(str(path)) as container:
        meta = _describe(container, kind)[1]
        if kind == "audio" and "duration" not in meta:
            meta["duration"] = _decode_audio(container)
        return meta


def _codec(stream):
    if stream is None:
        return None
    name = stream.codec_context.name
    return _CODEC_NAMES.get(name, name)


def _duration(container, stream):
    """Seconds, from the container or else the stream, or None if neither says."""
    if container.duration:
        return round(container.duration / av.time_base, 3)
    if stream is not None and stream.duration and stream.time_base:
        return round(float(stream.duration * stream.time_base), 3)
    return None


def _check_audio_shape(meta, limits):
    channels, rate = meta["channels"], meta["sample_rate"]
    if channels > limits["channels"]:
        raise LibraryError(415, "unsupported_format",
                           Text("file.audio_channels", channels=channels, channels2=limits['channels']))
    if rate > limits["rate"]:
        raise LibraryError(415, "unsupported_format",
                           Text("file.audio_sample_rate", n=format(rate / 1000, 'g'), n2=format(limits['rate'] / 1000, 'g')))


def _decode_audio(container, limits=None, claimed=None):
    """Seconds of audio in the container's first audio stream, counted by
    decoding all of it. With `limits`, refuses a sample format the loader
    cannot output and stops at the first frame past a limit; `claimed` is the
    length the header gives, for the message."""
    stream = container.streams.audio[0]
    rate, channels = stream.codec_context.sample_rate, stream.channels
    samples = 0
    for frame in container.decode(stream):
        samples += frame.samples
        if limits is None:
            continue
        if frame.format.name not in AUDIO_SAMPLE_FORMATS:
            name = {"u8": "8-bit", "u8p": "8-bit", "s64": "64-bit integer", "s64p": "64-bit integer"}.get(
                frame.format.name, frame.format.name)
            raise LibraryError(415, "unsupported_format",
                               Text("file.audio_sample_format", name=name))
        problem = audio_overflow(samples, channels, rate, limits, claimed)
        if problem:
            raise LibraryError(413, *problem)
    if samples == 0:
        raise ValueError("no audio frames")
    return round(samples / rate, 3)


def audio_overflow(samples, channels, rate, limits, claimed=None):
    """(code, message) if `samples` per channel of audio pass the `limits`
    (seconds, and samples of all channels), else None. Used on upload and when
    the audio is loaded; `claimed` is a length in seconds to show if known."""
    if samples > limits["seconds"] * rate:
        limit = _span(limits["seconds"])
        if claimed and claimed > limits["seconds"]:
            return "too_long", Text("file.audio_too_long_length", length=_clock(claimed), limit=limit)
        return "too_long", Text("file.audio_too_long", limit=limit)
    if samples * channels > limits["samples"]:
        values = {"count": channels, "rate": format(rate / 1000, "g"),
                  "length": _clock(limits["samples"] / channels / rate)}
        return "too_many_samples", Text("file.audio_too_large", **values)
    return None


def _span(seconds):
    if seconds % 60 == 0:
        return Text("file.minutes", count=_number(seconds // 60))
    return Text("file.seconds", count=_number(seconds))


def _number(value):
    """`value` as a page counts it: 5 rather than 5.0."""
    return int(value) if float(value).is_integer() else value


def _clock(seconds):
    seconds = int(seconds)
    return f"{seconds // 60}:{seconds % 60:02d}"


def _poster(path):
    """A frame shortly after the start of a video (the first frames are often
    black): at a tenth of its length, but no later than one second."""
    with av.open(str(path)) as container:
        stream = _video_stream(container)
        duration = _duration(container, stream) or 0
        target = min(1.0, duration * 0.1)
        chosen = None
        for frame in container.decode(stream):
            chosen = frame
            if frame.time is not None and frame.time >= target:
                break
        if chosen is None:
            raise ValueError("the video has no frames")
        return chosen.to_image()


def _displayable(image):
    """`image` in a mode WebP can hold. 16-bit greyscale is scaled, not clipped."""
    if image.mode in ("I;16", "I;16B", "I;16L", "I"):
        return image.convert("I").point(lambda v: v * (1 / 256)).convert("RGB")
    if image.mode in ("RGB", "RGBA"):
        return image
    has_alpha = "A" in image.getbands() or "transparency" in image.info
    return image.convert("RGBA" if has_alpha else "RGB")
