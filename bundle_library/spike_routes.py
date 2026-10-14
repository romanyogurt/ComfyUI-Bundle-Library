"""Phase 0 test bundles for the loader node, served until Phase 2 moves the node
to the real store. This module and spike_store.py go away then."""

from aiohttp import web

from . import spike_store
from .constants import API_PREFIX


def register(routes):
    @routes.get(API_PREFIX + "/spike/bundles")
    async def list_spike_bundles(request):
        return web.json_response({"bundles": spike_store.summaries()})

    @routes.get(API_PREFIX + "/spike/thumb/{bundle_id}/{field}")
    async def spike_thumbnail(request):
        data = spike_store.thumbnail_png(request.match_info["bundle_id"], request.match_info["field"])
        if data is None:
            raise web.HTTPNotFound()
        return web.Response(body=data, content_type="image/png")
