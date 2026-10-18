# The image of tests/test-server.sh: ComfyUI on Python 3.13 with CPU-only
# PyTorch, enough for the pack's end-to-end and browser tests (no models).
# COMFYUI_VERSION is a tag of https://github.com/Comfy-Org/ComfyUI.
FROM python:3.13-slim
ARG COMFYUI_VERSION=v0.38.0
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "$COMFYUI_VERSION" https://github.com/Comfy-Org/ComfyUI /opt/ComfyUI
RUN pip install --no-cache-dir --root-user-action=ignore --index-url https://download.pytorch.org/whl/cpu \
        torch torchvision torchaudio \
    && pip install --no-cache-dir --root-user-action=ignore -r /opt/ComfyUI/requirements.txt
WORKDIR /opt/ComfyUI
