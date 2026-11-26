async function sequencerWindows() {
  const popupUrl = chrome.runtime.getURL("popup.html");
  return (await chrome.windows.getAll({ populate: true, windowTypes: ["popup"] }))
    .filter(window => window.tabs?.some(item => item.url?.split(/[?#]/, 1)[0] === popupUrl));
}

chrome.action.onClicked.addListener(async tab => {
  try {
    const existing = await sequencerWindows();
    if (existing.length) {
      for (const window of existing) {
        try {
          await chrome.windows.update(window.id, {
            focused: true, ...(window.state === "minimized" && { state: "normal" })
          });
        } catch (error) {
          console.error("Could not bring the sequencer window forward:", error);
        }
      }
      return;
    }
    if (!Number.isInteger(tab.id)) throw new Error("The tab has no ID.");
    const [sourceWindow, displays] = await Promise.all([
      chrome.windows.get(tab.windowId),
      chrome.system.display.getInfo()
    ]);
    if (![sourceWindow.left, sourceWindow.top, sourceWindow.width, sourceWindow.height]
      .every(Number.isFinite)) {
      throw new Error("Could not determine the video window's position.");
    }
    const centerX = sourceWindow.left + sourceWindow.width / 2;
    const centerY = sourceWindow.top + sourceWindow.height / 2;
    const display = displays.find(({ bounds }) =>
      centerX >= bounds.left && centerX < bounds.left + bounds.width &&
      centerY >= bounds.top && centerY < bounds.top + bounds.height
    ) || displays.find(display => display.isPrimary);
    if (!display) throw new Error("Could not determine the display.");
    const area = display.workArea;
    const width = Math.min(412, area.width);
    const height = Math.min(460, area.height);
    await chrome.windows.create({
      url: `popup.html?tabId=${tab.id}`,
      type: "popup",
      width,
      height,
      left: Math.round(area.left + (area.width - width) / 2),
      top: Math.round(area.top + (area.height - height) / 2)
    });
  } catch (error) {
    console.error("Could not open the sequencer window:", error);
  }
});

const chorusKey = "chorusSession";
const chorusPorts = new Set();
let chorusQueue = Promise.resolve();

function defaultChorus() {
  return {
    bpm: 120, length: 8, playing: false, clock: null, clockVersion: 0,
    metronome: false, resetVersion: 0, recordedPadTimesByTab: {}, lockedPadsByTab: {}, voices: {}
  };
}

function chorusNow() {
  return performance.timeOrigin + performance.now();
}

function nextClock(session, bpm = session.bpm) {
  const now = chorusNow() + 350;
  if (!session.playing || !session.clock) return { startAt: now, step: 0 };
  const interval = 60000 / session.bpm;
  const beat = Math.max(0, Math.ceil((now - session.clock.startAt) / interval));
  return {
    startAt: Math.min(session.clock.startAt + beat * interval, now + 60000 / bpm),
    step: (session.clock.step + beat) % session.length
  };
}

function notifyChorus(session) {
  for (const port of chorusPorts) {
    try {
      port.postMessage(session);
    } catch (error) {
      chorusPorts.delete(port);
      console.warn("Could not send chorus update:", error);
    }
  }
}

function queueChorus(action) {
  const result = chorusQueue.then(action);
  chorusQueue = result.catch(error => console.error("Could not update chorus:", error));
  return result;
}

async function loadChorus() {
  const saved = await chrome.storage.session.get(chorusKey);
  const session = saved[chorusKey] || defaultChorus();
  const migrateTimes = !session.recordedPadTimesByTab;
  const migrateLocks = !session.lockedPadsByTab;
  if (migrateTimes || migrateLocks) {
    session.recordedPadTimesByTab ||= {};
    session.lockedPadsByTab ||= {};
    for (const voice of Object.values(session.voices)) {
      if (!Number.isInteger(voice.tabId) || !voice.videoId) continue;
      if (migrateTimes) {
        session.recordedPadTimesByTab[voice.tabId] = Object.fromEntries(
          Object.entries(session.recordedPadTimesByVideo || {}).map(([id, times]) => [id, { ...times }])
        );
      }
      if (migrateLocks) {
        session.lockedPadsByTab[voice.tabId] = Object.fromEntries(
          Object.entries(session.lockedPadsByVideo || {}).map(([id, locks]) => [id, [...locks]])
        );
      }
    }
  }
  return session;
}

async function saveChorus(session) {
  await chrome.storage.session.set({ [chorusKey]: session });
  notifyChorus(session);
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "yt-step-sequencer:chorus") return;
  chorusPorts.add(port);
  port.onDisconnect.addListener(() => chorusPorts.delete(port));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "yt-step-sequencer:close-all-windows") {
    (async () => {
      const windows = await sequencerWindows();
      if (!Number.isInteger(message.windowId) || !windows.some(window => window.id === message.windowId)) {
        throw new Error("The sequencer window is no longer available.");
      }
      let failed = false;
      for (const window of windows.filter(window => window.id !== message.windowId)) {
        try {
          await chrome.windows.remove(window.id);
        } catch (error) {
          failed = true;
          console.error("Could not close the sequencer window:", error);
        }
      }
      if (failed) throw new Error("Could not close all sequencer windows.");
      await chrome.windows.remove(message.windowId);
      sendResponse({ ok: true });
    })().catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (!message || typeof message.type !== "string" ||
      !message.type.startsWith("yt-step-sequencer:chorus-")) return;
  queueChorus(async () => {
    const session = await loadChorus();
    const id = String(message.windowId);
    const voice = session.voices[id];
    switch (message.type) {
      case "yt-step-sequencer:chorus-register": {
        if (!Number.isInteger(message.windowId)) throw new Error("Invalid sequencer window.");
        if (message.tabId !== null && (!Number.isInteger(message.tabId) || !message.videoId)) {
          throw new Error("Invalid video.");
        }
        if (message.tabId !== null && Object.entries(session.voices).some(([key, item]) =>
          key !== id && item.tabId === message.tabId
        )) throw new Error("This video tab is already assigned.");
        if (!voice) {
          session.voices[id] = {
            tabId: message.tabId, videoId: message.videoId,
            sequence: Array(session.length).fill(""),
            lockedSteps: [], prohibitedPads: [],
            randomize: false, includeEmptySteps: true
          };
        } else {
          voice.tabId = message.tabId;
          voice.videoId = message.videoId;
        }
        break;
      }
      case "yt-step-sequencer:chorus-voice":
        if (!voice) throw new Error("The sequencer window is no longer available.");
        if (!message.changes || typeof message.changes !== "object") throw new Error("Invalid voice settings.");
        if (message.changes.sequence !== undefined &&
            (!Array.isArray(message.changes.sequence) || message.changes.sequence.length !== session.length ||
             !message.changes.sequence.every(value => typeof value === "string" && /^[0-9]?$/.test(value)))) {
          throw new Error("Steps must be empty or a digit from 0 to 9.");
        }
        if (message.changes.lockedSteps !== undefined &&
            (!Array.isArray(message.changes.lockedSteps) ||
             message.changes.lockedSteps.some(index => !Number.isInteger(index) || index < 0 || index >= session.length) ||
             new Set(message.changes.lockedSteps).size !== message.changes.lockedSteps.length)) {
          throw new Error("Invalid locked steps.");
        }
        if (message.padTime) {
          const { tabId, videoId, times } = message.padTime;
          if (typeof videoId !== "string" || !videoId || (times !== null &&
              (typeof times !== "object" || Array.isArray(times) ||
               Object.entries(times).some(([key, value]) => !/^[0-9]$/.test(key) ||
                 !Number.isFinite(value) || value < 0)))) throw new Error("Invalid pad times.");
          if (!Number.isInteger(tabId) || voice.tabId !== tabId || voice.videoId !== videoId) {
            throw new Error("The video has changed.");
          }
          const previousTimes = session.recordedPadTimesByTab[tabId]?.[videoId] || {};
          const locked = session.lockedPadsByTab[tabId]?.[videoId] || [];
          if (locked.some(key => previousTimes[key] !== (times || {})[key])) {
            throw new Error("Unlock the pad before changing its time.");
          }
          if (times === null) delete session.recordedPadTimesByTab[tabId]?.[videoId];
          else (session.recordedPadTimesByTab[tabId] ||= {})[videoId] = times;
        }
        Object.assign(voice, message.changes);
        break;
      case "yt-step-sequencer:chorus-pad-lock": {
        if (!voice || !voice.videoId || voice.videoId !== message.videoId ||
            !Number.isInteger(message.tabId) || voice.tabId !== message.tabId) {
          throw new Error("The video is no longer available.");
        }
        if (typeof message.key !== "string" || !/^[0-9]$/.test(message.key) ||
            typeof message.locked !== "boolean") throw new Error("Invalid pad lock.");
        const locks = new Set(session.lockedPadsByTab[voice.tabId]?.[voice.videoId] || []);
        if (message.locked) locks.add(message.key);
        else locks.delete(message.key);
        if (locks.size) (session.lockedPadsByTab[voice.tabId] ||= {})[voice.videoId] = [...locks];
        else delete session.lockedPadsByTab[voice.tabId]?.[voice.videoId];
        break;
      }
      case "yt-step-sequencer:chorus-unassign":
        if (!voice) throw new Error("The sequencer window is no longer available.");
        voice.tabId = null;
        voice.videoId = null;
        break;
      case "yt-step-sequencer:chorus-reset":
        if (!voice) throw new Error("The sequencer window is no longer available.");
        if (Object.values(session.voices).some(item => item.lockedSteps.some(index => index >= 8))) {
          throw new Error("Unlock steps after step 8 in every voice before resetting.");
        }
        for (const item of Object.values(session.voices)) {
          item.sequence = Array.from({ length: 8 }, (_, index) =>
            item.lockedSteps.includes(index) ? item.sequence[index] : ""
          );
          item.prohibitedPads = [];
          item.randomize = false;
        }
        for (const item of Object.values(session.voices)) {
          if (!Number.isInteger(item.tabId) || !item.videoId) continue;
          const { tabId, videoId } = item;
          const times = session.recordedPadTimesByTab[tabId]?.[videoId] || {};
          const locked = session.lockedPadsByTab[tabId]?.[videoId] || [];
          const preserved = Object.fromEntries(locked.filter(key =>
            Object.prototype.hasOwnProperty.call(times, key)
          ).map(key => [key, times[key]]));
          if (Object.keys(preserved).length) (session.recordedPadTimesByTab[tabId] ||= {})[videoId] = preserved;
          else delete session.recordedPadTimesByTab[tabId]?.[videoId];
        }
        session.length = 8;
        session.resetVersion = (session.resetVersion || 0) + 1;
        break;
      case "yt-step-sequencer:chorus-length":
        if (!Number.isInteger(message.length) || message.length < 1 ||
            Math.abs(message.length - session.length) !== 1) {
          throw new Error("Invalid step count.");
        }
        if (message.length < session.length &&
            Object.values(session.voices).some(item => item.lockedSteps.includes(session.length - 1))) {
          throw new Error("Unlock the last step in every voice before removing it.");
        }
        for (const item of Object.values(session.voices)) {
          if (message.length > session.length) item.sequence.push("");
          else item.sequence.pop();
        }
        session.length = message.length;
        break;
      case "yt-step-sequencer:chorus-bpm":
        if (!Number.isInteger(message.bpm) || message.bpm < 1 || message.bpm > 999) {
          throw new Error("Enter a whole-number BPM from 1 to 999.");
        }
        if (session.bpm !== message.bpm) {
          if (session.playing) {
            session.clock = nextClock(session, message.bpm);
            session.clockVersion++;
          }
          session.bpm = message.bpm;
        }
        break;
      case "yt-step-sequencer:chorus-transport":
        if (typeof message.playing !== "boolean") throw new Error("Invalid transport state.");
        if (message.playing && !Object.values(session.voices).some(item => item.tabId !== null)) {
          throw new Error("Choose a video before starting playback.");
        }
        if (session.playing !== message.playing) {
          session.clock = message.playing ? nextClock(session) : null;
          session.playing = message.playing;
          session.clockVersion++;
        }
        break;
      case "yt-step-sequencer:chorus-metronome":
        if (typeof message.enabled !== "boolean") throw new Error("Invalid metronome state.");
        session.metronome = message.enabled;
        break;
      case "yt-step-sequencer:chorus-get":
        sendResponse({ ok: true, session });
        return;
      default:
        throw new Error("Unknown chorus command.");
    }
    await saveChorus(session);
    sendResponse({ ok: true, session });
  }).catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.windows.onRemoved.addListener(windowId => {
  queueChorus(async () => {
    const session = await loadChorus();
    const voice = session.voices[String(windowId)];
    if (!voice) return;
    delete session.voices[String(windowId)];
    if (Number.isInteger(voice.tabId)) {
      try {
        await chrome.tabs.sendMessage(voice.tabId, { type: "yt-step-sequencer:stop" });
      } catch (error) {
        console.warn("Could not stop the closed voice:", error);
      }
    }
    if (Object.keys(session.voices).length === 0) {
      await chrome.storage.session.remove(chorusKey);
      await chrome.storage.local.remove([
        "sequence", "bpm", "randomize", "prohibitedPads", "includeEmptySteps",
        "recordedPadTimesByVideo", "lockedSteps"
      ]);
      notifyChorus(defaultChorus());
    } else {
      await saveChorus(session);
    }
  });
});

chrome.tabs.onRemoved.addListener(tabId => {
  queueChorus(async () => {
    const session = await loadChorus();
    let changed = false;
    if (session.recordedPadTimesByTab[tabId] || session.lockedPadsByTab[tabId]) {
      delete session.recordedPadTimesByTab[tabId];
      delete session.lockedPadsByTab[tabId];
      changed = true;
    }
    for (const voice of Object.values(session.voices)) {
      if (voice.tabId === tabId) {
        voice.tabId = null;
        voice.videoId = null;
        changed = true;
      }
    }
    if (changed) await saveChorus(session);
  });
});
