"""Values shared by the node, the routes and (mirrored in web/reconcile.js) the browser."""

VERSION = "0.0.31"

API_PREFIX = "/bundle-library/v1"

# Outputs the loader declares. The browser keeps only the ones the selected
# bundle uses; growing the pool later keeps old workflows valid, shrinking it
# does not.
POOL_SIZE = 32

# Field type -> ComfyUI type of the output slot that carries it.
COMFY_TYPES = {
    "text": "STRING",
    "image": "IMAGE",
    "video": "VIDEO",
    "audio": "AUDIO",
    "boolean": "BOOLEAN",
    "int": "INT",
    "float": "FLOAT",
}
FIELD_TYPES = tuple(COMFY_TYPES)
# Field types whose value is an uploaded file (an asset) rather than a JSON value.
MEDIA_TYPES = ("image", "video", "audio")

# Limits from the plan (docs/data-format.md lists them for users).
MAX_FIELDS = POOL_SIZE
MAX_BUNDLE_NAME = 120
MAX_FIELD_NAME = 64
MAX_TAGS = 20
MAX_TAG_LENGTH = 40
MAX_NOTE = 10_000
MAX_ORIGINAL_NAME = 255
MAX_TEXT_BYTES = 1024 * 1024
MAX_JSON_BODY = 4 * 1024 * 1024
MAX_IMAGE_BYTES = 50 * 1024 * 1024
MAX_IMAGE_PIXELS = 64_000_000
MAX_VIDEO_BYTES = 1024 * 1024 * 1024
MAX_VIDEO_PIXELS = 7680 * 4320  # per frame
MAX_AUDIO_BYTES = 200 * 1024 * 1024
# Audio is decoded whole into memory when it runs, so its decoded size is
# limited too: samples of all channels together, as many as 10 minutes of
# 48 kHz stereo (about 230 MB as float32). Uploads are decoded to the end to
# count them; the length a file's header claims is not trusted.
MAX_AUDIO_SECONDS = 10 * 60
MAX_AUDIO_SAMPLES = 48_000 * 2 * 10 * 60
MAX_AUDIO_CHANNELS = 8
MAX_AUDIO_RATE = 192_000
# Decoded sample formats (PyAV names) that core's AUDIO conversion takes:
# 16- and 32-bit integers (24-bit files decode as 32-bit) and floats.
AUDIO_SAMPLE_FORMATS = {"s16", "s16p", "s32", "s32p", "flt", "fltp", "dbl", "dblp"}

# Pillow format -> (stored extension, MIME type). Nothing else is accepted.
IMAGE_FORMATS = {
    "PNG": ("png", "image/png"),
    "JPEG": ("jpg", "image/jpeg"),
    "WEBP": ("webp", "image/webp"),
}
# Stored extension -> MIME type for video and audio (assets.py decides which
# extension a file gets from its container and codecs). MOV is served as
# video/mp4: browsers do not take video/quicktime but play its H.264 content.
VIDEO_EXTENSIONS = {"mp4": "video/mp4", "mov": "video/mp4", "webm": "video/webm"}
AUDIO_EXTENSIONS = {"wav": "audio/wav", "flac": "audio/flac", "mp3": "audio/mpeg", "ogg": "audio/ogg",
                    "m4a": "audio/mp4"}
THUMBNAIL_SIZES = (128, 256, 512)
# A cleanup deletes a file nothing uses only once it was stored (or uploaded
# again) this long ago: the editor uploads a file before its bundle is saved.
ASSET_GRACE_SECONDS = 24 * 60 * 60
