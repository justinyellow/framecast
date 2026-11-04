# --- whisper.cpp: local, offline speech-to-text for transcripts/captions ---
FROM debian:bookworm-slim AS whisper
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ARG WHISPER_VERSION=v1.7.6
RUN git clone --depth 1 --branch ${WHISPER_VERSION} https://github.com/ggml-org/whisper.cpp /src
WORKDIR /src
# GGML_NATIVE=OFF keeps the binary portable across Fargate CPU generations.
RUN cmake -B build -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
  && cmake --build build -j"$(nproc)" --config Release --target whisper-cli
ARG WHISPER_MODEL=base.en
RUN mkdir -p /models && curl -fsSL -o /models/ggml-${WHISPER_MODEL}.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin

# --- app ---
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates libgomp1 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /models /opt/whisper/models
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
