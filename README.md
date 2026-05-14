# MyMusicBuddy

## DISCLAIMER

You should only use this web app to download copyright-free audio. Any copyright violation is solely the responsibility of the user.

## Introduction

MyMusicBuddy is an online web-based music platform where users can freely upload their music. They can upload audio, upload video and then convert them to audio, or paste a Youtube link to extract the audio from the video.

## What it does

- Users have three options to upload an audio, either uploading an audio directly, a video, or a Youtube link
- Uses the `yt_dlp` Python library directly
- Stores the saved audio file locally as well as the metadata
- Lets users customize playlists and play saved tracks from the browser

## Requirements

- Python 3+ for the app
- `yt-dlp` for extracting from Youtube
- `imageio-ffmpeg` for converting video to audio

## How to use

Download code zip and extract them into a folder. Open a terminal and navigate to the folder. Type

`npm start`

to start the server and go to your local host to upload your music!

## Storage

- Audio files: `storage/audio/`
- Track metadata: `storage/library.json`
