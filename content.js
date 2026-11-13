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

  function currentVideoId() {
    const url = new URL(location.href);
    return url.pathname === "/watch" ? url.searchParams.get("v") : null;
  }

  function stop() {
    generation++;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    sequence = null;
    bpm = null;
    currentStep = -1;
    nextStep = 0;
    videoId = null;
  }

  function state() {
    return { playing: sequence !== null, sequence, bpm, currentStep };
  }

  function validSequence(value) {
    return Array.isArray(value) && value.length === 8 &&
      value.every(item => typeof item === "string" && /^[0-9]$/.test(item));
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
    if (!player) {
      stop();
      return;
    }

    currentStep = nextStep;
    nextStep = (nextStep + 1) % sequence.length;
    dispatchDigit(player, sequence[currentStep]);

    const interval = 60000 / bpm;
    nextTime += interval;
    const now = performance.now();
    if (nextTime <= now) {
      const missed = Math.floor((now - nextTime) / interval) + 1;
      nextStep = (nextStep + missed) % sequence.length;
      nextTime += missed * interval;
    }
    timer = setTimeout(tick, Math.max(0, nextTime - now));
  }

  document.addEventListener("yt-navigate-finish", () => {
    if (sequence && currentVideoId() !== videoId) stop();
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
      if (!currentVideoId() || !player) {
        sendResponse({ ok: false, error: "Open a YouTube video and wait for the player to load." });
        return;
      }
      dispatchDigit(player, message.key);
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
        sendResponse({ ok: false, error: "Enter eight digits from 0 to 9 and a BPM from 1 to 999." });
        return;
      }
      stop();
      const attempt = generation;
      const start = () => {
        if (attempt !== generation || currentVideoId() !== id ||
            document.querySelector(".html5-video-player") !== player ||
            player.querySelector("video") !== video) {
          sendResponse({ ok: false, error: "Playback was cancelled or the video changed." });
          return;
        }
        sequence = message.sequence.slice();
        bpm = message.bpm;
        videoId = id;
        nextTime = performance.now();
        tick();
        sendResponse({ ok: true, ...state() });
      };
      if (video.paused) {
        video.play().then(start, () => {
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
          sendResponse({ ok: false, error: "Enter eight digits from 0 to 9." });
          return;
        }
        sequence = message.sequence.slice();
      } else if (message.step !== undefined) {
        if (!Number.isInteger(message.step) || message.step < 0 || message.step >= sequence.length ||
            typeof message.value !== "string" || !/^[0-9]$/.test(message.value)) {
          sendResponse({ ok: false, error: "Enter a digit from 0 to 9." });
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
