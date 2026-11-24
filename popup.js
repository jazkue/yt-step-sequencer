const prefix = "yt-step-sequencer:";
const form = document.querySelector("#sequencer");
const settings = document.querySelector("#settings");
const steps = document.querySelector("#steps");
const addStepButton = document.querySelector("#add-step");
const removeStepButton = document.querySelector("#remove-step");
const randomizeButton = document.querySelector("#randomize");
const includeEmptyStepsInput = document.querySelector("#include-empty-steps");
const clearButton = document.querySelector("#clear");
const resetButton = document.querySelector("#reset");
const nextStepButton = document.querySelector("#next-step");
const bpmInput = document.querySelector("#bpm");
const bpmDecrease = document.querySelector("#bpm-decrease");
const bpmIncrease = document.querySelector("#bpm-increase");
const tapTempoButton = document.querySelector("#tap-tempo");
const metronomeInput = document.querySelector("#metronome");
const transport = document.querySelector("#transport");
const status = document.querySelector("#status");
const timing = document.querySelector("#timing");
const pads = document.querySelector("#pads");
const padMode = document.querySelector("#pad-mode");
const padModeControl = document.querySelector("#pad-mode-control");
const connectBox = document.querySelector("#connect");
const videoTitle = document.querySelector("#video-title");
const videoPlayback = document.querySelector("#video-playback");
const link = document.querySelector("#link");
const optionsToggle = document.querySelector("#options-toggle");
const optionsMenu = document.querySelector("#options-menu");
const addVideoButton = document.querySelector("#add-video");
const videoMenu = document.querySelector("#video-menu");
const flashTimers = new WeakMap();
let tabId = null;
let playing = false;
let polling = false;
let commandPending = false;
let commandVersion = 0;
let commandQueue = Promise.resolve();
let bpmTimer = null;
let transportPending = false;
let videoPlaybackPending = false;
let videoAvailable = false;
let selectedStep = null;
let lastStepSerial = -1;
let prohibitedPads = new Set();
let lockedSteps = new Set();
let includeEmptySteps = true;
let videoId = null;
let videoDuration = null;
let defaultPadTimes = {};
let recordedPadTimes = {};
let recordedPadTimesByVideo = {};
let tapTempoTimes = [];
let chorusWindowId = null;
let chorusSession = null;
let chorusReady = false;
let localEnginePlaying = false;
let appliedClockVersion = -1;
let appliedMetronome = false;
const TAP_TEMPO_THRESHOLD = 2000;

async function chorusCommand(command, data = {}) {
  const response = await chrome.runtime.sendMessage({
    type: `${prefix}chorus-${command}`, windowId: chorusWindowId, ...data
  });
  if (!response?.ok) throw new Error(response?.error || "could not update the chorus.");
  return response.session;
}

function connectChorus() {
  const port = chrome.runtime.connect({ name: `${prefix}chorus` });
  port.onMessage.addListener(applyChorus);
  port.onDisconnect.addListener(() => {
    showStatus("chorus connection lost. reconnecting.", true);
    setTimeout(async () => {
      try {
        connectChorus();
        applyChorus(await chorusCommand("get"));
      } catch (error) {
        showStatus(error.message || "could not reconnect to the chorus.", true);
      }
    }, 1000);
  });
}

async function saveVoice(changes) {
  const { recordedPadTimesByVideo: times, ...voiceChanges } = changes;
  const padTime = times && videoId ? { videoId, times: times[videoId] ?? null } : undefined;
  await chorusCommand("voice", { changes: voiceChanges, ...(padTime && { padTime }) });
}

function applyChorus(session) {
  const previous = chorusSession;
  chorusSession = session;
  if (!chorusReady) return;
  const voice = session.voices[String(chorusWindowId)];
  if (!voice) return;
  const reset = (session.resetVersion || 0) !== (previous?.resetVersion || 0);
  const times = normalizeRecordedPadTimesByVideo(session.recordedPadTimesByVideo);
  const currentTimes = videoId ? { ...(times[videoId] || {}) } : {};
  const timesChanged = JSON.stringify(currentTimes) !== JSON.stringify(recordedPadTimes);
  recordedPadTimesByVideo = times;
  if (timesChanged && videoId) {
    recordedPadTimes = currentTimes;
    updatePadLabels();
    if (!reset && localEnginePlaying && tabId !== null) {
      enqueue(async () => {
        try {
          await send("update", { recordedPadTimes: currentTimes });
        } catch (error) {
          showStatus(error.message || "could not update pad times.", true);
        }
      });
    }
  }
  if (tabId !== null && voice.tabId === null) {
    tabId = null;
    videoId = null;
    localEnginePlaying = false;
    appliedMetronome = false;
    videoTitle.textContent = "";
    setUnavailable("choose a video with +.");
  }
  if (reset) {
    setSequence(voice.sequence);
    prohibitedPads = new Set(voice.prohibitedPads);
    updateProhibitedPadControls();
    setConnected(voice.randomize);
    resizeWindow(false, false, true);
    if (tabId !== null) {
      enqueue(async () => {
        try {
          await send("prohibited", { prohibitedPads: voice.prohibitedPads });
          if (localEnginePlaying) {
            await send("update", { randomize: voice.randomize });
            await send("update", { recordedPadTimes: currentTimes });
            await send("update", { sequence: voice.sequence });
          }
        } catch (error) {
          showStatus(error.message || "could not reset the voice.", true);
        }
      });
    }
  } else if (inputs.length !== session.length) {
    const shrinking = inputs.length > session.length;
    setSequence(voice.sequence);
    resizeForSteps(shrinking);
    if (localEnginePlaying && tabId !== null) {
      enqueue(async () => {
        try {
          await send("update", { sequence: voice.sequence });
        } catch (error) {
          showStatus(error.message || "could not update the step count.", true);
        }
      });
    }
  }
  if (!previous || previous.bpm !== session.bpm) bpmInput.value = String(session.bpm);
  metronomeInput.checked = session.metronome;
  playing = session.playing;
  transport.classList.toggle("playing", playing);
  transport.setAttribute("aria-label", playing ? "stop" : "play");
  transport.title = playing ? "stop" : "play";
  if (!playing) {
    for (const label of steps.children) label.classList.remove("active");
    updatePadIndicator(null);
  }
  const owner = Object.entries(session.voices).find(([, item]) => Number.isInteger(item.tabId));
  const enableMetronome = session.metronome && owner?.[0] === String(chorusWindowId);
  if (tabId !== null && enableMetronome !== appliedMetronome) {
    appliedMetronome = enableMetronome;
    enqueue(async () => {
      try {
        await send("metronome", { enabled: enableMetronome });
      } catch (error) {
        appliedMetronome = !enableMetronome;
        if (enableMetronome || !chorusSession.metronome) {
          await chorusCommand("metronome", { enabled: !enableMetronome });
        }
        showStatus(error.message || "could not change the metronome.", true);
      }
    });
  }
  if (tabId !== null && appliedClockVersion !== session.clockVersion) {
    appliedClockVersion = session.clockVersion;
    enqueue(async () => {
      try {
        if (session.clockVersion !== chorusSession.clockVersion || tabId === null) return;
        let state;
        if (!session.playing) {
          if (!localEnginePlaying) return;
          state = await send("stop");
          localEnginePlaying = false;
        } else if (localEnginePlaying) {
          state = await send("sync-clock", { bpm: session.bpm, clock: session.clock });
        } else {
          state = await send("play", {
            sequence: inputs.map(input => input.value), bpm: session.bpm, clock: session.clock,
            randomize: connectBox.checked, prohibitedPads: [...prohibitedPads],
            includeEmptySteps, recordedPadTimes: { ...recordedPadTimes }, lockedSteps: [...lockedSteps]
          });
          localEnginePlaying = true;
        }
        updateState(state);
      } catch (error) {
        localEnginePlaying = false;
        showStatus(error.message || "could not synchronize the voice.", true);
      }
    });
  }
}

