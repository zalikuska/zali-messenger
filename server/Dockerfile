# syntax=docker/dockerfile:1.7
#
# Образ сервера ZaliMessenger.
#
# Контекст сборки — КОРЕНЬ репозитория, не server/: крейт зависит от ../sdk/Rust,
# а в dev-зависимостях и [[test]] есть ../core и ../tests (без них cargo не
# разберёт манифест). Собирать так:
#   docker build -f server/Dockerfile -t zali-server .
# или `docker compose build` (см. docker-compose.yml).

ARG RUST_IMAGE=rust:1-bookworm
ARG RUNTIME_IMAGE=debian:bookworm-slim

# ---------------------------------------------------------------- сборка
FROM ${RUST_IMAGE} AS build

# openssl собирается из исходников (feature "vendored", нужен web-push) —
# для этого в образе rust:* уже есть gcc, make и perl.
# На общей машине с малым запасом памяти сборка Rust легко вызывает OOM-killer,
# поэтому по умолчанию 2 параллельные задачи (как CARGO_BUILD_JOBS=2 на ms).
ARG CARGO_BUILD_JOBS=2
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS} \
    CARGO_TERM_COLOR=never

WORKDIR /src
COPY sdk/Rust ./sdk/Rust
COPY core ./core
COPY tests ./tests
COPY server ./server

WORKDIR /src/server
# Кеши реестра и target живут вне слоёв образа (BuildKit) — повторная сборка
# после правки одного файла не перекачивает и не пересобирает зависимости.
# Бинарник копируем из кеша тем же RUN: после него target/ уже недоступен.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/server/target \
    cargo build --release --locked --bin zali_server \
 && install -D target/release/zali_server /out/zali_server

# ---------------------------------------------------------------- рантайм
FROM ${RUNTIME_IMAGE} AS runtime

# ca-certificates — исходящий HTTPS (Web Push, FCM, Tenor); curl — только для
# HEALTHCHECK; age — опциональная расшифровка секретов из *_FILE_AGE
# (docker-entrypoint.sh), статический бинарник без своих зависимостей. Больше
# ничего не ставим: всё, что есть в образе, доступно тому, кто получит в нём
# выполнение кода.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl age \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 zali \
 && useradd --system --uid 10001 --gid zali --home-dir /data --shell /usr/sbin/nologin zali \
 && install -d -o zali -g zali -m 0700 /data

COPY --from=build /out/zali_server /usr/local/bin/zali_server
# Читает секреты из <ИМЯ>_FILE и ставит umask 077 перед запуском сервера.
COPY --chmod=0755 server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Данные (БД, uploads/, releases/, ключ подписи аддонов) — только в /data.
# Без ZALI_DATA_DIR сервер берёт каталог по пути сборки внутри образа, и всё
# пропало бы при пересоздании контейнера.
ENV ZALI_DATA_DIR=/data \
    BIND_ADDR=0.0.0.0:3000 \
    RUST_LOG=zali_server=info,tower_http=warn

VOLUME ["/data"]
EXPOSE 3000
USER zali
WORKDIR /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/health >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
