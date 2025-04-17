- [Docker `mattfly/webcapture-servicei`](https://hub.docker.com/repository/docker/mattfly/webcapture-service)
# Web Capture API

Simple pupeteer wrapper for capturing web pages as images or webp useful for creating thumbnails.

Set `AUTH_TOKEN` in your environment to protect `noncache` routes.

Usage:
```bash
docker-compose up
```

Then, you can use the API to capture web pages. For example, to capture a page as a webp recordered at 5 seconds:
```bash
curl http://127.0.0.1:2000/capture\?url\=https://games.h4ks.com/game/yuyy\&format\=webp\&length\=5 -o output.webp
```
