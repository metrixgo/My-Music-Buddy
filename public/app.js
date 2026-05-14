const state = {
  tracks: [],
  playlists: [],
  activeView: "library",
  currentTrackId: null,
  currentPlaylistId: null,
  playbackMode: "order",
  expandedTrackId: null,
  expandedPlaylistId: null,
};

const statusEl = document.getElementById("status");
const libraryList = document.getElementById("library-list");
const playlistList = document.getElementById("playlist-list");
const trackTemplate = document.getElementById("track-card-template");
const playlistTemplate = document.getElementById("playlist-card-template");
const audioElement = document.getElementById("global-audio");
const bottomPlayer = document.getElementById("bottom-player");
const bottomPlayerCover = document.getElementById("bottom-player-cover");
const tabs = document.querySelectorAll(".tab-button");
const viewElements = document.querySelectorAll(".view");
const refreshLibraryButton = document.getElementById("refresh-library");
const playlistForm = document.getElementById("playlist-form");
const audioUploadForm = document.getElementById("audio-upload-form");
const videoUploadForm = document.getElementById("video-upload-form");
const youtubeImportForm = document.getElementById("youtube-import-form");
const clearDataButton = document.getElementById("clear-data-button");
const themeSelect = document.getElementById("theme-select");
const playPauseButton = document.getElementById("play-pause-button");
const prevButton = document.getElementById("prev-button");
const nextButton = document.getElementById("next-button");
const playerLabel = document.getElementById("player-label");
const playerContext = document.getElementById("player-context");
const timelineSlider = document.getElementById("timeline-slider");
const timeCurrent = document.getElementById("time-current");
const timeTotal = document.getElementById("time-total");
const modeButtons = document.querySelectorAll(".mode-button");
const audioProgressWrap = document.getElementById("audio-progress-wrap");
const audioProgressBar = document.getElementById("audio-progress-bar");
const audioProgressText = document.getElementById("audio-progress-text");
const youtubeProgressWrap = document.getElementById("youtube-progress-wrap");
const youtubeProgressBar = document.getElementById("youtube-progress-bar");
const youtubeProgressText = document.getElementById("youtube-progress-text");
const videoProgressWrap = document.getElementById("video-progress-wrap");
const videoProgressBar = document.getElementById("video-progress-bar");
const videoProgressText = document.getElementById("video-progress-text");
const youtubeSubmitButton = youtubeImportForm.querySelector("button[type='submit']");
const videoSubmitButton = videoUploadForm.querySelector("button[type='submit']");
let youtubeImportInProgress = false;
let videoImportInProgress = false;

const audioContext = new (window.AudioContext || window.webkitAudioContext)();
const gainNode = audioContext.createGain();
const sourceNode = audioContext.createMediaElementSource(audioElement);
sourceNode.connect(gainNode).connect(audioContext.destination);

audioElement.addEventListener("ended", handleTrackEnd);
audioElement.addEventListener("play", () => {
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
  playPauseButton.textContent = "⏸";
});
audioElement.addEventListener("pause", () => {
  playPauseButton.textContent = "▶";
});
audioElement.addEventListener("loadedmetadata", syncTimeline);
audioElement.addEventListener("timeupdate", syncTimeline);

function formatTime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function syncTimeline() {
  const duration = Number.isFinite(audioElement.duration) ? audioElement.duration : 0;
  const current = Number.isFinite(audioElement.currentTime) ? audioElement.currentTime : 0;
  timelineSlider.value = duration > 0 ? String((current / duration) * 100) : "0";
  timeCurrent.textContent = formatTime(current);
  timeTotal.textContent = formatTime(duration);
}

function setProgress(wrapEl, barEl, textEl, percent, visible = true) {
  const safe = Math.max(0, Math.min(100, Math.round(percent)));
  wrapEl.classList.toggle("hidden", !visible);
  wrapEl.setAttribute("aria-hidden", String(!visible));
  barEl.style.width = `${safe}%`;
  textEl.textContent = `${safe}%`;
}

function setStatus(message = "", kind = "") {
  statusEl.textContent = message;
  statusEl.className = kind ? `status ${kind}` : "status";
}

function setSubmitButtonState(button, busy, idleLabel, busyLabel) {
  button.disabled = Boolean(busy);
  button.textContent = busy ? busyLabel : idleLabel;
}

