"""The library in ComfyUI's user directory (user/bundle_library), opened on first use."""

import os
import threading

import folder_paths

from .store import BundleStore

_store = None
_lock = threading.Lock()


def get_store():
    global _store
    with _lock:
        if _store is None:
            _store = BundleStore(os.path.join(folder_paths.get_user_directory(), "bundle_library"))
        return _store
