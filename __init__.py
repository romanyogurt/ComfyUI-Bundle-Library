from comfy_api.latest import ComfyExtension, io

from .bundle_library import routes  # noqa: F401  registers the HTTP routes
from .bundle_library.nodes import LoadBundle

WEB_DIRECTORY = "./web"


class BundleLibraryExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [LoadBundle]


async def comfy_entrypoint() -> BundleLibraryExtension:
    return BundleLibraryExtension()
