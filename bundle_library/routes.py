from urllib.parse import urlsplit

from aiohttp import web
from server import PromptServer

from . import spike_store
from .constants import API_PREFIX

routes = PromptServer.instance.routes


def write_guard_error(request):
    """Why a state-changing request must be refused, or None.

    The custom header forces a CORS preflight for any other origin, which
    ComfyUI does not answer with allow headers. Core's own Host/Origin check
    only runs for loopback hosts, so the Origin comparison is repeated here
    for access through the Tailscale domain.
    """
    if request.headers.get("X-Bundle-Library") != "1":
        return "missing_header"
    site = request.headers.get("Sec-Fetch-Site")
    if site is not None and site not in ("same-origin", "none"):
        return "cross_site"
    origin = request.headers.get("Origin")
    if origin and urlsplit(origin).netloc.lower() != request.host.lower():
        return "origin_mismatch"
    return None


@routes.get(API_PREFIX + "/bundles")
async def list_bundles(request):
    return web.json_response({"bundles": spike_store.summaries()})


@routes.get(API_PREFIX + "/spike/thumb/{bundle_id}/{field}")
async def spike_thumbnail(request):
    data = spike_store.thumbnail_png(request.match_info["bundle_id"], request.match_info["field"])
    if data is None:
        raise web.HTTPNotFound()
    return web.Response(body=data, content_type="image/png")


@routes.post(API_PREFIX + "/spike/echo")
async def spike_echo(request):
    problem = write_guard_error(request)
    if problem:
        return web.json_response({"error": {"code": problem, "message": "요청이 거부되었습니다."}}, status=403)
    return web.json_response({
        "ok": True,
        "host": request.host,
        "origin": request.headers.get("Origin"),
        "sec_fetch_site": request.headers.get("Sec-Fetch-Site"),
    })
