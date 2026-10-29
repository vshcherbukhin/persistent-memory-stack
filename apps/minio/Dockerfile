# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
FROM golang:1.26.10-alpine3.24@sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308 AS build

ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOMAXPROCS=1 GOMEMLIMIT=768MiB GOGC=50
WORKDIR /build/source
ADD --checksum=sha256:45521908307306e925c98d629e1c17d78c8b72b6ee242b1bfb1409f7d8ee5841 https://codeload.github.com/minio/minio/tar.gz/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a /build/minio-source.tar.gz
COPY upstream/go.mod upstream/go.sum /build/locks/
RUN tar -xzf /build/minio-source.tar.gz --strip-components=1 \
    && cmp go.mod /build/locks/go.mod && cmp go.sum /build/locks/go.sum \
    && mkdir -p /out /runtime/tmp /runtime/data \
    && chmod 1777 /runtime/tmp

# The context locks mount read-only. Toolchains and module revisions cannot update
# themselves; module sums remain verified. Build one package at a time with a
# lower Go memory target. The task-versioned disk cache avoids a large tmpfs
# competing with the installed services for RAM; it is ordinary build cache.
RUN --mount=type=bind,source=upstream/go.mod,target=/build/source/go.mod,readonly \
    --mount=type=bind,source=upstream/go.sum,target=/build/source/go.sum,readonly \
    --mount=type=cache,id=pm-minio-9e49d5e7-mod,target=/go/pkg/mod \
    --mount=type=cache,id=pm-minio-go12610-lowmem-v1,target=/root/.cache/go-build \
    go mod download \
    && go build -p 1 -mod=readonly -buildvcs=false -trimpath \
      -ldflags='-s -w -X github.com/minio/minio/cmd.Version=2025-10-15T17:29:55Z -X github.com/minio/minio/cmd.ReleaseTag=RELEASE.2025-10-15T17-29-55Z -X github.com/minio/minio/cmd.CommitID=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a -X github.com/minio/minio/cmd.ShortCommitID=9e49d5e7a648f -X github.com/minio/minio/cmd.CopyrightYear=2025 -X github.com/minio/minio/cmd.GOPATH=/go -X github.com/minio/minio/cmd.GOROOT=/usr/local/go' \
      -o /out/minio . \
    && cmp go.mod /build/locks/go.mod && cmp go.sum /build/locks/go.sum

COPY health/ /build/health/
WORKDIR /build/health
RUN --mount=type=cache,id=pm-minio-go12610-lowmem-v1,target=/root/.cache/go-build \
    GO111MODULE=off go test -p 1 -count=1 \
    && GO111MODULE=off go build -p 1 -trimpath -ldflags='-s -w' -o /out/pm-minio-health .

FROM scratch
LABEL org.opencontainers.image.title="Persistent Memory MinIO source build" \
      org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a" \
      org.opencontainers.image.version="RELEASE.2025-10-15T17-29-55Z" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
COPY --from=build /runtime/ /
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/minio /usr/bin/minio
COPY --from=build /out/pm-minio-health /usr/bin/pm-minio-health
COPY --from=build /build/minio-source.tar.gz /usr/share/minio/source.tar.gz
COPY --from=build /usr/local/go/LICENSE /licenses/go/LICENSE
COPY upstream/ /licenses/minio/
COPY health/LICENSE /licenses/pm-minio-health/LICENSE
COPY source.json NOTICE /usr/share/minio/
ENV HOME=/tmp
EXPOSE 9000 9001
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 CMD ["/usr/bin/pm-minio-health"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/minio"]
CMD ["server", "/data", "--console-address", ":9001"]
