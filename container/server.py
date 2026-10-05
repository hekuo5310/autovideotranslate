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
    return subprocess.run(cmd, text=True, capture_output=True, check=True, timeout=COMMAND_TIMEOUT_SECONDS)


def auth_headers(token: str) -> list[str]:
    return ["-H", f"Authorization: Bearer {token}"]


def download(url: str, token: str, destination: Path) -> None:
    run(["curl", "--fail", "--location", "--silent", "--show-error", *auth_headers(token), "-o", str(destination), url])


def upload(url: str, token: str, source: Path, content_type: str) -> None:
    run(["curl", "--fail", "--silent", "--show-error", "-X", "PUT", *auth_headers(token), "-H", f"Content-Type: {content_type}", "--upload-file", str(source), url])


def probe_file(path: Path) -> dict:
    result = run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)])
    return json.loads(result.stdout)


def audio_duration(path: Path) -> float:
    meta = probe_file(path)
    stream = next((s for s in meta.get("streams", []) if s.get("codec_type") == "audio"), {})
    value = stream.get("duration") or meta.get("format", {}).get("duration") or 0
    return float(value or 0)


def has_audio(path: Path) -> bool:
    return any(s.get("codec_type") == "audio" for s in probe_file(path).get("streams", []))


def atempo_chain(speed: float) -> str:
    speed = max(0.25, min(4.0, speed))
    parts = []
    while speed > 2.0:
        parts.append("atempo=2.0")
        speed /= 2.0
    while speed < 0.5:
        parts.append("atempo=0.5")
        speed /= 0.5
    parts.append(f"atempo={speed:.6f}")
    return ",".join(parts)


class Handler(BaseHTTPRequestHandler):
    server_version = "AutoVideoTranslateMedia/0.5"

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
            self.send_json(200, {"ok": True, "version": self.server_version})
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
            self.send_json(504, {"error": "media command timed out", "command": exc.cmd})
        except subprocess.CalledProcessError as exc:
            stderr = exc.stderr.decode("utf-8", errors="replace") if isinstance(exc.stderr, bytes) else exc.stderr
            self.send_json(500, {"error": "media command failed", "returncode": exc.returncode, "stderr": (stderr or "")[-6000:]})
        except Exception as exc:
            self.send_json(500, {"error": str(exc)})

    def handle_probe(self) -> None:
        body = self.read_json()
        result = run([
            "ffprobe", "-v", "error", "-headers", f"Authorization: Bearer {body['token']}\r\n",
            "-show_format", "-show_streams", "-of", "json", body["source_url"],
        ])
        metadata = json.loads(result.stdout)
        fmt = metadata.get("format", {})
        video = next((s for s in metadata.get("streams", []) if s.get("codec_type") == "video"), {})
        audio = next((s for s in metadata.get("streams", []) if s.get("codec_type") == "audio"), {})
        self.send_json(200, {
            "duration": float(fmt.get("duration", 0) or 0), "size": int(fmt.get("size", 0) or 0), "bit_rate": int(fmt.get("bit_rate", 0) or 0),
            "video": {"codec": video.get("codec_name"), "width": video.get("width"), "height": video.get("height"), "fps": video.get("avg_frame_rate")},
            "audio": {"codec": audio.get("codec_name"), "sample_rate": audio.get("sample_rate"), "channels": audio.get("channels")},
        })

    def handle_render(self) -> None:
        body = self.read_json()
        token = body["token"]
        with tempfile.TemporaryDirectory(prefix="avt-") as tmp:
            work = Path(tmp)
            source = work / "source.mp4"
            output = work / "output.mp4"
            download(body["source_url"], token, source)

            subtitle = None
            if body.get("subtitle_url"):
                subtitle = work / "subtitle.ass"
                download(body["subtitle_url"], token, subtitle)

            legacy_dub = None
            if body.get("dub_audio_url"):
                legacy_dub = work / "dub.wav"
                download(body["dub_audio_url"], token, legacy_dub)

            manifest = None
            dub_files: list[tuple[Path, dict]] = []
            if body.get("dub_manifest_url"):
                manifest_path = work / "dub-manifest.json"
                download(body["dub_manifest_url"], token, manifest_path)
                manifest = json.loads(manifest_path.read_text("utf-8"))
                for idx, item in enumerate(manifest.get("segments", [])):
                    p = work / f"dub-{idx:05d}.wav"
                    download(item["url"], token, p)
                    dub_files.append((p, item))

            if not subtitle and not legacy_dub and not dub_files:
                shutil.copyfile(source, output)
                render_mode = "copy"
            else:
                cmd = ["ffmpeg", "-y", "-i", str(source)]
                if legacy_dub:
                    cmd += ["-i", str(legacy_dub)]
                for p, _ in dub_files:
                    cmd += ["-i", str(p)]

                filters = []
                audio_map = "0:a?"
                if dub_files:
                    dub_labels = []
                    first_input = 1
                    for idx, (p, item) in enumerate(dub_files):
                        input_idx = first_input + idx
                        target_s = max(0.05, float(item.get("target_ms", item.get("end_ms", 0) - item.get("start_ms", 0))) / 1000.0)
                        actual_s = max(0.05, audio_duration(p))
                        speed = actual_s / target_s
                        delay = max(0, int(item.get("start_ms", 0)))
                        label = f"dub{idx}"
                        filters.append(f"[{input_idx}:a]aresample=44100,{atempo_chain(speed)},adelay={delay}|{delay}[{label}]")
                        dub_labels.append(f"[{label}]")
                    if has_audio(source):
                        filters.append("[0:a]volume=0.28[orig]")
                        mix_inputs = "[orig]" + "".join(dub_labels)
                        count = len(dub_labels) + 1
                    else:
                        mix_inputs = "".join(dub_labels)
                        count = len(dub_labels)
                    filters.append(f"{mix_inputs}amix=inputs={count}:duration=longest:normalize=0[aout]")
                    audio_map = "[aout]"
                elif legacy_dub:
                    audio_map = "1:a:0"

                if filters:
                    cmd += ["-filter_complex", ";".join(filters)]
                if subtitle:
                    escaped = str(subtitle).replace("\\", "\\\\").replace(":", "\\:")
                    cmd += ["-vf", f"ass={escaped}"]

                cmd += ["-map", "0:v:0", "-map", audio_map]
                if subtitle:
                    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
                else:
                    cmd += ["-c:v", "copy"]
                if dub_files or legacy_dub:
                    cmd += ["-c:a", "aac", "-b:a", "192k"]
                else:
                    cmd += ["-c:a", "copy"]
                cmd += ["-movflags", "+faststart", "-shortest", str(output)]
                run(cmd)
                render_mode = "subtitle+dub" if subtitle and (dub_files or legacy_dub) else ("subtitle" if subtitle else "dub")

            upload(body["output_url"], token, output, "video/mp4")
            self.send_json(200, {"ok": True, "bytes": output.stat().st_size, "output": body["output_url"], "mode": render_mode, "segments": len(dub_files)})

    def log_message(self, fmt: str, *args) -> None:
        print(f"[media] {self.address_string()} - {fmt % args}", flush=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
