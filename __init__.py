from comfy_api.latest import ComfyExtension, io
from server import PromptServer

from .bundle_library import routes, spike_routes
from .bundle_library.library import get_store
from .bundle_library.nodes import LoadBundle

WEB_DIRECTORY = "./web"

routes.register(PromptServer.instance.routes, get_store)
spike_routes.register(PromptServer.instance.routes)


class BundleLibraryExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [LoadBundle]


async def comfy_entrypoint() -> BundleLibraryExtension:
    return BundleLibraryExtension()
