"""Small images, videos and audio files made on the fly for the tests."""

import io
from fractions import Fraction

import av
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


def _samples(sample_format, channels, count, amplitude=0.2, step=0):
    """`count` samples of a tone in the layout and type an encoder wants."""
    t = (np.arange(count) + step) / 8000
    tone = (amplitude * np.sin(2 * np.pi * 440 * t)).astype(np.float64)
    planar = sample_format.endswith("p")
    kind = sample_format.rstrip("p")
    data = np.stack([tone] * channels) if planar else np.repeat(tone, channels)[None, :]
    if kind == "s16":
        return (data * 32767).astype(np.int16)
    if kind == "s32":
        return (data * 2147483647).astype(np.int32)
    return data.astype(np.float32 if kind == "flt" else np.float64)


def _audio_stream(container, codec, rate, channels=2):
    """Streams must all exist before the first packet is written."""
    stream = container.add_stream(codec, rate=rate)
    stream.layout = "stereo" if channels == 2 else "mono"
    return stream


def _encode_tone(container, stream, rate, seconds):
    channels = stream.codec_context.channels
    sample_format = stream.codec_context.format.name
    size = stream.codec_context.frame_size or 1024
    total = int(rate * seconds)
    for start in range(0, total, size):
        count = min(size, total - start)
        frame = av.AudioFrame.from_ndarray(_samples(sample_format, channels, count, step=start),
                                           format=sample_format, layout=stream.layout.name)
        frame.sample_rate, frame.pts, frame.time_base = rate, start, Fraction(1, rate)
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode():
        container.mux(packet)


def video(fmt="mp4", codec="libx264", size=(64, 48), frames=12, fps=12, audio_codec=None):
    """A short video; `fmt` is the PyAV muxer (mp4, mov, webm, matroska)."""
    out = io.BytesIO()
    with av.open(out, "w", format=fmt) as container:
        stream = container.add_stream(codec, rate=fps)
        stream.width, stream.height, stream.pix_fmt = size[0], size[1], "yuv420p"
        sound = _audio_stream(container, audio_codec, 48000) if audio_codec else None
        for i in range(frames):
            picture = np.full((size[1], size[0], 3), (i * 20) % 256, np.uint8)
            for packet in stream.encode(av.VideoFrame.from_ndarray(picture, format="rgb24")):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
        if sound:
            _encode_tone(container, sound, 48000, frames / fps)
    return out.getvalue()


def audio(fmt="wav", codec="pcm_s16le", seconds=1.0, rate=8000, channels=2):
    """A short tone; `fmt` is the PyAV muxer (wav, flac, mp3, ogg, ipod for M4A)."""
    out = io.BytesIO()
    with av.open(out, "w", format=fmt) as container:
        _encode_tone(container, _audio_stream(container, codec, rate, channels), rate, seconds)
    return out.getvalue()


def mp3_with_cover():
    """An MP3 carrying album art, which shows up as an attached-picture video stream."""
    out = io.BytesIO()
    with av.open(out, "w", format="mp3") as container:
        cover = container.add_stream("mjpeg", rate=1)
        cover.width, cover.height, cover.pix_fmt = 16, 16, "yuvj420p"
        cover.disposition = av.stream.Disposition.attached_pic
        _encode_tone(container, _audio_stream(container, "libmp3lame", 44100), 44100, 0.5)
        picture = av.VideoFrame.from_ndarray(np.zeros((16, 16, 3), np.uint8), format="rgb24").reformat(format="yuvj420p")
        for packet in [*cover.encode(picture), *cover.encode()]:
            container.mux(packet)
    return out.getvalue()
