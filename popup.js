const prefix = "yt-step-sequencer:";
const form = document.querySelector("#sequencer");
const settings = document.querySelector("#settings");
const steps = document.querySelector("#steps");
const randomizeButton = document.querySelector("#randomize");
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

for (let index = 0; index < 8; index++) {
  const label = document.createElement("label");
  label.className = "step";
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.maxLength = 1;
  input.pattern = "[0-9]";
  input.autocomplete = "off";
  input.value = String(index);
  input.setAttribute("aria-label", `step ${index + 1}`);
  label.append(input);
  steps.append(label);
}

const inputs = [...steps.querySelectorAll("input")];
const padButtons = new Map();
const padTimers = new Map();

for (const key of "1234567890") {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = key;
  button.setAttribute("aria-label", `play ${key}`);
  button.disabled = true;
  button.addEventListener("click", () => triggerPad(key));
  pads.append(button);
  padButtons.set(key, button);
}

function updatePadIndicator(value) {
  for (const [key, button] of padButtons) {
    button.classList.toggle("current", key === value);
  }
}

async function triggerPad(key) {
  const button = padButtons.get(key);
  if (!button || button.disabled) return;
  button.classList.add("active");
  clearTimeout(padTimers.get(key));
  padTimers.set(key, setTimeout(() => {
    button.classList.remove("active");
    padTimers.delete(key);
  }, 150));
  if (selectedStep !== null) {
    const input = inputs[selectedStep];
    input.value = key;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  try {
    await send("trigger", { key });
  } catch (error) {
    showStatus(error.message || "could not play the pad.", true);
  }
}

document.addEventListener("keydown", event => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (event.key === "Enter" && selectedStep !== null &&
      event.target !== bpmInput && event.target !== nextStepButton &&
      event.target !== randomizeButton &&
      event.target !== clearButton &&
      event.target !== resetButton &&
      event.target !== transport &&
      event.target !== bpmDecrease && event.target !== bpmIncrease) {
    event.preventDefault();
    advanceStep();
  } else if (event.key === "Escape" && selectedStep !== null) {
    event.preventDefault();
    selectStep(null);
  } else if (/^[0-9]$/.test(event.key) && event.target !== bpmInput) {
    event.preventDefault();
    triggerPad(event.key);
  }
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

function replaceSequence(sequence) {
  inputs.forEach((input, index) => { input.value = sequence[index]; });
  enqueue(async () => {
    try {
      if (playing) {
        const state = await send("update", { sequence });
        await chrome.storage.local.set({ sequence: state.sequence, bpm: state.bpm });
        status.classList.remove("error");
        updateState(state);
      } else {
        await chrome.storage.local.set({ sequence });
        status.classList.remove("error");
        showGuidance();
      }
    } catch (error) {
      showStatus(error.message || "could not update the sequence.", true);
    }
  });
}

randomizeButton.addEventListener("click", () => {
  const choices = "0123456789";
  replaceSequence(inputs.map(() => choices[Math.floor(Math.random() * 11)] ?? ""));
});
clearButton.addEventListener("click", () => replaceSequence(inputs.map(() => "")));
resetButton.addEventListener("click", () => replaceSequence(inputs.map((_, index) => String(index))));

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
    inputs.forEach((input, index) => { input.value = state.sequence[index]; });
    bpmInput.value = String(state.bpm);
  }
  markBpmValidity();
  if (state.playbackError) showStatus(state.playbackError, true);
  else if (!status.classList.contains("error") || hydrate) showGuidance();
}

function updateStepIndicator(state) {
  if (!Number.isInteger(state.stepSerial) || state.stepSerial < lastStepSerial) return;
  if ("padValue" in state) updatePadIndicator(state.padValue);
  lastStepSerial = state.stepSerial;
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

inputs.forEach((input, step) => {
  input.addEventListener("focus", () => {
    selectStep(step);
    input.select();
  });
  input.addEventListener("pointerup", () => {
    selectStep(step);
    input.select();
  });
  input.addEventListener("input", () => {
    if (validStep(input.value)) {
      if (playing) updateLive({ step, value: input.value });
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
});

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
  bpmInput.disabled = true;
  bpmDecrease.disabled = true;
  bpmIncrease.disabled = true;
  await enqueue(async () => {
    try {
      await chrome.storage.local.set({ sequence, bpm });
      const state = await send("play", { sequence, bpm });
      status.classList.remove("error");
      updateState(state);
    } catch (error) {
      settings.disabled = false;
      bpmInput.disabled = false;
      bpmDecrease.disabled = false;
      bpmIncrease.disabled = false;
      showStatus(error.message || "could not start the sequence.", true);
    } finally {
      transportPending = false;
      transport.disabled = false;
    }
  });
});

async function initialize() {
  setUnavailable("connecting to youtube...");
  try {
    const saved = await chrome.storage.local.get(["sequence", "bpm"]);
    if (Array.isArray(saved.sequence) && saved.sequence.length === 8 &&
        saved.sequence.every(validStep)) {
      inputs.forEach((input, index) => { input.value = saved.sequence[index]; });
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
