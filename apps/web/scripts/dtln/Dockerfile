# Reproducible build of the browser voice denoiser shipped at
# apps/web/public/voice/dtln/dtln.js, from pinned upstream sources.
#
#   bash apps/web/scripts/dtln/build.sh
#
# Upstream: https://github.com/DataDog/dtln-rs — DTLN noise suppression in
# Rust linked against the prebuilt TensorFlow Lite archives and the two
# quantized models that ship in that repository, compiled to WebAssembly with
# Emscripten. SINGLE_FILE embeds the .wasm in the generated glue as a data URI.
#
# Three files are overlaid on the checkout (see the comments in each):
#   build.rs     — upstream's only defines `main` for macOS/Windows hosts
#   config.toml  — upstream's quoted ENVIRONMENT link flag is rejected by emcc 4.x
#   dtln_post.js — Ficus's wrapper additions (`ready`, `postRun`); build.sh then
#                  appends the ES-module default export after the link
#
# Everything that determines the output is an ARG below, recorded into
# toolchain.txt next to the artifact and copied into provenance.json.
FROM emscripten/emsdk:4.0.23 AS build

ARG DTLN_RS_REPO=https://github.com/DataDog/dtln-rs.git
ARG DTLN_RS_COMMIT=5bd53c00d3334615f9b03fa7775402ae2a39b616
ARG RUST_TOOLCHAIN=1.94.1

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH

RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
      --default-toolchain "$RUST_TOOLCHAIN" --target wasm32-unknown-emscripten

WORKDIR /src
RUN git clone "$DTLN_RS_REPO" . && git checkout --detach "$DTLN_RS_COMMIT"
COPY build.rs dtln_post.js ./
COPY config.toml .cargo/config.toml

# The [[bin]] target carries src/wasm.rs's exports; upstream's install-wasm.js
# ships exactly this file as dtln.js.
RUN cargo build --release --locked --target wasm32-unknown-emscripten \
 && mkdir /out \
 && cp target/wasm32-unknown-emscripten/release/dtln-rs.js /out/dtln.js \
 && cp LICENSE /out/LICENSE.datadog && cp NOTICE /out/NOTICE.datadog && cp LICENSE-3rdparty.csv /out/ \
 && { echo "dtln-rs $(git rev-parse HEAD)"; emcc --version | head -1; rustc --version; cargo --version; } > /out/toolchain.txt

FROM scratch AS export
COPY --from=build /out /
