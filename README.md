# MyMusicBuddy

MyMusicBuddy is a tiny web app where a user pastes a YouTube link, the server extracts audio only, stores it locally, and adds it to a playable music library.

## What it does

- Accepts a YouTube URL in the browser
- Uses the `yt_dlp` Python library directly
- Stores the saved audio file locally
- Saves track metadata in `storage/library.json`
- Lets users play saved tracks from the browser

## Requirements

- Python 3+
- `yt-dlp` installed for the Python environment running on the machine
- `imageio-ffmpeg` installed (provides `ffmpeg` for video-to-audio conversion)

Install `yt-dlp` if needed:

```bash
python -m pip install --user yt-dlp
python -m pip install --user imageio-ffmpeg
```

## Run it

```bash
python app.py
```

Then open [http://localhost:3000](http://localhost:3000).

## Storage

- Audio files: `storage/audio/`
- Track metadata: `storage/library.json`