async function waitForImportJob(jobId, onProgress) {
  while (true) {
    const response = await fetch(`/api/import-jobs/${encodeURIComponent(jobId)}`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Unable to read import progress.");
    }
    const job = payload.job;
    onProgress(job);
    if (job.status === "completed") {
      return job;
    }
    if (job.status === "failed") {
      throw new Error(job.error || "Import failed.");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function setActiveView(view) {
  state.activeView = view;
  tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  viewElements.forEach((element) => element.classList.toggle("active", element.id === `${view}-view`));
}

function updatePlaybackMode(mode) {
  const nextMode = ["order", "shuffle", "repeat"].includes(mode) ? mode : "order";
  state.playbackMode = nextMode;
  modeButtons.forEach((button) => button.classList.toggle("active", button.dataset.mode === nextMode));
  setStatus(`Playback mode: ${nextMode}.`, "success");
}

function formatNow(value) {
  const raw = String(value || "").trim();
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}`;
  }
  return raw;
}

function findTrack(trackId) {
  return state.tracks.find((track) => track.id === trackId) || null;
}

function findPlaylist(playlistId) {
  return state.playlists.find((playlist) => playlist.id === playlistId) || null;
}

function getCurrentQueue() {
  const playlist = state.currentPlaylistId ? findPlaylist(state.currentPlaylistId) : null;
  const sourceIds = playlist?.trackIds?.filter((id) => findTrack(id)) || state.tracks.map((track) => track.id);
  return sourceIds;
}

function getNextTrackId() {
  const queue = getCurrentQueue();
  if (!queue.length) return null;
  if (!state.currentTrackId) return queue[0];
  const index = queue.indexOf(state.currentTrackId);
  if (state.playbackMode === "repeat") {
    return state.currentTrackId;
  }
  if (state.playbackMode === "shuffle") {
    if (queue.length === 1) return queue[0];
    const remaining = queue.filter((id) => id !== state.currentTrackId);
    return remaining[Math.floor(Math.random() * remaining.length)];
  }
  if (index === -1 || index === queue.length - 1) {
    return queue[0];
  }
  return queue[index + 1];
}

function getPreviousTrackId() {
  const queue = getCurrentQueue();
  if (!queue.length) return null;
  if (!state.currentTrackId) return queue[0];
  const index = queue.indexOf(state.currentTrackId);
  if (state.playbackMode === "shuffle") {
    return queue[Math.floor(Math.random() * queue.length)];
  }
  if (index <= 0) {
    return queue[queue.length - 1];
  }
  return queue[index - 1];
}

function selectTrack(trackId, playlistId = null) {
  const track = findTrack(trackId);
  if (!track) {
    setStatus("Track not found.", "error");
    return;
  }
  state.currentTrackId = trackId;
  state.currentPlaylistId = playlistId;
  audioElement.src = track.audioUrl;
  audioElement.currentTime = 0;
  gainNode.gain.value = Number(track.relativeVolume || 1);
  audioElement.play().catch(() => {
    setStatus("Tap play again to start audio.", "muted");
  });
  playerLabel.textContent = track.name;
  playerContext.textContent = `${track.author || "Unknown author"} · ${playlistId ? "Playlist" : "Library"}`;
  bottomPlayerCover.style.backgroundImage = track.cover ? `url('${track.cover}')` : "none";
  playPauseButton.textContent = "⏸";
  bottomPlayer.classList.remove("hidden");
  syncTimeline();
}

function handleTrackEnd() {
  const nextId = getNextTrackId();
  if (nextId) {
    selectTrack(nextId, state.currentPlaylistId);
    setStatus("Playing next track.", "success");
  } else {
    playPauseButton.textContent = "▶";
    setStatus("Playback finished.", "muted");
  }
}

function renderLibrary() {
  libraryList.innerHTML = "";
  if (!state.tracks.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent = "No tracks yet. Use Import to add audio or YouTube music units.";
    libraryList.appendChild(emptyState);
    return;
  }

  state.tracks.forEach((track) => {
    const node = trackTemplate.content.cloneNode(true);
    const card = node.querySelector(".track-card");
    card.dataset.trackId = track.id;
    const coverArt = node.querySelector(".cover-art");
    coverArt.style.backgroundImage = track.cover ? `url('${track.cover}')` : "none";
    node.querySelector(".track-name").textContent = track.name;
    node.querySelector(".track-author").textContent = track.author || "No author provided";
    node.querySelector(".track-source").textContent = track.source === "youtube" ? "YouTube source" : "Uploaded audio";

    const details = node.querySelector(".track-details");
    const toggleButton = node.querySelector(".toggle-button");
    if (state.expandedTrackId === track.id) {
      details.classList.remove("hidden");
    }

    toggleButton.addEventListener("click", () => {
      state.expandedTrackId = state.expandedTrackId === track.id ? null : track.id;
      renderLibrary();
    });

    node.querySelector(".field-name").value = track.name;
    node.querySelector(".field-author").value = track.author;
    node.querySelector(".field-cover").value = track.cover;
    node.querySelector(".field-date").value = track.publishDate;
    node.querySelector(".field-notes").value = track.notes;
    const volumeInput = node.querySelector(".field-volume");
    const volumeValue = node.querySelector(".volume-value");
    volumeInput.value = String(track.relativeVolume || 1);
    volumeValue.textContent = String(track.relativeVolume || 1);
    volumeInput.addEventListener("input", () => {
      volumeValue.textContent = volumeInput.value;
      if (state.currentTrackId === track.id) {
        gainNode.gain.value = Number(volumeInput.value);
      }
    });

    node.querySelector(".play-track").addEventListener("click", () => selectTrack(track.id));
    node.querySelector(".save-track").addEventListener("click", () => saveTrack(track.id));
    node.querySelector(".delete-track").addEventListener("click", () => deleteTrack(track.id));

    const playlistSelect = node.querySelector(".playlist-select");
    const addPlaylistButton = node.querySelector(".add-to-playlist");
    playlistSelect.innerHTML = "";
    if (state.playlists.length) {
      state.playlists.forEach((playlist) => {
        const option = document.createElement("option");
        option.value = playlist.id;
        option.textContent = playlist.name;
        playlistSelect.appendChild(option);
      });
      addPlaylistButton.disabled = false;
    } else {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Create a playlist first";
      playlistSelect.appendChild(option);
      addPlaylistButton.disabled = true;
    }

    addPlaylistButton.addEventListener("click", () => {
      const playlistId = playlistSelect.value;
      if (!playlistId) {
        setStatus("Create a playlist before adding tracks.", "error");
        return;
      }
      addTrackToPlaylist(playlistId, track.id);
    });

    libraryList.appendChild(node);
  });
}

function renderPlaylists() {
  playlistList.innerHTML = "";
  if (!state.playlists.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent = "No playlists yet. Create one and add tracks from the library.";
    playlistList.appendChild(emptyState);
    return;
  }

  state.playlists.forEach((playlist) => {
    const node = playlistTemplate.content.cloneNode(true);
    const card = node.querySelector(".playlist-card");
    card.dataset.playlistId = playlist.id;
    const coverArt = node.querySelector(".cover-art");
    coverArt.style.backgroundImage = playlist.cover ? `url('${playlist.cover}')` : "none";
    node.querySelector(".playlist-name").textContent = playlist.name;
    node.querySelector(".playlist-notes").textContent = playlist.notes || "No notes yet.";

    const details = node.querySelector(".playlist-details");
    const toggleButton = node.querySelector(".toggle-button");
    if (state.expandedPlaylistId === playlist.id) {
      details.classList.remove("hidden");
    }
    toggleButton.addEventListener("click", () => {
      state.expandedPlaylistId = state.expandedPlaylistId === playlist.id ? null : playlist.id;
      renderPlaylists();
    });

    node.querySelector(".playlist-name-field").value = playlist.name;
    node.querySelector(".playlist-cover-field").value = playlist.cover;
    node.querySelector(".playlist-notes-field").value = playlist.notes;
    node.querySelector(".save-playlist").addEventListener("click", () => savePlaylist(playlist.id));
    node.querySelector(".delete-playlist").addEventListener("click", () => deletePlaylist(playlist.id));

    const trackSelect = node.querySelector(".playlist-track-select");
    trackSelect.innerHTML = "";
    const availableTracks = state.tracks.filter((track) => !playlist.trackIds.includes(track.id));
    if (availableTracks.length) {
      availableTracks.forEach((track) => {
        const option = document.createElement("option");
        option.value = track.id;
        option.textContent = track.name;
        trackSelect.appendChild(option);
      });
      node.querySelector(".add-track").disabled = false;
    } else {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No available tracks to add";
      trackSelect.appendChild(option);
      node.querySelector(".add-track").disabled = true;
    }
    node.querySelector(".add-track").addEventListener("click", () => {
      const trackId = trackSelect.value;
      if (trackId) {
        addTrackToPlaylist(playlist.id, trackId);
      }
    });

    const trackList = node.querySelector(".track-list");
    trackList.innerHTML = "";
    if (playlist.trackIds.length) {
      playlist.trackIds.forEach((trackId) => {
        const track = findTrack(trackId);
        if (!track) return;
        const item = document.createElement("div");
        item.className = "playlist-track-item";
        item.innerHTML = `<span>${track.name}</span><div><button type='button' class='secondary play-link'>Play</button><button type='button' class='danger remove-link'>Remove</button></div>`;
        item.querySelector(".play-link").addEventListener("click", () => selectTrack(track.id, playlist.id));
        item.querySelector(".remove-link").addEventListener("click", () => removeTrackFromPlaylist(playlist.id, track.id));
        trackList.appendChild(item);
      });
    } else {
      const empty = document.createElement("div");
      empty.className = "empty-row";
      empty.textContent = "Playlist is empty.";
      trackList.appendChild(empty);
    }

    playlistList.appendChild(node);
  });
}

async function loadLibrary() {
  try {
    const response = await fetch("/api/library");
    const payload = await response.json();
    state.tracks = payload.tracks || [];
    renderLibrary();
  } catch (error) {
    setStatus("Unable to load library.", "error");
  }
}

async function loadPlaylists() {
  try {
    const response = await fetch("/api/playlists");
    const payload = await response.json();
    state.playlists = payload.playlists || [];
    renderPlaylists();
  } catch (error) {
    setStatus("Unable to load playlists.", "error");
  }
}

async function saveTrack(trackId) {
  const card = document.querySelector(`[data-track-id='${trackId}']`);
  if (!card) return;
  const payload = {
    name: card.querySelector(".field-name").value,
    author: card.querySelector(".field-author").value,
    cover: card.querySelector(".field-cover").value,
    publishDate: card.querySelector(".field-date").value,
    notes: card.querySelector(".field-notes").value,
    relativeVolume: card.querySelector(".field-volume").value,
  };
  try {
    const response = await fetch(`/api/library/${trackId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Unable to save track.");
    }
    setStatus("Track saved.", "success");
    await loadLibrary();
    await loadPlaylists();
  } catch (error) {
    setStatus(error.message || "Unable to save track.", "error");
  }
}

async function deleteTrack(trackId) {
  if (!confirm("Delete this track from your library?")) {
    return;
  }
  try {
    const response = await fetch(`/api/library/${trackId}`, {
      method: "DELETE",
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Unable to delete track.");
    }
    setStatus("Track deleted.", "success");
    await loadLibrary();
    await loadPlaylists();
  } catch (error) {
    setStatus(error.message || "Unable to delete track.", "error");
  }
}

async function savePlaylist(playlistId) {
  const card = document.querySelector(`[data-playlist-id='${playlistId}']`);
  if (!card) return;
  const payload = {
    name: card.querySelector(".playlist-name-field").value,
    cover: card.querySelector(".playlist-cover-field").value,
    notes: card.querySelector(".playlist-notes-field").value,
  };
  try {
    const response = await fetch(`/api/playlists/${playlistId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Unable to save playlist.");
    }
    setStatus("Playlist saved.", "success");
    await loadPlaylists();
  } catch (error) {
    setStatus(error.message || "Unable to save playlist.", "error");
  }
}

async function deletePlaylist(playlistId) {
  if (!confirm("Delete this playlist?")) {
    return;
  }
  try {
    const response = await fetch(`/api/playlists/${playlistId}`, {
      method: "DELETE",
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Unable to delete playlist.");
    }
    setStatus("Playlist deleted.", "success");
    await loadPlaylists();
  } catch (error) {
    setStatus(error.message || "Unable to delete playlist.", "error");
  }
}

async function addTrackToPlaylist(playlistId, trackId) {
  try {
    const response = await fetch(`/api/playlists/${playlistId}/tracks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Unable to add track to playlist.");
    }
    setStatus("Track added to playlist.", "success");
    await loadPlaylists();
  } catch (error) {
    setStatus(error.message || "Unable to add track to playlist.", "error");
  }
}

async function removeTrackFromPlaylist(playlistId, trackId) {
  try {
    const response = await fetch(`/api/playlists/${playlistId}/tracks/${trackId}`, {
      method: "DELETE",
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Unable to remove track from playlist.");
    }
    setStatus("Track removed from playlist.", "success");
    await loadPlaylists();
  } catch (error) {
    setStatus(error.message || "Unable to remove track from playlist.", "error");
  }
}

async function uploadAudio(event) {
  event.preventDefault();
  const fileInput = event.target.querySelector("input[name='audio']");
  const file = fileInput.files[0];
  if (!file) {
    setStatus("Choose an audio file first.", "error");
    return;
  }
  const formData = new FormData();
  formData.append("audio", file);
  setProgress(audioProgressWrap, audioProgressBar, audioProgressText, 0, true);
  try {
    const data = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/library/upload-audio");
      xhr.upload.addEventListener("progress", (progressEvent) => {
        if (!progressEvent.lengthComputable) return;
        const percent = (progressEvent.loaded / progressEvent.total) * 100;
        setProgress(audioProgressWrap, audioProgressBar, audioProgressText, percent, true);
      });
      xhr.onload = () => {
        let payload = {};
        try {
          payload = JSON.parse(xhr.responseText || "{}");
        } catch (error) {
          payload = {};
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(payload);
          return;
        }
        reject(new Error(payload.error || "Unable to upload audio."));
      };
      xhr.onerror = () => reject(new Error("Network error while uploading audio."));
      xhr.send(formData);
    });
    setProgress(audioProgressWrap, audioProgressBar, audioProgressText, 100, true);
    setStatus(`Audio uploaded: ${data.track.name}`, "success");
    event.target.reset();
    await loadLibrary();
  } catch (error) {
    setStatus(error.message || "Unable to upload audio.", "error");
  } finally {
    setTimeout(() => setProgress(audioProgressWrap, audioProgressBar, audioProgressText, 0, false), 700);
  }
}

async function importYoutube(event) {
  event.preventDefault();
  if (youtubeImportInProgress) {
    return;
  }
  const url = event.target.querySelector("input[name='url']").value.trim();
  if (!url) {
    setStatus("Paste a YouTube URL first.", "error");
    return;
  }
  youtubeImportInProgress = true;
  setSubmitButtonState(youtubeSubmitButton, true, "Import from YouTube", "Importing...");
  setProgress(youtubeProgressWrap, youtubeProgressBar, youtubeProgressText, 0, true);
  try {
    const response = await fetch("/api/library/youtube", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Unable to import from YouTube.");
    }
    const job = await waitForImportJob(data.jobId, (jobState) => {
      setProgress(youtubeProgressWrap, youtubeProgressBar, youtubeProgressText, Number(jobState.progress || 0), true);
      if (jobState.message) {
        setStatus(jobState.message, "muted");
      }
    });
    setProgress(youtubeProgressWrap, youtubeProgressBar, youtubeProgressText, 100, true);
    setStatus(`Imported ${job.track.name}.`, "success");
    event.target.reset();
    await loadLibrary();
  } catch (error) {
    setStatus(error.message || "Unable to import from YouTube.", "error");
  } finally {
    youtubeImportInProgress = false;
    setSubmitButtonState(youtubeSubmitButton, false, "Import from YouTube", "Importing...");
    setTimeout(() => setProgress(youtubeProgressWrap, youtubeProgressBar, youtubeProgressText, 0, false), 900);
  }
}

async function uploadVideo(event) {
  event.preventDefault();
  if (videoImportInProgress) {
    return;
  }
  const fileInput = event.target.querySelector("input[name='video']");
  const file = fileInput.files[0];
  if (!file) {
    setStatus("Choose a video file first.", "error");
    return;
  }

  videoImportInProgress = true;
  setSubmitButtonState(videoSubmitButton, true, "Upload video", "Uploading...");
  setProgress(videoProgressWrap, videoProgressBar, videoProgressText, 0, true);

  const formData = new FormData();
  formData.append("video", file);

  try {
    const startPayload = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/library/upload-video");
      xhr.upload.addEventListener("progress", (progressEvent) => {
        if (!progressEvent.lengthComputable) return;
        const uploadPercent = (progressEvent.loaded / progressEvent.total) * 50;
        setProgress(videoProgressWrap, videoProgressBar, videoProgressText, uploadPercent, true);
      });
      xhr.onload = () => {
        let payload = {};
        try {
          payload = JSON.parse(xhr.responseText || "{}");
        } catch (error) {
          payload = {};
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(payload);
          return;
        }
        reject(new Error(payload.error || "Unable to upload video."));
      };
      xhr.onerror = () => reject(new Error("Network error while uploading video."));
      xhr.send(formData);
    });

    setSubmitButtonState(videoSubmitButton, true, "Upload video", "Converting...");
    const job = await waitForImportJob(startPayload.jobId, (jobState) => {
      const conversionPercent = Number(jobState.progress || 0);
      const combinedPercent = 50 + (conversionPercent * 0.5);
      setProgress(videoProgressWrap, videoProgressBar, videoProgressText, combinedPercent, true);
      if (jobState.message) {
        setStatus(jobState.message, "muted");
      }
    });
    setProgress(videoProgressWrap, videoProgressBar, videoProgressText, 100, true);
    setStatus(`Video converted and imported: ${job.track.name}.`, "success");
    event.target.reset();
    await loadLibrary();
  } catch (error) {
    setStatus(error.message || "Unable to upload video.", "error");
  } finally {
    videoImportInProgress = false;
    setSubmitButtonState(videoSubmitButton, false, "Upload video", "Uploading...");
    setTimeout(() => setProgress(videoProgressWrap, videoProgressBar, videoProgressText, 0, false), 900);
  }
}

