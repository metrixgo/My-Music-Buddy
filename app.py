import json
import os
import re
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote
from uuid import uuid4

from flask import Flask, jsonify, request, send_from_directory
from werkzeug.utils import secure_filename
import imageio_ffmpeg
import yt_dlp

PORT = int(__import__("os").environ.get("PORT", "3000"))
ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
STORAGE_DIR = ROOT / "storage"
AUDIO_DIR = STORAGE_DIR / "audio"
LIBRARY_PATH = STORAGE_DIR / "library.json"
PLAYLISTS_PATH = STORAGE_DIR / "playlists.json"
TMP_DIR = STORAGE_DIR / "tmp"

ALLOWED_AUDIO_EXTENSIONS = {".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".webm"}
ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}
IMPORT_JOBS = {}
IMPORT_JOBS_LOCK = threading.Lock()

app = Flask(__name__, static_folder=str(PUBLIC_DIR), static_url_path="")


def ensure_storage():
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    if not LIBRARY_PATH.exists():
        LIBRARY_PATH.write_text("[]\n", encoding="utf-8")
    if not PLAYLISTS_PATH.exists():
        PLAYLISTS_PATH.write_text("[]\n", encoding="utf-8")


def load_json(path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def save_json(path, data):
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def sanitize_text(value):
    return str(value or "").strip()


def sanitize_filename(value):
    name = secure_filename(str(value or ""))
    return re.sub(r"[^A-Za-z0-9_.-]", "-", name)


def make_track(name, author="", cover="", publish_date="", notes="", audio_filename="", source="upload", source_url=""):
    track_id = str(uuid4())
    return {
        "id": track_id,
        "name": sanitize_text(name) or f"Track {track_id[:8]}",
        "author": sanitize_text(author),
        "cover": sanitize_text(cover),
        "publishDate": sanitize_text(publish_date),
        "relativeVolume": 1.0,
        "notes": sanitize_text(notes),
        "audioFilename": audio_filename,
        "audioUrl": f"/audio/{audio_filename}" if audio_filename else "",
        "source": source,
        "sourceUrl": sanitize_text(source_url),
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }


def make_playlist(name, cover="", notes=""):
    playlist_id = str(uuid4())
    return {
        "id": playlist_id,
        "name": sanitize_text(name) or f"Playlist {playlist_id[:8]}",
        "cover": sanitize_text(cover),
        "notes": sanitize_text(notes),
        "trackIds": [],
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }


def audio_path(filename):
    return AUDIO_DIR / Path(filename).name


def delete_audio_file(filename):
    try:
        audio_path(filename).unlink(missing_ok=True)
    except Exception:
        pass


def get_tracks():
    return load_json(LIBRARY_PATH)


def save_tracks(tracks):
    save_json(LIBRARY_PATH, tracks)


def get_playlists():
    return load_json(PLAYLISTS_PATH)


def save_playlists(playlists):
    save_json(PLAYLISTS_PATH, playlists)


def find_item(items, item_id):
    return next((item for item in items if item.get("id") == item_id), None)


def save_uploaded_audio(upload_file):
    filename = sanitize_filename(upload_file.filename)
    if not filename:
        raise ValueError("Please choose an audio file.")
    extension = Path(filename).suffix.lower()
    if extension not in ALLOWED_AUDIO_EXTENSIONS:
        raise ValueError("Unsupported audio format.")
    saved_filename = f"{Path(filename).stem}-{uuid4().hex}{extension}"
    upload_file.save(AUDIO_DIR / saved_filename)
    return saved_filename


def save_uploaded_video(upload_file):
    filename = sanitize_filename(upload_file.filename)
    if not filename:
        raise ValueError("Please choose a video file.")
    extension = Path(filename).suffix.lower()
    if extension not in ALLOWED_VIDEO_EXTENSIONS:
        raise ValueError("Unsupported video format.")
    saved_filename = f"{Path(filename).stem}-{uuid4().hex}{extension}"
    output_path = TMP_DIR / saved_filename
    upload_file.save(output_path)
    return output_path


def parse_duration_seconds(raw_duration):
    parts = raw_duration.strip().split(":")
    if len(parts) != 3:
        return 0.0
    try:
        hours = float(parts[0])
        minutes = float(parts[1])
        seconds = float(parts[2])
    except ValueError:
        return 0.0
    return (hours * 3600.0) + (minutes * 60.0) + seconds


def parse_ffmpeg_time_to_seconds(raw_value):
    value = str(raw_value or "").strip()
    if not value:
        return 0.0
    if ":" in value:
        return parse_duration_seconds(value)
    try:
        numeric = float(value)
        if numeric > 100000:
            return numeric / 1_000_000.0
        return numeric
    except ValueError:
        return 0.0


def read_media_duration_seconds(ffmpeg_exe, input_path):
    proc = subprocess.run(
        [ffmpeg_exe, "-i", str(input_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    stderr = proc.stderr or ""
    match = re.search(r"Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)", stderr)
    if not match:
        return 0.0
    return parse_duration_seconds(match.group(1))


def create_import_job(job_type):
    job_id = str(uuid4())
    job = {
        "id": job_id,
        "type": job_type,
        "status": "running",
        "stage": "queued",
        "progress": 0,
        "message": "Queued.",
        "error": "",
        "track": None,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    with IMPORT_JOBS_LOCK:
        IMPORT_JOBS[job_id] = job
    return job


def update_import_job(job_id, **updates):
    with IMPORT_JOBS_LOCK:
        job = IMPORT_JOBS.get(job_id)
        if not job:
            return
        job.update(updates)
        if "progress" in job:
            job["progress"] = max(0, min(100, int(job["progress"])))


def get_import_job(job_id):
    with IMPORT_JOBS_LOCK:
        return IMPORT_JOBS.get(job_id)


def finalize_job_success(job_id, track):
    update_import_job(
        job_id,
        status="completed",
        stage="done",
        progress=100,
        message="Import completed.",
        track=track,
    )


def finalize_job_error(job_id, error):
    update_import_job(
        job_id,
        status="failed",
        stage="failed",
        message="Import failed.",
        error=str(error) or "Unknown error.",
    )


def import_youtube_audio(source_url):
    if not source_url:
        raise ValueError("A YouTube URL is required.")
    if not re.match(r"^https?://(www\.)?(youtube\.com|youtu\.be)/", source_url, re.IGNORECASE):
        raise ValueError("Please provide a valid YouTube URL.")

    try:
        with yt_dlp.YoutubeDL({
            "noplaylist": True,
            "nopart": True,
            "quiet": True,
            "no_warnings": True,
            "format": "bestaudio/best",
            "outtmpl": str(AUDIO_DIR / "%(id)s.%(ext)s"),
        }) as ydl:
            result = ydl.extract_info(source_url, download=False)
            if not result:
                raise RuntimeError("Unable to read YouTube metadata.")

            if isinstance(result, dict) and result.get("entries"):
                entries = result.get("entries")
                if isinstance(entries, list) and entries:
                    result = entries[0]
                else:
                    raise RuntimeError("Unexpected YouTube metadata entries format.")

            if not isinstance(result, dict):
                raise RuntimeError("Unexpected YouTube metadata format.")

            video_id = result.get("id") or str(uuid4())
            filename_base = sanitize_filename(result.get("title") or video_id)
            outtmpl = str(AUDIO_DIR / f"{filename_base}-{video_id}.%(ext)s")
            ydl.params["outtmpl"] = {"default": outtmpl}
            ydl.download([source_url])
    except Exception as error:
        raise RuntimeError(str(error) or "Failed to import YouTube audio.") from error

    matches = [item.name for item in AUDIO_DIR.iterdir() if item.name.startswith(f"{filename_base}-{video_id}")]
    if not matches:
        raise RuntimeError("The audio file was not created.")
    return result, matches[0]


def import_youtube_audio_with_progress(source_url, progress_callback):
    if not source_url:
        raise ValueError("A YouTube URL is required.")
    if not re.match(r"^https?://(www\.)?(youtube\.com|youtu\.be)/", source_url, re.IGNORECASE):
        raise ValueError("Please provide a valid YouTube URL.")

    metadata = {}
    filename_base = ""
    video_id = ""

    def on_progress(progress_data):
        nonlocal metadata, filename_base, video_id
        if progress_data.get("status") == "downloading":
            total = progress_data.get("total_bytes") or progress_data.get("total_bytes_estimate") or 0
            downloaded = progress_data.get("downloaded_bytes") or 0
            if total > 0:
                percent = int((downloaded / total) * 100)
            else:
                raw_percent = str(progress_data.get("_percent_str") or "").replace("%", "").strip()
                try:
                    percent = int(float(raw_percent))
                except Exception:
                    percent = 0
            progress_callback(min(99, max(0, percent)), "Downloading audio from YouTube...")
        elif progress_data.get("status") == "finished":
            progress_callback(100, "Download finished.")
            info = progress_data.get("info_dict")
            if isinstance(info, dict):
                metadata = info
                filename_base = sanitize_filename(info.get("title") or info.get("id") or "track")
                video_id = str(info.get("id") or "")

    ydl_config = {
        "noplaylist": True,
        "nopart": True,
        "quiet": True,
        "no_warnings": True,
        "format": "bestaudio/best",
        "outtmpl": str(AUDIO_DIR / "%(id)s.%(ext)s"),
        "progress_hooks": [on_progress],
    }
    try:
        with yt_dlp.YoutubeDL(ydl_config) as ydl:
            info = ydl.extract_info(source_url, download=False)
            if isinstance(info, dict) and info.get("entries"):
                entries = info.get("entries")
                if isinstance(entries, list) and entries:
                    info = entries[0]
            if not isinstance(info, dict):
                raise RuntimeError("Unexpected YouTube metadata format.")
            metadata = info
            video_id = str(metadata.get("id") or str(uuid4()))
            filename_base = sanitize_filename(metadata.get("title") or video_id)
            ydl.params["outtmpl"] = {"default": str(AUDIO_DIR / f"{filename_base}-{video_id}.%(ext)s")}
            ydl.download([source_url])
    except Exception as error:
        raise RuntimeError(str(error) or "Failed to import YouTube audio.") from error

    matches = [item.name for item in AUDIO_DIR.iterdir() if item.name.startswith(f"{filename_base}-{video_id}")]
    if not matches:
        raise RuntimeError("The audio file was not created.")
    return metadata, matches[0]


def convert_video_to_audio(video_path, original_filename, progress_callback):
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    output_filename = f"{Path(sanitize_filename(original_filename)).stem}-{uuid4().hex}.mp3"
    output_path = AUDIO_DIR / output_filename
    duration_seconds = read_media_duration_seconds(ffmpeg_exe, video_path)
    command = [
        ffmpeg_exe,
        "-y",
        "-i",
        str(video_path),
        "-vn",
        "-acodec",
        "libmp3lame",
        "-q:a",
        "2",
        "-progress",
        "pipe:1",
        "-nostats",
        str(output_path),
    ]
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    try:
        if process.stdout is not None:
            for line in process.stdout:
                if not line:
                    continue
                line = line.strip()
                if line.startswith("out_time_ms=") or line.startswith("out_time_us=") or line.startswith("out_time="):
                    try:
                        elapsed_seconds = parse_ffmpeg_time_to_seconds(line.split("=", 1)[1])
                        if duration_seconds > 0:
                            percent = int((elapsed_seconds / duration_seconds) * 100)
                            progress_callback(min(99, max(0, percent)), "Converting video to audio...")
                    except Exception:
                        pass
                elif line == "progress=end":
                    progress_callback(100, "Conversion completed.")
    finally:
        return_code = process.wait()
    if return_code != 0:
        output_path.unlink(missing_ok=True)
        raise RuntimeError("ffmpeg failed while converting video.")
    if not output_path.exists():
        raise RuntimeError("Audio output was not created.")
    return output_filename


def run_youtube_import_job(job_id, source_url):
    try:
        update_import_job(job_id, stage="download", progress=1, message="Starting YouTube import...")

        def callback(percent, message):
            update_import_job(job_id, stage="download", progress=percent, message=message)

        info, filename = import_youtube_audio_with_progress(source_url, callback)
        track = make_track(
            name=info.get("title") if isinstance(info, dict) else Path(filename).stem,
            author=info.get("uploader") if isinstance(info, dict) else "",
            cover=info.get("thumbnail") if isinstance(info, dict) else "",
            publish_date=info.get("upload_date") if isinstance(info, dict) else "",
            notes=info.get("description") if isinstance(info, dict) else "",
            audio_filename=filename,
            source="youtube",
            source_url=source_url,
        )
        tracks = get_tracks()
        tracks.insert(0, track)
        save_tracks(tracks)
        finalize_job_success(job_id, track)
    except Exception as error:
        finalize_job_error(job_id, error)


def run_video_import_job(job_id, video_path, original_filename):
    try:
        update_import_job(job_id, stage="convert", progress=1, message="Preparing conversion...")

        def callback(percent, message):
            update_import_job(job_id, stage="convert", progress=percent, message=message)

        audio_filename = convert_video_to_audio(video_path, original_filename, callback)
        track = make_track(
            name=Path(original_filename).stem,
            audio_filename=audio_filename,
            source="upload",
            source_url="",
        )
        tracks = get_tracks()
        tracks.insert(0, track)
        save_tracks(tracks)
        finalize_job_success(job_id, track)
    except Exception as error:
        finalize_job_error(job_id, error)
    finally:
        try:
            Path(video_path).unlink(missing_ok=True)
        except Exception:
            pass


def clear_all_data():
    for file_path in AUDIO_DIR.iterdir():
        try:
            file_path.unlink()
        except Exception:
            pass
    save_tracks([])
    save_playlists([])


@app.get("/api/library")
def api_get_library():
    return jsonify({"tracks": get_tracks()})


@app.post("/api/library/upload-audio")
def api_upload_audio():
    if "audio" not in request.files:
        return jsonify({"error": "Please attach an audio file."}), 400
    upload_file = request.files["audio"]
    try:
        filename = save_uploaded_audio(upload_file)
        track = make_track(
            name=Path(upload_file.filename).stem,
            audio_filename=filename,
            source="upload",
            source_url="",
        )
        tracks = get_tracks()
        tracks.insert(0, track)
        save_tracks(tracks)
        return jsonify({"track": track}), 201
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except Exception as error:
        return jsonify({"error": str(error) or "Unable to save audio."}), 500


@app.post("/api/library/youtube")
def api_import_youtube():
    payload = request.get_json(silent=True)
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            payload = {"url": payload}
    if not isinstance(payload, dict):
        payload = {}
    source_url = str(payload.get("url") or payload.get("URL") or "").strip()
    if not source_url:
        return jsonify({"error": "A YouTube URL is required."}), 400
    if not re.match(r"^https?://(www\.)?(youtube\.com|youtu\.be)/", source_url, re.IGNORECASE):
        return jsonify({"error": "Please provide a valid YouTube URL."}), 400
    job = create_import_job("youtube")
    thread = threading.Thread(
        target=run_youtube_import_job,
        args=(job["id"], source_url),
        daemon=True,
    )
    thread.start()
    return jsonify({"jobId": job["id"]}), 202


@app.post("/api/library/upload-video")
def api_upload_video():
    if "video" not in request.files:
        return jsonify({"error": "Please attach a video file."}), 400
    upload_file = request.files["video"]
    try:
        video_path = save_uploaded_video(upload_file)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except Exception as error:
        return jsonify({"error": str(error) or "Unable to save video file."}), 500

    job = create_import_job("video")
    thread = threading.Thread(
        target=run_video_import_job,
        args=(job["id"], str(video_path), upload_file.filename),
        daemon=True,
    )
    thread.start()
    return jsonify({"jobId": job["id"]}), 202


@app.get("/api/import-jobs/<job_id>")
def api_get_import_job(job_id):
    job = get_import_job(job_id)
    if not job:
        return jsonify({"error": "Import job not found."}), 404
    return jsonify({"job": job})


@app.put("/api/library/<track_id>")
def api_update_track(track_id):
    payload = request.get_json(silent=True) or {}
    tracks = get_tracks()
    track = find_item(tracks, track_id)
    if not track:
        return jsonify({"error": "Track not found."}), 404
    track["name"] = sanitize_text(payload.get("name") or track["name"])
    track["author"] = sanitize_text(payload.get("author") or track["author"])
    track["cover"] = sanitize_text(payload.get("cover") or track["cover"])
    track["publishDate"] = sanitize_text(payload.get("publishDate") or track["publishDate"])
    track["notes"] = sanitize_text(payload.get("notes") or track["notes"])
    try:
        track["relativeVolume"] = max(0.1, min(2.0, float(payload.get("relativeVolume") or track.get("relativeVolume", 1.0))))
    except Exception:
        track["relativeVolume"] = track.get("relativeVolume", 1.0)
    save_tracks(tracks)
    return jsonify({"track": track})


@app.delete("/api/library/<track_id>")
def api_delete_track(track_id):
    tracks = get_tracks()
    track = find_item(tracks, track_id)
    if not track:
        return jsonify({"error": "Track not found."}), 404
    delete_audio_file(track.get("audioFilename") or "")
    save_tracks([item for item in tracks if item.get("id") != track_id])
    playlists = get_playlists()
    for playlist in playlists:
        playlist["trackIds"] = [tid for tid in playlist.get("trackIds", []) if tid != track_id]
    save_playlists(playlists)
    return jsonify({"deleted": track_id})


@app.get("/api/playlists")
def api_get_playlists():
    return jsonify({"playlists": get_playlists()})


@app.post("/api/playlists")
def api_create_playlist():
    payload = request.get_json(silent=True) or {}
    if not payload.get("name"):
        return jsonify({"error": "Playlist name is required."}), 400
    playlist = make_playlist(payload.get("name"), payload.get("cover") or "", payload.get("notes") or "")
    playlists = get_playlists()
    playlists.insert(0, playlist)
    save_playlists(playlists)
    return jsonify({"playlist": playlist}), 201


@app.put("/api/playlists/<playlist_id>")
def api_update_playlist(playlist_id):
    payload = request.get_json(silent=True) or {}
    playlists = get_playlists()
    playlist = find_item(playlists, playlist_id)
    if not playlist:
        return jsonify({"error": "Playlist not found."}), 404
    playlist["name"] = sanitize_text(payload.get("name") or playlist["name"])
    playlist["cover"] = sanitize_text(payload.get("cover") or playlist["cover"])
    playlist["notes"] = sanitize_text(payload.get("notes") or playlist["notes"])
    save_playlists(playlists)
    return jsonify({"playlist": playlist})


@app.delete("/api/playlists/<playlist_id>")
def api_delete_playlist(playlist_id):
    playlists = get_playlists()
    playlist = find_item(playlists, playlist_id)
    if not playlist:
        return jsonify({"error": "Playlist not found."}), 404
    save_playlists([item for item in playlists if item.get("id") != playlist_id])
    return jsonify({"deleted": playlist_id})


@app.post("/api/playlists/<playlist_id>/tracks")
def api_add_track_to_playlist(playlist_id):
    payload = request.get_json(silent=True) or {}
    track_id = str(payload.get("trackId") or "").strip()
    if not track_id:
        return jsonify({"error": "Track id is required."}), 400
    playlists = get_playlists()
    playlist = find_item(playlists, playlist_id)
    if not playlist:
        return jsonify({"error": "Playlist not found."}), 404
    if track_id in playlist.get("trackIds", []):
        return jsonify({"error": "Track already in playlist."}), 400
    if not find_item(get_tracks(), track_id):
        return jsonify({"error": "Track not found."}), 404
    playlist.setdefault("trackIds", []).append(track_id)
    save_playlists(playlists)
    return jsonify({"playlist": playlist})


@app.delete("/api/playlists/<playlist_id>/tracks/<track_id>")
def api_remove_track_from_playlist(playlist_id, track_id):
    playlists = get_playlists()
    playlist = find_item(playlists, playlist_id)
    if not playlist:
        return jsonify({"error": "Playlist not found."}), 404
    playlist["trackIds"] = [tid for tid in playlist.get("trackIds", []) if tid != track_id]
    save_playlists(playlists)
    return jsonify({"playlist": playlist})


@app.delete("/api/settings/clear")
def api_clear_data():
    try:
        clear_all_data()
        return jsonify({"success": True})
    except Exception as error:
        return jsonify({"error": str(error) or "Unable to clear data."}), 500


@app.get("/audio/<path:filename>")
def get_audio(filename):
    return send_from_directory(AUDIO_DIR, unquote(filename))


@app.get("/")
def index():
    return send_from_directory(PUBLIC_DIR, "index.html")


if __name__ == "__main__":
    ensure_storage()
    app.run(host="127.0.0.1", port=PORT, debug=False)
