(() => {
  const MESSAGE_PREFIX = "yt-step-sequencer:";
  let timer = null;
  let sequence = null;
  let bpm = null;
  let currentStep = -1;
  let nextStep = 0;
  let nextTime = 0;
  let videoId = null;
  let generation = 0;
  let stepSerial = 0;
  let timingDelays = 0;
  let mutedForRest = null;
  const observers = new Set();

  function currentVideoId() {
    const url = new URL(location.href);
    return url.pathname === "/watch" ? url.searchParams.get("v") : null;
  }

  function stop() {
    generation++;
    endRest();
    if (timer !== null) clearTimeout(timer);
    timer = null;
    sequence = null;
    bpm = null;
    currentStep = -1;
    nextStep = 0;
    videoId = null;
  }

  function state() {
    return { playing: sequence !== null, sequence, bpm, currentStep, stepSerial, timingDelays };
  }

  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== `${MESSAGE_PREFIX}steps`) return;
    observers.add(port);
    port.onDisconnect.addListener(() => observers.delete(port));
  });

  function validSequence(value) {
    return Array.isArray(value) && value.length === 8 &&
      value.every(validStep);
  }

  function validStep(value) {
    return typeof value === "string" && /^[0-9]?$/.test(value);
  }

  function endRest() {
    if (!mutedForRest) return;
    if (mutedForRest.video.muted) mutedForRest.video.muted = mutedForRest.wasMuted;
    mutedForRest = null;
  }

  function beginRest(video) {
    if (mutedForRest?.video === video) {
      if (!video.muted) mutedForRest.wasMuted = false;
      video.muted = true;
      return;
    }
    endRest();
    mutedForRest = { video, wasMuted: video.muted };
    video.muted = true;
  }

  function validBpm(value) {
    return Number.isInteger(value) && value >= 1 && value <= 999;
  }

  function dispatchDigit(player, key) {
    const options = {
      key,
      code: `Digit${key}`,
      keyCode: 48 + Number(key),
      which: 48 + Number(key),
      bubbles: true,
      cancelable: true
    };
    player.dispatchEvent(new KeyboardEvent("keydown", options));
    player.dispatchEvent(new KeyboardEvent("keyup", options));
  }

  function tick() {
    if (!sequence || currentVideoId() !== videoId) {
      stop();
      return;
    }
    const player = document.querySelector(".html5-video-player");
    const video = player?.querySelector("video");
    if (!player || !video) {
      stop();
      return;
    }

    const interval = 60000 / bpm;
    const startTime = performance.now();
    if (startTime - nextTime >= interval) timingDelays++;
    currentStep = nextStep;
    nextStep = (nextStep + 1) % sequence.length;
    if (sequence[currentStep] === "") {
      beginRest(video);
    } else {
      endRest();
      dispatchDigit(player, sequence[currentStep]);
    }
    stepSerial++;
    for (const port of observers) {
      try {
        port.postMessage({ currentStep, stepSerial, timingDelays });
      } catch (error) {
        observers.delete(port);
        console.warn("Could not send step update:", error);
      }
    }
    nextTime += interval;
    const now = performance.now();
    if (nextTime - now < interval / 4) {
      nextTime = now + interval;
    }
    timer = setTimeout(tick, Math.max(0, nextTime - now));
  }

  document.addEventListener("yt-navigate-finish", () => {
    if ((sequence && currentVideoId() !== videoId) || (mutedForRest && !sequence)) stop();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string" ||
        !message.type.startsWith(MESSAGE_PREFIX)) return;

    if (message.type === `${MESSAGE_PREFIX}status`) {
      if (sequence && currentVideoId() !== videoId) stop();
      if (!currentVideoId()) {
        sendResponse({ ok: false, error: "Open a YouTube video in the original tab." });
        return;
      }
      sendResponse({ ok: true, ...state() });
      return;
    }
    if (message.type === `${MESSAGE_PREFIX}stop`) {
      stop();
      sendResponse({ ok: true, ...state() });
      return;
    }
    if (message.type === `${MESSAGE_PREFIX}trigger`) {
      if (typeof message.key !== "string" || !/^[0-9]$/.test(message.key)) {
        sendResponse({ ok: false, error: "Enter a digit from 0 to 9." });
        return;
      }
      const player = document.querySelector(".html5-video-player");
      const video = player?.querySelector("video");
      if (!currentVideoId() || !player || !video) {
        sendResponse({ ok: false, error: "Open a YouTube video and wait for the player to load." });
        return;
      }
      endRest();
      dispatchDigit(player, message.key);
      if (video.paused) {
        video.play().then(
          () => sendResponse({ ok: true }),
          () => sendResponse({ ok: false, error: "Could not start the video. Press play on YouTube and try again." })
        );
        return true;
      }
      sendResponse({ ok: true });
      return;
    }
    if (message.type === `${MESSAGE_PREFIX}play`) {
      const id = currentVideoId();
      const player = document.querySelector(".html5-video-player");
      const video = player?.querySelector("video");
      if (!id || !player || !video) {
        sendResponse({ ok: false, error: "Open a YouTube video and wait for the player to load." });
        return;
      }
      if (!validSequence(message.sequence) || !validBpm(message.bpm)) {
        sendResponse({ ok: false, error: "Steps must be empty or a digit from 0 to 9, and BPM must be from 1 to 999." });
        return;
      }
      stop();
      const attempt = generation;
      const start = () => {
        if (attempt !== generation || currentVideoId() !== id ||
            document.querySelector(".html5-video-player") !== player ||
            player.querySelector("video") !== video) {
          if (attempt === generation) endRest();
          sendResponse({ ok: false, error: "Playback was cancelled or the video changed." });
          return;
        }
        sequence = message.sequence.slice();
        bpm = message.bpm;
        videoId = id;
        timingDelays = 0;
        nextTime = performance.now();
        tick();
        sendResponse({ ok: true, ...state() });
      };
      if (video.paused) {
        if (message.sequence[0] === "") beginRest(video);
        video.play().then(start, () => {
          if (attempt === generation) endRest();
          sendResponse({ ok: false, error: "Could not start the video. Press play on YouTube and try again." });
        });
        return true;
      }
      start();
      return;
    }
    if (message.type === `${MESSAGE_PREFIX}update`) {
      if (sequence && currentVideoId() !== videoId) stop();
      if (!sequence) {
        sendResponse({ ok: false, error: "The sequence is no longer playing." });
        return;
      }
      if (message.sequence !== undefined) {
        if (!validSequence(message.sequence)) {
          sendResponse({ ok: false, error: "Steps must be empty or a digit from 0 to 9." });
          return;
        }
        sequence = message.sequence.slice();
      } else if (message.step !== undefined) {
        if (!Number.isInteger(message.step) || message.step < 0 || message.step >= sequence.length ||
            !validStep(message.value)) {
          sendResponse({ ok: false, error: "Steps must be empty or a digit from 0 to 9." });
          return;
        }
        sequence[message.step] = message.value;
      } else if (message.bpm !== undefined) {
        if (!validBpm(message.bpm)) {
          sendResponse({ ok: false, error: "Enter a BPM from 1 to 999." });
          return;
        }
        if (bpm !== message.bpm) {
          const now = performance.now();
          const remaining = Math.max(0, Math.min(1, (nextTime - now) / (60000 / bpm)));
          bpm = message.bpm;
          nextTime = now + remaining * (60000 / bpm);
          clearTimeout(timer);
          timer = setTimeout(tick, Math.max(0, nextTime - now));
        }
      } else {
        sendResponse({ ok: false, error: "No change was received." });
        return;
      }
      sendResponse({ ok: true, ...state() });
    }
  });
})();
