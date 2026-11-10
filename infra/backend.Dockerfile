FROM golang:1.26-alpine AS build
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY}
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /server .

FROM alpine:3.23
RUN apk add --no-cache ca-certificates && addgroup -S publisher && adduser -S publisher -G publisher && mkdir /data && chown publisher:publisher /data
COPY --from=build /server /usr/local/bin/server
USER publisher
EXPOSE 8081
ENTRYPOINT ["server"]
