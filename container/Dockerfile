FROM debian:trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.py /app/server.py

EXPOSE 8080
CMD ["python3", "/app/server.py"]
