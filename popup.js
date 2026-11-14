const prefix = "yt-step-sequencer:";
const form = document.querySelector("#sequencer");
const settings = document.querySelector("#settings");
const steps = document.querySelector("#steps");
const addStepButton = document.querySelector("#add-step");
const removeStepButton = document.querySelector("#remove-step");
const randomizeButton = document.querySelector("#randomize");
const randomizePadsButton = document.querySelector("#randomize-pads");
const includeEmptyStepsInput = document.querySelector("#include-empty-steps");
const clearButton = document.querySelector("#clear");
const resetButton = document.querySelector("#reset");
const nextStepButton = document.querySelector("#next-step");
const bpmInput = document.querySelector("#bpm");
const bpmDecrease = document.querySelector("#bpm-decrease");
const bpmIncrease = document.querySelector("#bpm-increase");
const transport = document.querySelector("#transport");
const status = document.querySelector("#status");
const timing = document.querySelector("#timing");
const pads = document.querySelector("#pads");
const connectBox = document.querySelector("#connect");
const randomizePadTimecodesInput = document.querySelector("#randomize-pad-timecodes");
const videoTitle = document.querySelector("#video-title");
const link = document.querySelector("#link");
const optionsToggle = document.querySelector("#options-toggle");
const optionsMenu = document.querySelector("#options-menu");
const flashTimers = new WeakMap();
let tabId = null;
let playing = false;
let polling = false;
let commandPending = false;
let commandVersion = 0;
let commandQueue = Promise.resolve();
let bpmTimer = null;
let transportPending = false;
let selectedStep = null;
let lastStepSerial = -1;
let lastPadTimesSerial = 0;
let prohibitedPads = new Set();
let includeEmptySteps = true;
let randomizePadTimecodes = false;
let videoId = null;
let videoDuration = null;
let defaultPadTimes = {};
let recordedPadTimes = {};
let recordedPadTimesByVideo = {};

function setOptionsOpen(open) {
  optionsMenu.hidden = !open;
  optionsToggle.setAttribute("aria-expanded", String(open));
}

optionsToggle.addEventListener("click", () => {
  setOptionsOpen(optionsMenu.hidden);
});

document.addEventListener("pointerdown", event => {
  if (!optionsMenu.hidden && !optionsMenu.contains(event.target) &&
      !optionsToggle.contains(event.target)) {
    setOptionsOpen(false);
  }
});

const inputs = [];

