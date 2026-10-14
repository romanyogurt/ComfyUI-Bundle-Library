"""Values shared by the node, the routes and (mirrored in web/reconcile.js) the browser."""

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
