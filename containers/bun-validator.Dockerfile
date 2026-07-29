FROM oven/bun:1.3.14

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /home/profsync/.bun/install/cache \
    && chmod -R 0777 /home/profsync

WORKDIR /workspace
