#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


COMMAND_TIMEOUT_SECONDS = 2 * 60 * 60


def run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        text=True,
        capture_output=True,
        check=True,
        timeout=COMMAND_TIMEOUT_SECONDS,
    )


def auth_headers(token: str) -> list[str]:
    return ["-H", f"Authorization: Bearer {token}"]


def download(url: str, token: str, destination: Path) -> None:
    run([
        "curl",
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        *auth_headers(token),
        "-o",
        str(destination),
        url,
    ])


def upload(url: str, token: str, source: Path, content_type: str) -> None:
    run([
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        "-X",
        "PUT",
        *auth_headers(token),
        "-H",
        f"Content-Type: {content_type}",
        "--upload-file",
        str(source),
        url,
    ])


class Handler(BaseHTTPRequestHandler):
    server_version = "AutoVideoTranslateMedia/0.4"

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
        except subprocess.TimeoutExpired as exc:
            self.send_json(504, {
                "error": "media command timed out",
                "command": exc.cmd,
            })
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
        result = run([
            "ffprobe",
            "-v",
            "error",
            "-headers",
            f"Authorization: Bearer {body['token']}\r\n",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            body["source_url"],
        ])
        metadata = json.loads(result.stdout)

        fmt = metadata.get("format", {})
        video = next((s for s in metadata.get("streams", []) if s.get("codec_type") == "video"), {})
        audio = next((s for s in metadata.get("streams", []) if s.get("codec_type") == "audio"), {})

        self.send_json(200, {
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
        })

    def handle_render(self) -> None:
        body = self.read_json()
        token = body["token"]

        with tempfile.TemporaryDirectory(prefix="avt-") as tmp:
            work = Path(tmp)
            source = work / "source.mp4"
            output = work / "output.mp4"

            download(body["source_url"], token, source)

            dub = None
            subtitle = None

            if body.get("dub_audio_url"):
                dub = work / "dub.wav"
                download(body["dub_audio_url"], token, dub)

            if body.get("subtitle_url"):
                subtitle = work / "subtitle.ass"
                download(body["subtitle_url"], token, subtitle)

            # The first-stage render has no subtitle or dub. Re-encoding the entire
            # video here is unnecessary and made the UI look permanently stuck.
            if not dub and not subtitle:
                shutil.copyfile(source, output)
                render_mode = "copy"
            else:
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

                if subtitle:
                    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
                else:
                    cmd += ["-c:v", "copy"]

                if dub:
                    cmd += ["-c:a", "aac", "-b:a", "192k"]
                else:
                    cmd += ["-c:a", "copy"]

                cmd += ["-movflags", "+faststart", str(output)]
                run(cmd)
                render_mode = "subtitle" if subtitle else "dub"

            upload(body["output_url"], token, output, "video/mp4")

            self.send_json(200, {
                "ok": True,
                "bytes": output.stat().st_size,
                "output": body["output_url"],
                "mode": render_mode,
            })

    def log_message(self, fmt: str, *args) -> None:
        print(f"[media] {self.address_string()} - {fmt % args}", flush=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