async function clearData() {
  if (!confirm("Clear all saved tracks and playlists? This cannot be undone.")) {
    return;
  }
  try {
    const response = await fetch("/api/settings/clear", { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Unable to clear data.");
    }
    setStatus("All data cleared.", "success");
    state.currentTrackId = null;
    state.currentPlaylistId = null;
    audioElement.pause();
    audioElement.src = "";
    bottomPlayer.classList.add("hidden");
    playerLabel.textContent = "Select a track to play.";
    playerContext.textContent = "";
    bottomPlayerCover.style.backgroundImage = "none";
    syncTimeline();
    await loadLibrary();
    await loadPlaylists();
  } catch (error) {
    setStatus(error.message || "Unable to clear data.", "error");
  }
}

function togglePlayPause() {
  if (audioElement.paused) {
    audioElement.play().catch(() => setStatus("Use the app controls to start audio.", "muted"));
    playPauseButton.textContent = "⏸";
  } else {
    audioElement.pause();
    playPauseButton.textContent = "▶";
  }
}

function changeTrack(direction) {
  const nextId = direction === "next" ? getNextTrackId() : getPreviousTrackId();
  if (nextId) {
    selectTrack(nextId, state.currentPlaylistId);
  }
}

function applyTheme(theme) {
  const safeTheme = theme === "theme-dark" ? "theme-dark" : "theme-blue";
  document.body.className = safeTheme;
  localStorage.setItem("mymusicbuddy-theme", safeTheme);
}

function loadTheme() {
  const saved = localStorage.getItem("mymusicbuddy-theme");
  const nextTheme = saved === "theme-dark" ? "theme-dark" : "theme-blue";
  themeSelect.value = nextTheme;
  applyTheme(nextTheme);
}

function setupListeners() {
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => setActiveView(tab.dataset.view));
  });
  refreshLibraryButton.addEventListener("click", async () => {
    setStatus("Refreshing library...");
    await loadLibrary();
    setStatus("Library updated.", "success");
  });
  playlistForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = event.target.elements["name"].value.trim();
    const cover = event.target.elements["cover"].value.trim();
    const notes = event.target.elements["notes"].value.trim();
    if (!name) {
      setStatus("Playlist name is required.", "error");
      return;
    }
    try {
      const response = await fetch("/api/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, cover, notes }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Unable to create playlist.");
      }
      event.target.reset();
      setStatus("Playlist created.", "success");
      await loadPlaylists();
    } catch (error) {
      setStatus(error.message || "Unable to create playlist.", "error");
    }
  });

  audioUploadForm.addEventListener("submit", uploadAudio);
  videoUploadForm.addEventListener("submit", uploadVideo);
  youtubeImportForm.addEventListener("submit", importYoutube);
  clearDataButton.addEventListener("click", clearData);
  themeSelect.addEventListener("change", () => applyTheme(themeSelect.value));
  playPauseButton.addEventListener("click", togglePlayPause);
  prevButton.addEventListener("click", () => changeTrack("previous"));
  nextButton.addEventListener("click", () => changeTrack("next"));
  timelineSlider.addEventListener("input", () => {
    const duration = Number.isFinite(audioElement.duration) ? audioElement.duration : 0;
    if (!duration) return;
    audioElement.currentTime = (Number(timelineSlider.value) / 100) * duration;
    syncTimeline();
  });
  modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      updatePlaybackMode(button.dataset.mode);
    });
  });
}

async function init() {
  loadTheme();
  setupListeners();
  await loadLibrary();
  await loadPlaylists();
}

init();
