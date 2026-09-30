#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024  # 10 MiB


def run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, text=True, capture_output=True, check=True)


def download(url: str, destination: Path) -> None:
    run([
        "curl",
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "-o",
        str(destination),
        url,
    ])


def upload_session_file(upload_url: str, source: Path) -> dict:
    total = source.stat().st_size
    last_response = None

    with source.open("rb") as handle:
      start = 0
      while start < total:
        chunk = handle.read(UPLOAD_CHUNK_SIZE)
        if not chunk:
          break

        end = start + len(chunk) - 1
        command = [
            "curl",
            "--fail-with-body",
            "--silent",
            "--show-error",
            "-X",
            "PUT",
            "-H",
            f"Content-Length: {len(chunk)}",
            "-H",
            f"Content-Range: bytes {start}-{end}/{total}",
            "--data-binary",
            "@-",
            upload_url,
        ]
        completed = subprocess.run(
            command,
            input=chunk,
            capture_output=True,
            check=True,
        )

        if completed.stdout:
            last_response = json.loads(completed.stdout.decode("utf-8"))
        start = end + 1

    if not isinstance(last_response, dict) or not last_response.get("id"):
        raise RuntimeError("OneDrive upload session did not return the completed driveItem")

    return last_response


class Handler(BaseHTTPRequestHandler):
    server_version = "AutoVideoTranslateMedia/0.2"

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        length = int(self.headers.get("content-length", "0"))
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json(200, {"ok": True})
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        try:
            if self.path == "/probe":
                self.handle_probe()
                return
            if self.path == "/render":
                self.handle_render()
                return
            self.send_json(404, {"error": "not found"})
        except subprocess.CalledProcessError as exc:
            stderr = exc.stderr
            if isinstance(stderr, bytes):
                stderr = stderr.decode("utf-8", errors="replace")
            self.send_json(
                500,
                {
                    "error": "media command failed",
                    "returncode": exc.returncode,
                    "stderr": (stderr or "")[-4000:],
                },
            )
        except Exception as exc:
            self.send_json(500, {"error": str(exc)})

    def handle_probe(self) -> None:
        body = self.read_json()
        source_url = body["source_url"]

        result = run([
            "ffprobe",
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            source_url,
        ])
        metadata = json.loads(result.stdout)

        fmt = metadata.get("format", {})
        video = next(
            (stream for stream in metadata.get("streams", []) if stream.get("codec_type") == "video"),
            {},
        )
        audio = next(
            (stream for stream in metadata.get("streams", []) if stream.get("codec_type") == "audio"),
            {},
        )

        self.send_json(
            200,
            {
                "duration": float(fmt.get("duration", 0) or 0),
                "size": int(fmt.get("size", 0) or 0),
                "bit_rate": int(fmt.get("bit_rate", 0) or 0),
                "video": {
                    "codec": video.get("codec_name"),
                    "width": video.get("width"),
                    "height": video.get("height"),
                    "fps": video.get("avg_frame_rate"),
                },
                "audio": {
                    "codec": audio.get("codec_name"),
                    "sample_rate": audio.get("sample_rate"),
                    "channels": audio.get("channels"),
                },
            },
        )

    def handle_render(self) -> None:
        body = self.read_json()

        with tempfile.TemporaryDirectory(prefix="avt-") as tmp:
            work = Path(tmp)
            source = work / "source.mp4"
            output = work / "output.mp4"

            download(body["source_url"], source)

            dub = None
            subtitle = None

            if body.get("dub_audio_url"):
                dub = work / "dub.wav"
                download(body["dub_audio_url"], dub)

            if body.get("subtitle_url"):
                subtitle = work / "subtitle.ass"
                download(body["subtitle_url"], subtitle)

            cmd = ["ffmpeg", "-y", "-i", str(source)]

            if dub:
                cmd += ["-i", str(dub)]

            if subtitle:
                escaped = str(subtitle).replace("\\", "\\\\").replace(":", "\\:")
                cmd += ["-vf", f"ass={escaped}"]

            if dub:
                cmd += ["-map", "0:v:0", "-map", "1:a:0"]
            else:
                cmd += ["-map", "0:v:0", "-map", "0:a?"]

            cmd += [
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "20",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart",
                str(output),
            ]

            run(cmd)
            drive_item = upload_session_file(body["output_upload_url"], output)

            self.send_json(
                200,
                {
                    "ok": True,
                    "bytes": output.stat().st_size,
                    "item": {
                        "id": drive_item.get("id"),
                        "name": drive_item.get("name"),
                        "size": drive_item.get("size"),
                        "webUrl": drive_item.get("webUrl"),
                    },
                },
            )

    def log_message(self, fmt: str, *args) -> None:
        print(f"[media] {self.address_string()} - {fmt % args}", flush=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
