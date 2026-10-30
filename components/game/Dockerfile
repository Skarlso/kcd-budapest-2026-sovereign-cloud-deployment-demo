FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/asteroid-run .

FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/asteroid-run /asteroid-run
EXPOSE 8080
ENTRYPOINT ["/asteroid-run"]