function setOptionsOpen(open) {
  optionsMenu.hidden = !open;
  optionsToggle.setAttribute("aria-expanded", String(open));
}

function setVideoMenuOpen(open) {
  videoMenu.hidden = !open;
  addVideoButton.setAttribute("aria-expanded", String(open));
}

addVideoButton.addEventListener("click", async () => {
  if (!videoMenu.hidden) {
    setVideoMenuOpen(false);
    return;
  }
  try {
    const tabs = await chrome.tabs.query({ url: ["https://youtube.com/watch*", "https://www.youtube.com/watch*"] });
    const used = new Set(Object.values(chorusSession?.voices || {}).map(voice => voice.tabId));
    videoMenu.replaceChildren();
    const choices = tabs.filter(tab => Number.isInteger(tab.id) && tab.url &&
      new URL(tab.url).searchParams.has("v") && !used.has(tab.id));
    if (!choices.length) {
      const empty = document.createElement("p");
      empty.textContent = "open another youtube video to add it.";
      videoMenu.append(empty);
    }
    for (const tab of choices) {
      const row = document.createElement("div");
      row.className = "video-choice";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = tab.title || tab.url;
      button.addEventListener("click", async () => {
        try {
          if (tabId === null) {
            location.search = `?tabId=${tab.id}`;
          } else {
            await chrome.windows.create({
              url: `popup.html?tabId=${tab.id}`, type: "popup", width: 412, height: 460
            });
          }
          setVideoMenuOpen(false);
        } catch (error) {
          showStatus(error.message || "could not open the video.", true);
        }
      });
      row.append(button);
      if (tabId !== null) {
        const replace = document.createElement("button");
        replace.type = "button";
        replace.className = "video-replace";
        replace.textContent = "bring here";
        replace.setAttribute("aria-label", `bring ${tab.title || tab.url} here`);
        replace.addEventListener("click", async () => {
          try {
            await send("stop");
            if (appliedMetronome) await send("metronome", { enabled: false });
            await chorusCommand("unassign");
            location.search = `?tabId=${tab.id}`;
          } catch (error) {
            showStatus(error.message || "could not change the video.", true);
          }
        });
        row.append(replace);
      }
      videoMenu.append(row);
    }
    setOptionsOpen(false);
    setVideoMenuOpen(true);
  } catch (error) {
    showStatus(error.message || "could not list youtube tabs.", true);
  }
});

optionsToggle.addEventListener("click", () => {
  setVideoMenuOpen(false);
  setOptionsOpen(optionsMenu.hidden);
});

document.addEventListener("pointerdown", event => {
  if (!optionsMenu.hidden && !optionsMenu.contains(event.target) &&
      !optionsToggle.contains(event.target)) {
    setOptionsOpen(false);
  }
  if (!videoMenu.hidden && !videoMenu.contains(event.target) &&
      !addVideoButton.contains(event.target)) setVideoMenuOpen(false);
});

const inputs = [];
const lockButtons = [];

function appendStep(value) {
  const index = inputs.length;
  const label = document.createElement("div");
  label.className = "step";
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.maxLength = 1;
  input.pattern = "[0-9]";
  input.autocomplete = "off";
  input.value = value;
  input.setAttribute("aria-label", `step ${index + 1}`);
  input.addEventListener("focus", () => {
    selectStep(index);
    input.select();
  });
  input.addEventListener("pointerup", () => {
    selectStep(index);
    input.select();
  });
  input.addEventListener("input", () => {
    if (lockedSteps.has(index)) {
      input.value = input.dataset.lockedValue;
      return;
    }
    if (validStep(input.value)) {
      if (playing && tabId !== null) updateLive({ step: index, value: input.value });
      else {
        status.classList.remove("error");
        if (tabId !== null) updateState({ playing: false, currentStep: -1 });
        else showGuidance();
        const sequence = inputs.map(item => item.value);
        if (sequence.every(validStep)) {
          enqueue(async () => {
            try {
              await saveVoice({ sequence });
            } catch (error) {
              showStatus(error.message || "could not save the sequence.", true);
            }
          });
        }
      }
    } else {
      showStatus("steps must be empty or a digit from 0 to 9.", true);
    }
    input.select();
  });
  const lock = document.createElement("button");
  lock.type = "button";
  lock.className = "step-lock";
  lock.addEventListener("click", () => toggleStepLock(index));
  label.append(input, lock);
  steps.append(label);
  inputs.push(input);
  lockButtons.push(lock);
  updateStepLock(index);
}

function setSequence(sequence) {
  while (inputs.length < sequence.length) appendStep("");
  while (inputs.length > sequence.length) {
    inputs.pop().parentElement.remove();
    lockButtons.pop();
  }
  inputs.forEach((input, index) => { input.value = sequence[index]; });
  inputs.forEach((_, index) => updateStepLock(index));
  removeStepButton.disabled = inputs.length === 1;
  if (selectedStep !== null && selectedStep >= inputs.length) selectStep(null);
}

function updateStepLock(index) {
  const locked = lockedSteps.has(index);
  const input = inputs[index];
  const button = lockButtons[index];
  input.readOnly = locked;
  input.dataset.lockedValue = input.value;
  button.classList.toggle("locked", locked);
  button.setAttribute("aria-pressed", String(locked));
  const label = `${locked ? "unlock" : "lock"} step ${index + 1}`;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = locked
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10V7a5 5 0 0 1 10 0v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zm2 0h6V7a3 3 0 0 0-6 0z"></path></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10V7a5 5 0 0 1 9.5-2.2l-1.8.9A3 3 0 0 0 9 7v3h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z"></path></svg>';
}

