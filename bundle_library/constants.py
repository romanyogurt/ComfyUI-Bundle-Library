"""Values shared by the node, the routes and (mirrored in web/reconcile.js) the browser."""

VERSION = "0.0.6"

API_PREFIX = "/bundle-library/v1"

# Outputs the loader declares. The browser keeps only the ones the selected
# bundle uses; growing the pool later keeps old workflows valid, shrinking it
# does not.
POOL_SIZE = 32

# Field type -> ComfyUI type of the output slot that carries it.
COMFY_TYPES = {
    "text": "STRING",
    "image": "IMAGE",
    "boolean": "BOOLEAN",
    "int": "INT",
    "float": "FLOAT",
}
FIELD_TYPES = tuple(COMFY_TYPES)

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

# Pillow format -> (stored extension, MIME type). Nothing else is accepted.
IMAGE_FORMATS = {
    "PNG": ("png", "image/png"),
    "JPEG": ("jpg", "image/jpeg"),
    "WEBP": ("webp", "image/webp"),
}
THUMBNAIL_SIZES = (128, 256, 512)
