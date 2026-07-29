FROM rust:1.92-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      clang \
      cmake \
      git \
      libssl-dev \
      pkg-config \
      protobuf-compiler \
    && rm -rf /var/lib/apt/lists/* \
    && rustup component add rustfmt clippy \
    && mkdir -p /home/profsync/.cargo \
    && chmod -R 0777 /home/profsync

WORKDIR /workspace
