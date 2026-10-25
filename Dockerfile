# syntax=docker/dockerfile:1

# glibc (not alpine): onnxruntime-node ships glibc binaries only.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: `prepare` builds, and the sources are not copied in yet.
# onnxruntime-node bundles its binaries, so its postinstall (a CUDA download) is not needed.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev \
 # Only the Node CPU runtime for this platform is used: drop the WebAssembly
 # runtime and the other operating systems' binaries (about 360 MB).
 && rm -rf node_modules/onnxruntime-web \
 && find node_modules/onnxruntime-node/bin -mindepth 2 -maxdepth 2 -type d ! -name linux -exec rm -rf {} + \
 && find node_modules/onnxruntime-node/bin -path '*/linux/*' -mindepth 3 -maxdepth 3 -type d \
      ! -name "$(node -p 'process.arch')" -exec rm -rf {} + \
 && find node_modules -name '*.map' -delete

# The embedding model, pinned to a revision and checksummed, so the image never
# downloads anything at run time (transformers.js's first-download path is also
# unreliable in Node: it can fail before its cache write lands).
FROM scratch AS model
ARG HF=https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/ea104dacec62c0de699686887e3f920caeb4f3e3
ADD --chmod=644 --checksum=sha256:fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350 $HF/config.json /Xenova/bge-small-en-v1.5/config.json
ADD --chmod=644 --checksum=sha256:d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66 $HF/tokenizer.json /Xenova/bge-small-en-v1.5/tokenizer.json
ADD --chmod=644 --checksum=sha256:9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3 $HF/tokenizer_config.json /Xenova/bge-small-en-v1.5/tokenizer_config.json
ADD --chmod=644 --checksum=sha256:b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3 $HF/special_tokens_map.json /Xenova/bge-small-en-v1.5/special_tokens_map.json
ADD --chmod=644 --checksum=sha256:828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35 $HF/onnx/model.onnx /Xenova/bge-small-en-v1.5/onnx/model.onnx

FROM node:24-slim
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    PORT=8000 \
    PAPERLESS_MCP_DATA_DIR=/data \
    PAPERLESS_MCP_MODEL_DIR=/app/models \
    NODE_NO_WARNINGS=1
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=model / ./models
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/index.js"]