function setLockedSteps(indices) {
  lockedSteps = new Set(indices);
  inputs.forEach((_, index) => updateStepLock(index));
  removeStepButton.disabled = inputs.length === 1;
}

function toggleStepLock(index) {
  if (!lockedSteps.has(index) && !validStep(inputs[index].value)) {
    showGuidance();
    return;
  }
  const previous = new Set(lockedSteps);
  const indices = new Set(previous);
  if (indices.has(index)) indices.delete(index);
  else indices.add(index);
  setLockedSteps(indices);
  if (!status.classList.contains("error")) showGuidance();
  const value = [...indices];
  enqueue(async () => {
    let synchronized = false;
    try {
      if (tabId !== null) await send("locks", { lockedSteps: value });
      synchronized = true;
      await saveVoice({ lockedSteps: value });
    } catch (error) {
      if (!synchronized && lockedSteps.size === indices.size &&
          [...indices].every(step => lockedSteps.has(step))) {
        setLockedSteps(previous);
      }
      showStatus(error.message || "could not synchronize step locks.", true);
    }
  });
}

function defaultSequence() {
  return Array.from({ length: 8 }, (_, index) => String(index));
}

setSequence(defaultSequence());

const padButtons = new Map();
const padContainers = new Map();
const prohibitedButtons = new Map();
const recordButtons = new Map();
const scrubberButtons = new Map();
const undoButtons = new Map();
const padTimers = new Map();
let activeScrubber = null;
let scrubStartX = 0;
let scrubStartTime = 0;
let lastScrubTime = 0;
const SCRUB_THROTTLE = 16;
const SCRUB_SENSITIVITY = 100; // milliseconds per pixel

for (const key of "1234567890") {
  const pad = document.createElement("div");
  pad.className = "pad";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pad-play";
  button.textContent = key;
  button.setAttribute("aria-label", `play ${key}`);
  button.disabled = true;
  button.addEventListener("click", () => triggerPad(key));
  button.draggable = true;
  button.addEventListener("dragstart", event => {
    event.dataTransfer.setData("application/x-yt-pad", key);
    event.dataTransfer.effectAllowed = "copy";
  });
  const prohibited = document.createElement("button");
  prohibited.type = "button";
  prohibited.className = "prohibit-toggle";
  prohibited.setAttribute("aria-label", `forbid pad ${key}`);
  prohibited.setAttribute("aria-pressed", "false");
  prohibited.title = `forbid pad ${key}`;
  prohibited.disabled = true;
  prohibited.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M5.6 5.6l12.8 12.8"></path></svg>';
  prohibited.addEventListener("click", () => toggleProhibitedPad(key));
  const record = document.createElement("button");
  record.type = "button";
  record.className = "record-toggle";
  record.setAttribute("aria-label", `record current time on pad ${key}`);
  record.title = `record current time on pad ${key}`;
  record.disabled = true;
  record.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle></svg>';
  record.addEventListener("click", () => recordPad(key));
  const scrubber = document.createElement("button");
  scrubber.type = "button";
  scrubber.className = "scrubber-toggle";
  scrubber.setAttribute("aria-label", `scrub time for pad ${key}`);
  scrubber.title = `hold and drag left/right to adjust time for pad ${key}`;
  scrubber.disabled = true;
  scrubber.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4"></path></svg>';
  scrubber.addEventListener("pointerdown", (event) => startScrubbing(event, key));
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "undo-toggle";
  undo.setAttribute("aria-label", `reset pad ${key} to default`);
  undo.title = `reset pad ${key} to default`;
  undo.disabled = true;
  undo.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18 A6 6 0 0 0 12 6 L12 3 L9 6 L12 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
  undo.addEventListener("click", () => undoPad(key));
  pad.append(button, prohibited, record, scrubber, undo);
  pads.append(pad);
  padButtons.set(key, button);
  padContainers.set(key, pad);
  prohibitedButtons.set(key, prohibited);
  recordButtons.set(key, record);
  scrubberButtons.set(key, scrubber);
  undoButtons.set(key, undo);
}

function flash(button) {
  button.classList.add("flash");
  clearTimeout(flashTimers.get(button));
  flashTimers.set(button, setTimeout(() => button.classList.remove("flash"), 150));
}