function appendStep(value) {
  const index = inputs.length;
  const label = document.createElement("label");
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
    if (validStep(input.value)) {
      if (playing) updateLive({ step: index, value: input.value });
      else {
        status.classList.remove("error");
        updateState({ playing: false, currentStep: -1 });
        const sequence = inputs.map(item => item.value);
        if (sequence.every(validStep)) {
          enqueue(async () => {
            try {
              await chrome.storage.local.set({ sequence });
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
  label.append(input);
  steps.append(label);
  inputs.push(input);
}

function setSequence(sequence) {
  while (inputs.length < sequence.length) appendStep("");
  while (inputs.length > sequence.length) {
    inputs.pop().parentElement.remove();
  }
  inputs.forEach((input, index) => { input.value = sequence[index]; });
  removeStepButton.disabled = inputs.length === 1;
  if (selectedStep !== null && selectedStep >= inputs.length) selectStep(null);
}

function defaultSequence() {
  return Array.from({ length: 8 }, (_, index) => String(index));
}

setSequence(defaultSequence());

const padButtons = new Map();
const prohibitedButtons = new Map();
const recordButtons = new Map();
const padTimers = new Map();

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
  pad.append(button, prohibited, record);
  pads.append(pad);
  padButtons.set(key, button);
  prohibitedButtons.set(key, prohibited);
  recordButtons.set(key, record);
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
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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

function randomPadTimecodes() {
  if (!Number.isFinite(videoDuration) || videoDuration < 0) return null;
  return Object.fromEntries([..."1234567890"].map(key =>
    [key, Math.random() * videoDuration]
  ));
}

function updatePadLabels() {
  for (const [key, button] of padButtons) {
    const recorded = Object.prototype.hasOwnProperty.call(recordedPadTimes, key);
    const timecode = recorded ? recordedPadTimes[key] : defaultPadTime(key);
    if (timecode === null) {
      button.textContent = key;
      button.title = "timecode unavailable until the video loads";
      button.setAttribute("aria-label", `play pad ${key}`);
    } else {
      const exact = formatTimecode(timecode);
      button.textContent = recorded ? compactTimecode(timecode) : key;
      button.title = `pad ${key}: ${exact}`;
      button.setAttribute("aria-label", `play pad ${key} at ${exact}`);
    }
    button.classList.toggle("pad-recorded", recorded);
  }
}

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
  chrome.storage.local.set({ randomize });
  if (playing) {
    enqueue(async () => {
      try {
        await send("update", { randomize });
      } catch (error) {
        showStatus(error.message || "could not update the sequence.", true);
      }
    });
  }
});

includeEmptyStepsInput.addEventListener("change", () => {
  includeEmptySteps = includeEmptyStepsInput.checked;
  enqueue(async () => {
    try {
      await chrome.storage.local.set({ includeEmptySteps });
      if (playing) await send("update", { includeEmptySteps });
    } catch (error) {
      showStatus(error.message || "could not update randomization settings.", true);
    }
  });
});

randomizePadTimecodesInput.addEventListener("change", () => {
  randomizePadTimecodes = randomizePadTimecodesInput.checked;
  const value = randomizePadTimecodes;
  enqueue(async () => {
    try {
      await chrome.storage.local.set({ randomizePadTimecodes: value });
      if (playing) await send("update", { randomizePadTimecodes: value });
    } catch (error) {
      showStatus(error.message || "could not save the pad timecode setting.", true);
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
        chrome.storage.local.set({ recordedPadTimesByVideo })
      ];
      if (playing) {
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
      const updates = [chrome.storage.local.set({ prohibitedPads: value })];
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
  if (selectedStep !== null) {
    const input = inputs[selectedStep];
    input.value = key;
    input.dispatchEvent(new Event("input", { bubbles: true }));
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
    await send("trigger", { key, ...(timecode !== undefined && { timecode }) });
  } catch (error) {
    showStatus(error.message || "could not play the pad.", true);
  }
}

document.addEventListener("keydown", event => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (event.key === "Escape" && !optionsMenu.hidden) {
    event.preventDefault();
    setOptionsOpen(false);
    optionsToggle.focus();
    return;
  }
  if (optionsMenu.contains(event.target) || event.target === optionsToggle ||
      event.target === randomizePadTimecodesInput) return;
  if (event.key === "Enter" && selectedStep !== null &&
      event.target !== bpmInput && event.target !== nextStepButton &&
      event.target !== randomizeButton &&
      event.target !== randomizePadsButton &&
      event.target !== addStepButton &&
      event.target !== removeStepButton &&
      event.target !== clearButton &&
      event.target !== resetButton &&
      event.target !== transport &&
      event.target !== bpmDecrease && event.target !== bpmIncrease) {
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
  if (steps.contains(event.target) || pads.contains(event.target) ||
      nextStepButton.contains(event.target)) return;
  selectStep(null);
});

function dropTarget(event) {
  const label = event.target.closest?.(".step");
  return label && event.dataTransfer.types.includes("application/x-yt-pad") ? label : null;
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
  if (choices.length === 0) return null;
  return inputs.map(() => choices[Math.floor(Math.random() * choices.length)]);
}

function replaceSequence(sequence, padTimes = null) {
  if (sequence) setSequence(sequence);
  if (padTimes) {
    recordedPadTimes = { ...padTimes };
    if (videoId) recordedPadTimesByVideo[videoId] = { ...recordedPadTimes };
    updatePadLabels();
  }
  enqueue(async () => {
    try {
      let state;
      if (playing) {
        if (sequence) {
          state = await send("update", { sequence });
          await chrome.storage.local.set({ sequence: state.sequence, bpm: state.bpm });
        }
        if (padTimes) {
          state = await send("update", { recordedPadTimes: { ...padTimes } });
          await chrome.storage.local.set({ recordedPadTimesByVideo });
        }
      } else {
        const saved = {};
        if (sequence) saved.sequence = sequence;
        if (padTimes) saved.recordedPadTimesByVideo = recordedPadTimesByVideo;
        if (Object.keys(saved).length) await chrome.storage.local.set(saved);
      }
      if (state) updateState(state);
      else if (!playing) showGuidance();
      status.classList.remove("error");
    } catch (error) {
      showStatus(error.message || "could not update the sequence.", true);
    }
  });
}

addStepButton.addEventListener("click", () => {
  const sequence = inputs.map(input => input.value);
  if (!sequence.every(validStep)) {
    showGuidance();
    return;
  }
  replaceSequence([...sequence, ""]);
  steps.scrollLeft = steps.scrollWidth;
});
removeStepButton.addEventListener("click", () => {
  if (inputs.length === 1) return;
  const sequence = inputs.slice(0, -1).map(input => input.value);
  if (!sequence.every(validStep)) {
    showGuidance();
    return;
  }
  replaceSequence(sequence);
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
randomizePadsButton.addEventListener("click", () => {
  flash(randomizePadsButton);
  const padTimes = randomPadTimecodes();
  if (!padTimes) {
    showStatus("cannot randomize pad timecodes until the video duration is available.", true);
    return;
  }
  replaceSequence(null, padTimes);
});
clearButton.addEventListener("click", () => replaceSequence(inputs.map(() => "")));
resetButton.addEventListener("click", () => {
  recordedPadTimes = {};
  if (videoId) delete recordedPadTimesByVideo[videoId];
  updatePadLabels();
  const resetTimes = {};
  const savedTimesByVideo = { ...recordedPadTimesByVideo };
  enqueue(async () => {
    try {
      const updates = [chrome.storage.local.set({ recordedPadTimesByVideo: savedTimesByVideo })];
      if (playing) updates.push(send("update", { recordedPadTimes: resetTimes }));
      const results = await Promise.allSettled(updates);
      const failure = results.find(item => item.status === "rejected");
      if (failure) throw failure.reason;
    } catch (error) {
      showStatus(error.message || "could not reset recorded pad times.", true);
    }
  });
  replaceSequence(defaultSequence());
});

function showStatus(text, error = false) {
  status.textContent = text.toLowerCase();
  status.classList.toggle("error", error);
}

function showGuidance() {
  if (inputs.some(input => !validStep(input.value))) {
    showStatus("steps must be empty or a digit from 0 to 9.", true);
  } else if (!validBpmInput()) {
    showStatus("enter a bpm from 1 to 999.", true);
  } else if (selectedStep !== null) {
    showStatus(`step ${selectedStep + 1}: play a pad, step or enter to advance, esc to exit.`);
  } else {
    showStatus(playing ? "playing. edit steps or bpm live." : "press play to start.");
  }
}

function updateState(state, hydrate = false) {
  playing = state.playing;
  settings.disabled = false;
  bpmInput.disabled = false;
  bpmDecrease.disabled = false;
  bpmIncrease.disabled = false;
  for (const button of padButtons.values()) button.disabled = false;
  for (const button of prohibitedButtons.values()) button.disabled = false;
  for (const button of recordButtons.values()) button.disabled = false;
  randomizePadsButton.disabled = false;
  optionsToggle.disabled = false;
  includeEmptyStepsInput.disabled = false;
  randomizePadTimecodesInput.disabled = false;
  if (playing && hydrate) setSequence(state.sequence);
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
  if (playing && hydrate && typeof state.randomizePadTimecodes === "boolean") {
    randomizePadTimecodes = state.randomizePadTimecodes;
    randomizePadTimecodesInput.checked = randomizePadTimecodes;
  }
  if (Array.isArray(state.prohibitedPads)) {
    prohibitedPads = new Set(state.prohibitedPads);
    updateProhibitedPadControls();
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
    bpmInput.value = String(state.bpm);
    setConnected(state.randomizeOnStart === true);
  }
  markBpmValidity();
  if (state.playbackError || (playing && state.padRandomizeError)) {
    showStatus(state.playbackError || state.padRandomizeError, true);
  }
  else if (!status.classList.contains("error") || hydrate) showGuidance();
}

function updateStepIndicator(state) {
  if (!Number.isInteger(state.stepSerial) || state.stepSerial < lastStepSerial) return;
  if (Number.isInteger(state.padTimesSerial) && state.padTimesSerial > lastPadTimesSerial &&
      state.videoId === videoId && state.recordedPadTimes) {
    lastPadTimesSerial = state.padTimesSerial;
    recordedPadTimes = normalizeRecordedPadTimes(state.recordedPadTimes);
    recordedPadTimesByVideo[videoId] = { ...recordedPadTimes };
    const savedTimesByVideo = { ...recordedPadTimesByVideo };
    updatePadLabels();
    flash(randomizePadsButton);
    enqueue(async () => {
      try {
        await chrome.storage.local.set({ recordedPadTimesByVideo: savedTimesByVideo });
      } catch (error) {
        showStatus(error.message || "could not save randomized pad times.", true);
      }
    });
  }
  if (state.padRandomizeError) showStatus(state.padRandomizeError, true);
  if ("padValue" in state) updatePadIndicator(state.padValue);
  lastStepSerial = state.stepSerial;
  if (state.randomized && Array.isArray(state.sequence) && state.sequence.length === inputs.length) {
    inputs.forEach((input, index) => { input.value = state.sequence[index]; });
    chrome.storage.local.set({ sequence: state.sequence });
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
  settings.disabled = true;
  bpmInput.disabled = true;
  bpmDecrease.disabled = true;
  bpmIncrease.disabled = true;
  for (const button of padButtons.values()) {
    button.disabled = true;
    button.classList.remove("current");
  }
  for (const button of prohibitedButtons.values()) button.disabled = true;
  for (const button of recordButtons.values()) button.disabled = true;
  randomizePadsButton.disabled = true;
  optionsToggle.disabled = true;
  includeEmptyStepsInput.disabled = true;
  randomizePadTimecodesInput.disabled = true;
  transport.disabled = true;
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
  return /^[0-9]+$/.test(bpmInput.value) && Number.isInteger(bpm) && bpm >= 1 && bpm <= 999;
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
    if (!commandPending && version === commandVersion) updateState(state, hydrate);
  } catch (error) {
    if (!commandPending && version === commandVersion) {
      tabId = null;
      setUnavailable(error.message || "could not connect. open or reload a youtube video.");
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
  });
  return commandQueue;
}

function updateLive(data) {
  enqueue(async () => {
    if (!playing) return;
    try {
      const state = await send("update", data);
      await chrome.storage.local.set({ sequence: state.sequence, bpm: state.bpm });
      status.classList.remove("error");
      updateState(state);
    } catch (error) {
      showStatus(error.message || "could not update the sequence.", true);
    }
  });
}

function applyBpm() {
  if (bpmTimer === null) return;
  clearTimeout(bpmTimer);
  bpmTimer = null;
  if (validBpmInput() && playing) updateLive({ bpm: Number(bpmInput.value) });
}

bpmInput.addEventListener("input", () => {
  clearTimeout(bpmTimer);
  bpmTimer = null;
  if (!markBpmValidity()) {
    showGuidance();
    return;
  }
  showGuidance();
  if (playing) {
    bpmTimer = setTimeout(applyBpm, 300);
  } else {
    updateState({ playing: false, currentStep: -1 });
  }
});
bpmInput.addEventListener("change", applyBpm);

form.addEventListener("keydown", event => {
  if (event.key === "Enter" && event.target === bpmInput) {
    event.preventDefault();
    applyBpm();
  }
});

function adjustBpm(amount) {
  if (!markBpmValidity()) {
    showGuidance();
    return;
  }
  const bpm = Math.max(1, Math.min(999, Number(bpmInput.value) + amount));
  if (bpm === Number(bpmInput.value)) return;
  clearTimeout(bpmTimer);
  bpmTimer = null;
  bpmInput.value = String(bpm);
  if (playing) {
    updateLive({ bpm });
  } else {
    status.classList.remove("error");
    updateState({ playing: false, currentStep: -1 });
  }
}

bpmDecrease.addEventListener("click", () => adjustBpm(-1));
bpmIncrease.addEventListener("click", () => adjustBpm(1));

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (transportPending) return;
  if (playing) {
    if (bpmTimer !== null) applyBpm();
    transportPending = true;
    transport.disabled = true;
    await enqueue(async () => {
      try {
        const state = await send("stop");
        status.classList.remove("error");
        updateState(state);
      } catch (error) {
        showStatus(error.message || "could not stop the sequence.", true);
      } finally {
        transportPending = false;
        transport.disabled = false;
      }
    });
    return;
  }
  const sequence = inputs.map(input => input.value);
  const bpm = Number(bpmInput.value);
  const validSteps = sequence.every(validStep);
  const validBpm = markBpmValidity();
  if (!validSteps || !validBpm) {
    showGuidance();
    if (!validBpm) bpmInput.focus();
    return;
  }
  transportPending = true;
  transport.disabled = true;
  settings.disabled = true;
  optionsToggle.disabled = true;
  includeEmptyStepsInput.disabled = true;
  randomizePadTimecodesInput.disabled = true;
  randomizePadsButton.disabled = true;
  for (const button of recordButtons.values()) button.disabled = true;
  bpmInput.disabled = true;
  bpmDecrease.disabled = true;
  bpmIncrease.disabled = true;
  await enqueue(async () => {
    try {
      await chrome.storage.local.set({ sequence, bpm });
      const state = await send("play", {
        sequence, bpm, randomize: connectBox.checked, prohibitedPads: [...prohibitedPads],
        includeEmptySteps, recordedPadTimes: { ...recordedPadTimes }, randomizePadTimecodes
      });
      status.classList.remove("error");
      updateState(state);
    } catch (error) {
      settings.disabled = false;
      optionsToggle.disabled = false;
      includeEmptyStepsInput.disabled = false;
      randomizePadTimecodesInput.disabled = false;
      randomizePadsButton.disabled = false;
      for (const button of recordButtons.values()) button.disabled = false;
      bpmInput.disabled = false;
      bpmDecrease.disabled = false;
      bpmIncrease.disabled = false;
      showStatus(error.message || "could not start the sequence.", true);
    } finally {
      transportPending = false;
      transport.disabled = false;
      optionsToggle.disabled = false;
      includeEmptyStepsInput.disabled = false;
      randomizePadTimecodesInput.disabled = false;
      randomizePadsButton.disabled = false;
      for (const button of recordButtons.values()) button.disabled = false;
    }
  });
});

async function initialize() {
  setUnavailable("connecting to youtube...");
  try {
    const saved = await chrome.storage.local.get([
      "sequence", "bpm", "randomize", "prohibitedPads", "includeEmptySteps",
      "recordedPadTimesByVideo", "randomizePadTimecodes"
    ]);
    setConnected(saved.randomize === true);
    includeEmptySteps = saved.includeEmptySteps !== false;
    includeEmptyStepsInput.checked = includeEmptySteps;
    randomizePadTimecodes = saved.randomizePadTimecodes === true;
    randomizePadTimecodesInput.checked = randomizePadTimecodes;
    prohibitedPads = new Set(Array.isArray(saved.prohibitedPads)
      ? saved.prohibitedPads.filter(key => typeof key === "string" && /^[0-9]$/.test(key))
      : []);
    recordedPadTimesByVideo = normalizeRecordedPadTimesByVideo(saved.recordedPadTimesByVideo);
    updateProhibitedPadControls();
    if (Array.isArray(saved.sequence) && saved.sequence.length > 0 &&
        saved.sequence.every(validStep)) {
      setSequence(saved.sequence);
    }
    if (Number.isInteger(saved.bpm) && saved.bpm >= 1 && saved.bpm <= 999) {
      bpmInput.value = String(saved.bpm);
    }
    const target = new URLSearchParams(location.search).get("tabId");
    if (!target || !/^\d+$/.test(target) || !Number.isSafeInteger(Number(target))) {
      setUnavailable("open the sequencer from a youtube video tab.");
      return;
    }
    let tab;
    try {
      tab = await chrome.tabs.get(Number(target));
    } catch {
      setUnavailable("the original video tab is no longer available.");
      return;
    }
    const url = tab?.url ? new URL(tab.url) : null;
    if (!tab?.id || !url || url.protocol !== "https:" ||
        !["youtube.com", "www.youtube.com"].includes(url.hostname) ||
        url.pathname !== "/watch" || !url.searchParams.get("v")) {
      setUnavailable("open the sequencer from a youtube video tab.");
      return;
    }
    tabId = tab.id;
    videoId = url.searchParams.get("v");
    recordedPadTimes = { ...(recordedPadTimesByVideo[videoId] || {}) };
    updatePadLabels();
    videoTitle.textContent = (tab.title || "").replace(/^\(\d+\)\s*/, "").replace(/ - youtube$/i, "").toLowerCase();
    videoTitle.title = videoTitle.textContent;
    await send("prohibited", { prohibitedPads: [...prohibitedPads] });
    const port = chrome.tabs.connect(tabId, { name: `${prefix}steps` });
    port.onMessage.addListener(message => {
      if (tabId === null) return;
      if (transportPending) return;
      if (message.playbackError) updateState(message);
      else if (playing) updateStepIndicator(message);
    });
    port.onDisconnect.addListener(() => {
      if (tabId !== null) {
        tabId = null;
        setUnavailable("connection lost. reopen the sequencer from the youtube tab.");
      }
    });
    await refresh(true);
    setInterval(() => {
      refresh();
    }, 1000);
  } catch {
    setUnavailable("could not start the extension. try reopening it.");
  }
}

initialize();
