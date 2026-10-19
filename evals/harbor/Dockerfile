# Builds an installable runtime; it is NOT the benchmark task image.
FROM oven/bun:1.4.2
WORKDIR /opt/ficus-harbor/runtime
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run extensions:install && bun run build:cli
RUN mkdir -p /opt/ficus-harbor/bin && cp /usr/local/bin/bun /opt/ficus-harbor/bin/bun
RUN tar -czf /ficus-runtime.tar.gz -C /opt ficus-harbor
CMD ["true"]