function formatTimecode(time) {
  const totalMilliseconds = Math.round(time * 1000);
  const hours = Math.floor(totalMilliseconds / 3600000);
  const minutes = Math.floor(totalMilliseconds / 60000) % 60;
  const seconds = Math.floor(totalMilliseconds / 1000) % 60;
  const milliseconds = totalMilliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function compactTimecode(time) {
  const totalSeconds = Math.floor(time);
  const centiseconds = Math.round((time - totalSeconds) * 100);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  const timecode = hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${timecode}.${String(centiseconds).padStart(2, "0")}`;
}

function defaultPadTime(key) {
  return defaultPadTimes[key] ?? null;
}

function calculateDefaultPadTimes(duration) {
  if (!Number.isFinite(duration) || duration < 0) return {};
  return Object.fromEntries([..."1234567890"].map(key =>
    [key, duration * Number(key) / 10]
  ));
}

function updatePadLabels() {
  for (const [key, button] of padButtons) {
    const pad = padContainers.get(key);
    const recorded = Object.prototype.hasOwnProperty.call(recordedPadTimes, key);
    const timecode = recorded ? recordedPadTimes[key] : defaultPadTime(key);
    if (timecode === null) {
      button.textContent = key;
      delete button.dataset.timecode;
      button.title = "timecode unavailable until the video loads";
      button.setAttribute("aria-label", `${padMode.checked ? "play" : "record current time on"} pad ${key}`);
    } else {
      const exact = formatTimecode(timecode);
      // Show recorded timecode instead of pad number, or default pad time
      if (recorded) {
        button.textContent = compactTimecode(timecode);
      } else {
        button.textContent = key;
      }
      button.dataset.timecode = compactTimecode(timecode);
      button.title = `pad ${key}: ${exact}`;
      button.setAttribute("aria-label", padMode.checked
        ? `play pad ${key} at ${exact}`
        : `record current time on pad ${key}`);
    }
    pad.classList.toggle("pad-recorded", recorded);
  }
}

padMode.addEventListener("change", () => {
  padMode.setAttribute("aria-label", `pad mode: ${padMode.checked ? "play" : "rec"}`);
  for (const button of recordButtons.values()) button.hidden = !padMode.checked;
  updatePadLabels();
  if (!status.classList.contains("error")) showGuidance();
});

function normalizeRecordedPadTimes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, timecode]) =>
    /^[0-9]$/.test(key) && Number.isFinite(timecode) && timecode >= 0
  ));
}

function normalizeRecordedPadTimesByVideo(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([id, times]) =>
    [id, normalizeRecordedPadTimes(times)]
  ));
}

function setConnected(value) {
  connectBox.checked = value;
  link.classList.toggle("connected", value);
}

connectBox.addEventListener("change", () => {
  link.classList.toggle("connected", connectBox.checked);
  const randomize = connectBox.checked;
  enqueue(async () => {
    try {
      await saveVoice({ randomize });
      if (playing && tabId !== null) await send("update", { randomize });
    } catch (error) {
      showStatus(error.message || "could not update the sequence.", true);
    }
  });
});

includeEmptyStepsInput.addEventListener("change", () => {
  includeEmptySteps = includeEmptyStepsInput.checked;
  enqueue(async () => {
    try {
      await saveVoice({ includeEmptySteps });
      if (playing && tabId !== null) await send("update", { includeEmptySteps });
    } catch (error) {
      showStatus(error.message || "could not update randomization settings.", true);
    }
  });
});

function recordPad(key) {
  if (!videoId || recordButtons.get(key)?.disabled) return;
  enqueue(async () => {
    try {
      const result = await send("record", { key });
      recordedPadTimes[key] = result.timecode;
      recordedPadTimesByVideo[videoId] = { ...recordedPadTimes };
      updatePadLabels();
      const updates = [
        saveVoice({ recordedPadTimesByVideo })
      ];
      if (playing && tabId !== null) {
        updates.push(send("update", { recordedPadTimes: { ...recordedPadTimes } }));
      }
      const results = await Promise.allSettled(updates);
      const failure = results.find(item => item.status === "rejected");
      if (failure) throw failure.reason;
    } catch (error) {
      showStatus(error.message || "could not record the video time.", true);
    }
  });
}

function undoPad(key) {
  if (!videoId || undoButtons.get(key)?.disabled) return;
  enqueue(async () => {
    try {
      delete recordedPadTimes[key];
      recordedPadTimesByVideo[videoId] = { ...recordedPadTimes };
      updatePadLabels();
      await saveVoice({ recordedPadTimesByVideo });
      if (playing && tabId !== null) {
        await send("update", { recordedPadTimes: { ...recordedPadTimes } });
      }
    } catch (error) {
      showStatus(error.message || "could not reset the pad.", true);
    }
  });
}

function startScrubbing(event, key) {
  if (!videoId || scrubberButtons.get(key)?.disabled) return;
  const timecode = recordedPadTimes[key] ?? defaultPadTime(key);
  if (timecode === null) return;
  
  activeScrubber = { key, timecode };
  scrubStartX = event.clientX;
  scrubStartTime = timecode;
  
  scrubberButtons.get(key)?.classList.add("scrubbing");
  
  document.addEventListener("pointermove", handleScrubbing, { passive: true });
  document.addEventListener("pointerup", stopScrubbing);
  event.preventDefault();
}

function handleScrubbing(event) {
  if (!activeScrubber) return;
  
  const now = performance.now();
  if (now - lastScrubTime < SCRUB_THROTTLE) return;
  lastScrubTime = now;
  
  const deltaX = event.clientX - scrubStartX;
  // Micro-adjustments: each pixel = SCRUB_SENSITIVITY milliseconds
  const deltaMs = deltaX * SCRUB_SENSITIVITY;
  const newTimecode = Math.max(0, scrubStartTime + (deltaMs / 1000));
  
  activeScrubber.timecode = newTimecode;
  
  // Update pad label in real-time while scrubbing
  const button = padButtons.get(activeScrubber.key);
  if (button) {
    button.textContent = compactTimecode(newTimecode);
    button.dataset.timecode = compactTimecode(newTimecode);
  }
  
  if (tabId) {
    send("scrub", { key: activeScrubber.key, timecode: newTimecode }).catch(error => {
      console.warn("Could not scrub timecode:", error.message);
    });
  }
}

function stopScrubbing() {
  if (!activeScrubber) return;
  
  const { key, timecode } = activeScrubber;
  scrubberButtons.get(key)?.classList.remove("scrubbing");
  
  document.removeEventListener("pointermove", handleScrubbing);
  document.removeEventListener("pointerup", stopScrubbing);
  
  enqueue(async () => {
    try {
      recordedPadTimes[key] = timecode;
      recordedPadTimesByVideo[videoId] = { ...recordedPadTimes };
      updatePadLabels();
      await saveVoice({ recordedPadTimesByVideo });
      if (playing) {
        await send("update", { recordedPadTimes: { ...recordedPadTimes } });
      }
    } catch (error) {
      console.warn("Could not save scrubbed timecode:", error.message);
    }
  });
  
  activeScrubber = null;
}

function updatePadIndicator(value) {
  for (const [key, button] of padButtons) {
    button.classList.toggle("current", key === value);
  }
}

function updateProhibitedPadControls() {
  for (const [key, button] of prohibitedButtons) {
    const prohibited = prohibitedPads.has(key);
    button.setAttribute("aria-pressed", String(prohibited));
    button.setAttribute("aria-label", `${prohibited ? "allow" : "forbid"} pad ${key}`);
    button.title = `${prohibited ? "allow" : "forbid"} pad ${key}`;
    button.parentElement.classList.toggle("pad-prohibited", prohibited);
  }
}

function toggleProhibitedPad(key) {
  if (prohibitedPads.has(key)) prohibitedPads.delete(key);
  else prohibitedPads.add(key);
  updateProhibitedPadControls();
  const value = [...prohibitedPads];
  enqueue(async () => {
    try {
      const updates = [saveVoice({ prohibitedPads: value })];
      if (tabId !== null) updates.push(send("prohibited", { prohibitedPads: value }));
      const results = await Promise.allSettled(updates);
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
    } catch (error) {
      showStatus(error.message || "could not update forbidden pads.", true);
    }
  });
}

async function triggerPad(key) {
  const button = padButtons.get(key);
  if (!button || button.disabled) return;
  if (!padMode.checked) {
    recordPad(key);
    return;
  }
  if (selectedStep !== null && !lockedSteps.has(selectedStep)) {
    const input = inputs[selectedStep];
    input.value = key;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const stepHasFocus = inputs.includes(document.activeElement);
    advanceStep();
    if (stepHasFocus) inputs[selectedStep].focus();
    else inputs[selectedStep].scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  if (prohibitedPads.has(key)) return;
  button.classList.add("active");
  clearTimeout(padTimers.get(key));
  padTimers.set(key, setTimeout(() => {
    button.classList.remove("active");
    padTimers.delete(key);
  }, 150));
  try {
    const timecode = recordedPadTimes[key];
    await send("trigger", {
      key,
      ...(timecode !== undefined && { timecode })
    });
  } catch (error) {
    showStatus(error.message || "could not play the pad.", true);
  }
}

document.addEventListener("keydown", event => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (event.key === " " && !event.target?.closest?.(
    'button, input, select, textarea, a[href], [contenteditable]:not([contenteditable="false"])'
  )) {
    event.preventDefault();
    if (!event.repeat) toggleVideoPlayback();
    return;
  }
  if ((event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      tabId !== null && event.target !== bpmInput && !inputs.includes(event.target) &&
      !optionsMenu.contains(event.target) && event.target !== optionsToggle &&
      event.target !== padMode) {
    event.preventDefault();
    send("seek", { direction: event.key === "ArrowLeft" ? "backward" : "forward" })
      .catch(error => showStatus(error.message || "could not seek the video.", true));
    return;
  }
  if (event.repeat) return;
  if (event.key === "Escape" && !optionsMenu.hidden) {
    event.preventDefault();
    setOptionsOpen(false);
    optionsToggle.focus();
    return;
  }
  if (optionsMenu.contains(event.target) || event.target === optionsToggle) return;
  if (event.key === "Enter" && selectedStep !== null &&
      event.target !== bpmInput && event.target !== nextStepButton &&
      event.target !== randomizeButton &&
      event.target !== addStepButton &&
      event.target !== removeStepButton &&
      event.target !== clearButton &&
      event.target !== resetButton &&
      event.target !== padMode &&
      event.target !== videoPlayback &&
      event.target !== transport &&
      event.target !== bpmDecrease && event.target !== bpmIncrease) {
    if (lockButtons.includes(event.target)) return;
    event.preventDefault();
    advanceStep();
  } else if (event.key === "Escape" && selectedStep !== null) {
    event.preventDefault();
    if (inputs.includes(document.activeElement)) document.activeElement.blur();
    selectStep(null);
  } else if (/^[0-9]$/.test(event.key) && event.target !== bpmInput) {
    event.preventDefault();
    triggerPad(event.key);
  }
});

document.addEventListener("pointerdown", event => {
  if (selectedStep === null) return;
  if (steps.contains(event.target) || pads.contains(event.target) || padModeControl.contains(event.target) ||
      nextStepButton.contains(event.target)) return;
  selectStep(null);
});

function dropTarget(event) {
  const label = event.target.closest?.(".step");
  return label && !lockedSteps.has([...steps.children].indexOf(label)) &&
    event.dataTransfer.types.includes("application/x-yt-pad") ? label : null;
}

steps.addEventListener("dragover", event => {
  const label = dropTarget(event);
  if (!label) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  label.classList.add("drop-target");
});

steps.addEventListener("dragleave", event => {
  event.target.closest?.(".step")?.classList.remove("drop-target");
});

steps.addEventListener("drop", event => {
  const label = dropTarget(event);
  if (!label) return;
  event.preventDefault();
  label.classList.remove("drop-target");
  const key = event.dataTransfer.getData("application/x-yt-pad");
  const input = label.querySelector("input");
  if (!validStep(key) || !input) return;
  input.value = key;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  selectStep(inputs.indexOf(input));
});

function selectStep(index) {
  selectedStep = index;
  for (const [step, label] of [...steps.children].entries()) {
    label.classList.toggle("selected", step === index);
    if (step === index) inputs[step].setAttribute("aria-current", "step");
    else inputs[step].removeAttribute("aria-current");
  }
  if (!status.classList.contains("error")) showGuidance();
}

function advanceStep() {
  const completed = selectedStep === inputs.length - 1;
  selectStep(selectedStep === null ? 0 : (selectedStep + 1) % inputs.length);
  if (connectBox.checked) {
    setConnected(false);
  }
  if (completed && !playing && !transportPending && tabId !== null) {
    form.requestSubmit();
  }
}

nextStepButton.addEventListener("click", advanceStep);

function validStep(value) {
  return typeof value === "string" && /^[0-9]?$/.test(value);
}

function randomSequence() {
  const choices = [..."0123456789"].filter(key => !prohibitedPads.has(key));
  if (includeEmptySteps) choices.push("");
  if (choices.length === 0 && inputs.some((_, index) => !lockedSteps.has(index))) return null;
  return inputs.map((input, index) =>
    lockedSteps.has(index) ? input.value : choices[Math.floor(Math.random() * choices.length)]
  );
}

function replaceSequence(sequence) {
  setSequence(sequence);
  enqueue(async () => {
    try {
      let state;
      if (playing && tabId !== null) {
        state = await send("update", { sequence });
        await saveVoice({ sequence: state.sequence });
      } else {
        await saveVoice({ sequence });
      }
      if (state) updateState(state);
      else if (!playing) showGuidance();
      status.classList.remove("error");
    } catch (error) {
      showStatus(error.message || "could not update the sequence.", true);
    }
  });
}

function resizeWindow(keepLeft = false, shrink = false, restoreSize = false) {
  enqueue(async () => {
    try {
      await fitWindow(keepLeft, shrink, restoreSize);
      if (restoreSize) await fitWindow();
    } catch (error) {
      console.error("Could not resize the sequencer window:", error);
      showStatus(error.message || "could not resize the sequencer window.", true);
    }
  });
}

function resizeForSteps(shrink = false) {
  resizeWindow(true, shrink);
}

addStepButton.addEventListener("click", () => {
  const sequence = inputs.map(input => input.value);
  if (!sequence.every(validStep)) {
    showGuidance();
    return;
  }
  enqueue(async () => {
    try {
      await chorusCommand("length", { length: chorusSession.length + 1 });
    } catch (error) {
      showStatus(error.message || "could not add a step.", true);
    }
  });
});
removeStepButton.addEventListener("click", () => {
  if (inputs.length === 1) return;
  if (lockedSteps.has(inputs.length - 1)) {
    showStatus("unlock the last step before removing it.", true);
    return;
  }
  const sequence = inputs.slice(0, -1).map(input => input.value);
  if (!sequence.every(validStep)) {
    showGuidance();
    return;
  }
  enqueue(async () => {
    try {
      await chorusCommand("length", { length: chorusSession.length - 1 });
    } catch (error) {
      showStatus(error.message || "could not remove the step.", true);
    }
  });
});

randomizeButton.addEventListener("click", () => {
  flash(randomizeButton);
  const sequence = randomSequence();
  if (!sequence) {
    showStatus("cannot randomize: all pads are forbidden and empty steps are excluded.", true);
    return;
  }
  replaceSequence(sequence);
});
clearButton.addEventListener("click", () =>
  replaceSequence(inputs.map((input, index) => lockedSteps.has(index) ? input.value : ""))
);
resetButton.addEventListener("click", () => {
  enqueue(async () => {
    try {
      await chorusCommand("reset");
      status.classList.remove("error");
      showGuidance();
    } catch (error) {
      showStatus(error.message || "could not reset the voices.", true);
    }
  });
});

function showStatus(text, error = false) {
  status.textContent = text.toLowerCase();
  status.classList.toggle("error", error);
}

function showGuidance() {
  if (inputs.some(input => !validStep(input.value))) {
    showStatus("steps must be empty or a digit from 0 to 9.", true);
  } else if (!validBpmInput()) {
    showStatus("enter a whole-number bpm from 1 to 999.", true);
  } else if (tabId === null && chorusReady) {
    showStatus("choose a video with +.");
  } else if (!padMode.checked) {
    showStatus("rec mode. press a pad to save the current video time.");
  } else if (selectedStep !== null && lockedSteps.has(selectedStep)) {
    showStatus("step locked. unlock to edit.");
  } else if (selectedStep !== null) {
    showStatus("press pad to save step.");
  } else {
    showStatus(playing ? "playing. edit steps or bpm live." : "press play to start.");
  }
}

function updateState(state, hydrate = false) {
  localEnginePlaying = state.playing;
  playing = chorusSession ? chorusSession.playing : state.playing;
  if ("videoPaused" in state) updateVideoPlayback(state.videoPaused);
  if (Array.isArray(state.lockedSteps)) setLockedSteps(state.lockedSteps);
  settings.disabled = false;
  bpmInput.disabled = false;
  bpmDecrease.disabled = false;
  bpmIncrease.disabled = false;
  tapTempoButton.disabled = false;
  metronomeInput.disabled = false;
  connectBox.disabled = false;
  padMode.disabled = false;
  for (const button of padButtons.values()) button.disabled = false;
  for (const button of prohibitedButtons.values()) button.disabled = false;
  for (const button of recordButtons.values()) button.disabled = false;
  for (const button of scrubberButtons.values()) button.disabled = false;
  for (const button of undoButtons.values()) button.disabled = false;
  optionsToggle.disabled = false;
  includeEmptyStepsInput.disabled = false;
  if (playing && hydrate && Array.isArray(state.sequence)) setSequence(state.sequence);
  if (typeof state.videoId === "string" && state.videoId && state.videoId !== videoId) {
    videoId = state.videoId;
    recordedPadTimes = { ...(recordedPadTimesByVideo[videoId] || {}) };
    videoDuration = null;
    defaultPadTimes = {};
  }
  if (typeof state.videoDuration === "number" && Number.isFinite(state.videoDuration)) {
    videoDuration = state.videoDuration;
    defaultPadTimes = calculateDefaultPadTimes(videoDuration);
  } else if (state.videoDuration === null) {
    videoDuration = null;
    defaultPadTimes = {};
  }
  updatePadLabels();
  if (playing && typeof state.includeEmptySteps === "boolean") {
    includeEmptySteps = state.includeEmptySteps;
    includeEmptyStepsInput.checked = includeEmptySteps;
  }
  if (Array.isArray(state.prohibitedPads)) {
    prohibitedPads = new Set(state.prohibitedPads);
    updateProhibitedPadControls();
  }
  if (typeof state.metronomeEnabled === "boolean" && !chorusSession) {
    metronomeInput.checked = state.metronomeEnabled;
  }
  transport.disabled = transportPending;
  transport.classList.toggle("playing", playing);
  transport.setAttribute("aria-label", playing ? "stop" : "play");
  transport.title = playing ? "stop" : "play";
  if (!playing) {
    for (const label of steps.children) label.classList.remove("active");
    updatePadIndicator(null);
    timing.hidden = true;
  } else {
    updateStepIndicator(state);
  }
  if (playing && hydrate) {
    bpmInput.value = String(chorusSession?.bpm ?? state.bpm);
    setConnected(state.randomizeOnStart === true);
  }
  markBpmValidity();
  if (state.playbackError) {
    showStatus(state.playbackError, true);
  }
  else if (!status.classList.contains("error") || hydrate) showGuidance();
}

function updateVideoPlayback(paused) {
  videoAvailable = typeof paused === "boolean";
  videoPlayback.disabled = videoPlaybackPending || !videoAvailable;
  if (!videoAvailable) return;
  videoPlayback.classList.toggle("playing", !paused);
  const label = paused ? "play video" : "pause video";
  videoPlayback.setAttribute("aria-label", label);
  videoPlayback.title = label;
}

function updateStepIndicator(state) {
  if (!Number.isInteger(state.stepSerial) || state.stepSerial < lastStepSerial) return;
  if ("padValue" in state) updatePadIndicator(state.padValue);
  lastStepSerial = state.stepSerial;
  if (state.randomized && Array.isArray(state.sequence) && state.sequence.length === inputs.length) {
    inputs.forEach((input, index) => { input.value = state.sequence[index]; });
    enqueue(async () => {
      try {
        await saveVoice({ sequence: state.sequence });
      } catch (error) {
        showStatus(error.message || "could not save the randomized sequence.", true);
      }
    });
    flash(randomizeButton);
  }
  for (const [index, label] of [...steps.children].entries()) {
    label.classList.toggle("active", index === state.currentStep);
  }
  const delays = state.timingDelays;
  timing.hidden = !delays;
  timing.textContent = delays ? `delayed beats: ${delays}.` : "";
}

function setUnavailable(message) {
  settings.disabled = !chorusReady;
  bpmInput.disabled = !chorusReady;
  bpmDecrease.disabled = !chorusReady;
  bpmIncrease.disabled = !chorusReady;
  tapTempoButton.disabled = !chorusReady;
  metronomeInput.disabled = !chorusReady;
  padMode.disabled = true;
  for (const button of padButtons.values()) {
    button.disabled = true;
    button.classList.remove("current");
  }
  for (const button of prohibitedButtons.values()) button.disabled = true;
  for (const button of recordButtons.values()) button.disabled = true;
  for (const button of scrubberButtons.values()) button.disabled = true;
  for (const button of undoButtons.values()) button.disabled = true;
  optionsToggle.disabled = !chorusReady;
  includeEmptyStepsInput.disabled = !chorusReady;
  transport.disabled = !chorusReady;
  videoPlayback.disabled = true;
  showStatus(message, true);
}

async function send(type, data = {}) {
  const response = await chrome.tabs.sendMessage(tabId, { type: prefix + type, ...data });
  if (!response || !response.ok) {
    throw new Error(response?.error || "could not connect to the player.");
  }
  return response;
}

function validBpmInput() {
  const bpm = Number(bpmInput.value);
  const isValidFormat = /^[0-9]+$/.test(bpmInput.value);
  return isValidFormat && bpm >= 1 && bpm <= 999;
}

function markBpmValidity() {
  const valid = validBpmInput();
  bpmInput.setAttribute("aria-invalid", String(!valid));
  return valid;
}

async function refresh(hydrate = false) {
  if (tabId === null || polling || commandPending) return;
  polling = true;
  const version = commandVersion;
  try {
    const state = await send("status");
    if (!commandPending && version === commandVersion) {
      if (state.videoId !== videoId) {
        await chorusCommand("unassign");
        return;
      }
      updateState(state, hydrate);
    }
  } catch (error) {
    if (!commandPending && version === commandVersion) {
      await chorusCommand("unassign");
      showStatus(error.message || "could not connect to the video. choose another with +.", true);
    }
  } finally {
    polling = false;
  }
}

function enqueue(command) {
  commandVersion++;
  commandQueue = commandQueue.then(async () => {
    commandPending = true;
    try {
      await command();
    } finally {
      commandPending = false;
    }
  }).catch(error => {
    console.error("Could not run sequencer command:", error);
    showStatus(error.message || "could not run the sequencer command.", true);
  });
  return commandQueue;
}

function toggleVideoPlayback() {
  if (videoPlayback.disabled || tabId === null) return;
  videoPlaybackPending = true;
  videoPlayback.disabled = true;
  enqueue(async () => {
    try {
      const state = await send("video-toggle");
      status.classList.remove("error");
      updateState(state);
    } catch (error) {
      showStatus(error.message || "could not change video playback.", true);
    } finally {
      videoPlaybackPending = false;
      if (tabId !== null) videoPlayback.disabled = !videoAvailable;
    }
  });
}

videoPlayback.addEventListener("click", toggleVideoPlayback);

function updateLive(data) {
  enqueue(async () => {
    if (!playing) return;
    try {
      const state = await send("update", data);
      await saveVoice({ sequence: state.sequence });
      status.classList.remove("error");
      updateState(state);
    } catch (error) {
      showStatus(error.message || "could not update the sequence.", true);
    }
  });
}

async function fitWindow(keepLeft = false, shrink = false, restoreSize = false) {
  const [popup, displays] = await Promise.all([
    chrome.windows.getCurrent(),
    chrome.system.display.getInfo()
  ]);
  if (!Number.isInteger(popup.id) ||
      ![popup.left, popup.top, popup.width, popup.height].every(Number.isFinite)) {
    throw new Error("could not determine the sequencer window size.");
  }
  const centerX = popup.left + popup.width / 2;
  const centerY = popup.top + popup.height / 2;
  const display = displays.find(({ bounds }) =>
    centerX >= bounds.left && centerX < bounds.left + bounds.width &&
    centerY >= bounds.top && centerY < bounds.top + bounds.height
  ) || displays.find(item => item.isPrimary);
  if (!display) throw new Error("could not determine the display.");
  const area = display.workArea;
  const stepOverflow = Math.max(0, steps.scrollWidth - steps.clientWidth);
  const heightOverflow = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const maxWidth = keepLeft ? Math.max(popup.width, area.left + area.width - popup.left) : area.width;
  const unusedWidth = shrink
    ? removeStepButton.parentElement.getBoundingClientRect().right -
      removeStepButton.getBoundingClientRect().right
    : 0;
  const minWidth = Math.min(popup.width, popup.width - window.innerWidth + 412);
  const width = restoreSize
    ? Math.min(412, area.width)
    : shrink
      ? Math.max(minWidth, Math.ceil(popup.width - unusedWidth))
      : Math.min(maxWidth, popup.width + stepOverflow + (stepOverflow > 0 ? 1 : 0));
  const height = restoreSize
    ? Math.min(460, area.height)
    : keepLeft ? popup.height : Math.min(area.height, popup.height + heightOverflow);
  if (width === popup.width && height === popup.height) return;
  const left = keepLeft ? popup.left : Math.max(area.left, Math.min(
    Math.round(centerX - width / 2), area.left + area.width - width
  ));
  const top = keepLeft ? popup.top : Math.max(area.top, Math.min(
    Math.round(centerY - height / 2), area.top + area.height - height
  ));
  await chrome.windows.update(popup.id, { width, height, left, top });
}

function applyBpm() {
  if (bpmTimer === null) return;
  clearTimeout(bpmTimer);
  bpmTimer = null;
  if (validBpmInput()) setChorusBpm(Number(bpmInput.value));
}

function setChorusBpm(bpm) {
  enqueue(async () => {
    try {
      await chorusCommand("bpm", { bpm });
    } catch (error) {
      showStatus(error.message || "could not change the bpm.", true);
    }
  });
}

bpmInput.addEventListener("input", () => {
  clearTimeout(bpmTimer);
  bpmTimer = null;
  if (!markBpmValidity()) {
    showGuidance();
    return;
  }
  showGuidance();
  bpmTimer = setTimeout(applyBpm, 300);
});
bpmInput.addEventListener("change", applyBpm);

form.addEventListener("keydown", event => {
  if (event.key === "Enter" && event.target === bpmInput) {
    event.preventDefault();
    applyBpm();
    bpmInput.blur();
  }
});

bpmInput.addEventListener("wheel", event => {
  event.preventDefault();
  const delta = event.deltaY > 0 ? -1 : 1;
  adjustBpm(delta);
}, { passive: false });

function adjustBpm(amount) {
  if (!markBpmValidity()) {
    showGuidance();
    return;
  }
  let bpm = Number(bpmInput.value) + amount;
  bpm = Math.max(1, Math.min(999, bpm));
  if (bpm === Number(bpmInput.value)) return;
  clearTimeout(bpmTimer);
  bpmTimer = null;
  bpmInput.value = String(bpm);
  setChorusBpm(bpm);
}

function handleTapTempo() {
  const now = Date.now();
  tapTempoTimes.push(now);
  
  tapTempoTimes = tapTempoTimes.filter(time => now - time < TAP_TEMPO_THRESHOLD);
  
  if (tapTempoTimes.length < 2) return;
  
  let totalInterval = 0;
  for (let i = 1; i < tapTempoTimes.length; i++) {
    totalInterval += tapTempoTimes[i] - tapTempoTimes[i - 1];
  }
  const avgInterval = totalInterval / (tapTempoTimes.length - 1);
  const bpm = Math.round(60000 / avgInterval);
  
  if (bpm >= 1 && bpm <= 999) {
    clearTimeout(bpmTimer);
    bpmTimer = null;
    bpmInput.value = String(bpm);
    markBpmValidity();
    status.classList.remove("error");
    showGuidance();
    setChorusBpm(bpm);
  }
}

bpmDecrease.addEventListener("click", () => adjustBpm(-1));
bpmIncrease.addEventListener("click", () => adjustBpm(1));
tapTempoButton.addEventListener("click", handleTapTempo);
metronomeInput.addEventListener("change", () => {
  const enabled = metronomeInput.checked;
  metronomeInput.disabled = true;
  enqueue(async () => {
    try {
      await chorusCommand("metronome", { enabled });
    } catch (error) {
      metronomeInput.checked = !enabled;
      showStatus(error.message || "could not change the metronome.", true);
    } finally {
      metronomeInput.disabled = false;
    }
  });
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (transportPending) return;
  const sequence = inputs.map(input => input.value);
  const bpm = Number(bpmInput.value);
  const validSteps = sequence.every(validStep);
  const validBpm = markBpmValidity();
  if (!playing && (!validSteps || !validBpm)) {
    showGuidance();
    if (!validBpm) bpmInput.focus();
    return;
  }
  transportPending = true;
  transport.disabled = true;
  if (bpmTimer !== null) applyBpm();
  const start = !playing;
  await enqueue(async () => {
    try {
      if (start) {
        await saveVoice({ sequence, randomize: connectBox.checked, prohibitedPads: [...prohibitedPads],
          includeEmptySteps, recordedPadTimesByVideo, lockedSteps: [...lockedSteps] });
        await chorusCommand("bpm", { bpm });
      }
      await chorusCommand("transport", { playing: start });
      status.classList.remove("error");
    } catch (error) {
      showStatus(error.message || "could not change playback.", true);
    } finally {
      transportPending = false;
      transport.disabled = false;
    }
  });
});

async function initialize() {
  setUnavailable("connecting to youtube...");
  try {
    const currentWindow = await chrome.windows.getCurrent();
    if (!Number.isInteger(currentWindow.id)) throw new Error("could not identify the sequencer window.");
    chorusWindowId = currentWindow.id;
    connectChorus();
    const target = new URLSearchParams(location.search).get("tabId");
    let tab = null;
    if (target && /^\d+$/.test(target) && Number.isSafeInteger(Number(target))) {
      try {
        tab = await chrome.tabs.get(Number(target));
      } catch (error) {
        console.warn("The video tab is unavailable:", error);
      }
    }
    const url = tab?.url ? new URL(tab.url) : null;
    if (tab && url?.protocol === "https:" &&
        ["youtube.com", "www.youtube.com"].includes(url.hostname) &&
        url.pathname === "/watch" && url.searchParams.get("v")) {
      tabId = tab.id;
      videoId = url.searchParams.get("v");
    }
    const session = await chorusCommand("register", { tabId, videoId });
    chorusSession = session;
    const saved = session.voices[String(chorusWindowId)];
    setConnected(saved.randomize === true);
    includeEmptySteps = saved.includeEmptySteps !== false;
    includeEmptyStepsInput.checked = includeEmptySteps;
    prohibitedPads = new Set(Array.isArray(saved.prohibitedPads)
      ? saved.prohibitedPads.filter(key => typeof key === "string" && /^[0-9]$/.test(key))
      : []);
    recordedPadTimesByVideo = normalizeRecordedPadTimesByVideo(session.recordedPadTimesByVideo);
    updateProhibitedPadControls();
    if (Array.isArray(saved.sequence) && saved.sequence.length > 0 &&
        saved.sequence.every(validStep)) {
      setSequence(saved.sequence);
    }
    if (Array.isArray(saved.lockedSteps)) {
      setLockedSteps(saved.lockedSteps.filter(index =>
        Number.isSafeInteger(index) && index >= 0
      ));
    }
    bpmInput.value = String(session.bpm);
    chorusReady = true;
    if (tabId === null) {
      setUnavailable("choose a video with +.");
      applyChorus(chorusSession);
      return;
    }
    recordedPadTimes = { ...(recordedPadTimesByVideo[videoId] || {}) };
    updatePadLabels();
    videoTitle.textContent = (tab.title || "").replace(/^\(\d+\)\s*/, "").replace(/ - youtube$/i, "").toLowerCase();
    videoTitle.title = videoTitle.textContent;
    await send("prohibited", { prohibitedPads: [...prohibitedPads] });
    const initialState = await send("status");
    if (initialState.videoId !== videoId) throw new Error("the selected video changed. choose a video with +.");
    if (initialState.playing) await send("stop");
    if (initialState.metronomeEnabled) await send("metronome", { enabled: false });
    await send("locks", { lockedSteps: [...lockedSteps] });
    const port = chrome.tabs.connect(tabId, { name: `${prefix}steps` });
    port.onMessage.addListener(message => {
      if (tabId === null) return;
      if ("videoPaused" in message) updateVideoPlayback(message.videoPaused);
      if (Array.isArray(message.lockedSteps)) setLockedSteps(message.lockedSteps);
      if (message.metronomeError) {
        chorusCommand("metronome", { enabled: false }).catch(error =>
          showStatus(error.message || "could not update the metronome.", true));
        if (typeof message.playing === "boolean") updateState(message);
        else metronomeInput.checked = false;
        showStatus(message.metronomeError, true);
        return;
      }
      if (transportPending) return;
      if (message.playbackError) updateState(message);
      else if (playing) updateStepIndicator(message);
    });
    port.onDisconnect.addListener(() => {
      if (tabId !== null) {
        chorusCommand("unassign").catch(error =>
          showStatus(error.message || "could not disconnect the video.", true));
      }
    });
    await refresh(true);
    applyChorus(chorusSession);
    setInterval(() => {
      refresh();
    }, 1000);
  } catch (error) {
    if (chorusReady && tabId !== null) {
      try {
        await chorusCommand("unassign");
      } catch (disconnectError) {
        console.error("Could not disconnect the video:", disconnectError);
      }
    }
    setUnavailable(error.message || "could not start the extension. try reopening it.");
  } finally {
    try {
      await fitWindow();
    } catch (error) {
      console.error("Could not resize the sequencer window:", error);
      if (!status.classList.contains("error")) {
        showStatus(error.message || "could not resize the sequencer window.", true);
      }
    }
  }
}

initialize();
