FROM rust:1.90-bookworm AS rust-builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
RUN cargo build --release -p voxi-server

FROM node:20-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=rust-builder /app/target/release/voxi-server /usr/local/bin/voxi-server
COPY --from=frontend-builder /app/frontend/dist /app/dist
COPY crates/voxi-server/data /app/data

ENV PORT=8080
ENV VOXI_WORDS_DIR=/app/data
ENV VOXI_DIST_DIR=/app/dist
EXPOSE 8080

CMD ["voxi-server"]
