FROM python:3.14.6-slim-trixie

ARG PROXY=http://genproxy.corp.amdocs.com:8080
ARG HTTP_PROXY=${PROXY}
ARG HTTPS_PROXY=${PROXY}
ARG http_proxy=${PROXY}
ARG https_proxy=${PROXY}

WORKDIR /app

# Python deps (FastAPI + uvicorn/websockets). pip goes through the corp proxy at
# build time via the ARGs above.
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# App files + the authoritative sim server (FastAPI + WebSocket broadcast).
# NOTE: index.html loads PixiJS from a CDN; for a fully offline cluster, vendor
# pixi locally and COPY it here too, otherwise the node needs internet at runtime.
COPY server.py seed.py index.html style.css main.js /app/

# Roster persistence lives in $DATA_DIR; back it with a PersistentVolume in k8s.
ENV DATA_DIR=/data \
    BIND=0.0.0.0 \
    PORT=80
RUN mkdir -p /data

EXPOSE 80

# Static files + live WebSocket world stream + roster API (uvicorn via main()).
CMD ["python", "server.py"]
