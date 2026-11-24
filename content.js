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
  let stepValue = null;
  let randomizeOnStart = false;
  let prohibitedPads = [];
  let lockedSteps = [];
  let includeEmptySteps = true;
  let recordedPadTimes = {};
  let padValue = null;
  let timingDelays = 0;
  let playbackError = null;
  let resumeAttempt = null;
  let manuallyPaused = false;
  let videoControlVersion = 0;
  let metronomeEnabled = false;
  let metronomeAudio = null;
  let metronomeRequest = 0;
  const playbackFailure = "Could not start the video. Press play on YouTube and try again.";
  const observers = new Set();

  function currentVideoId() {
    const url = new URL(location.href);
    return url.pathname === "/watch" ? url.searchParams.get("v") : null;
  }

  function stop() {
    generation++;
    resumeAttempt = null;
    manuallyPaused = false;
    playbackError = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    sequence = null;
    bpm = null;
    currentStep = -1;
    stepValue = null;
    padValue = null;
    randomizeOnStart = false;
    nextStep = 0;
    videoId = null;
  }

  function state() {
    const video = document.querySelector(".html5-video-player")?.querySelector("video");
    const duration = video?.duration;
    return {
      playing: sequence !== null, sequence, bpm, currentStep, stepValue, stepSerial,
      timingDelays, playbackError, padValue, randomizeOnStart, prohibitedPads, lockedSteps,
      includeEmptySteps, recordedPadTimes, metronomeEnabled, videoId: currentVideoId(),
      videoDuration: Number.isFinite(duration) && duration >= 0 ? duration : null,
      videoPaused: video ? video.paused : null
    };
  }

  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== `${MESSAGE_PREFIX}steps`) return;
    observers.add(port);
    port.onDisconnect.addListener(() => observers.delete(port));
  });

  function validSequence(value) {
    return Array.isArray(value) && value.length > 0 &&
      value.every(validStep);
  }

  function validStep(value) {
    return typeof value === "string" && /^[0-9]?$/.test(value);
  }

  function validBpm(value) {
    return Number.isInteger(value) && value >= 1 && value <= 999;
  }

  function validProhibitedPads(value) {
    return Array.isArray(value) && value.length <= 10 &&
      value.every(key => typeof key === "string" && /^[0-9]$/.test(key)) &&
      new Set(value).size === value.length;
  }

  function validRecordedPadTimes(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
      Object.entries(value).every(([key, timecode]) =>
        /^[0-9]$/.test(key) && Number.isFinite(timecode) && timecode >= 0
      );
  }

  function validLockedSteps(value, length) {
    return Array.isArray(value) && value.every(index =>
      Number.isSafeInteger(index) && index >= 0 && (length === null || index < length)
    ) && new Set(value).size === value.length;
  }

  function setProhibitedPads(value) {
    prohibitedPads = value.slice();
    if (prohibitedPads.includes(padValue)) {
      padValue = null;
      notifyObservers({ currentStep, stepValue, padValue, stepSerial, timingDelays });
    }
  }

  function randomSequence() {
    const choices = [..."0123456789"].filter(key => !prohibitedPads.includes(key));
    if (includeEmptySteps) choices.push("");
    if (choices.length === 0 && sequence.some((_, index) => !lockedSteps.includes(index))) return null;
    return sequence.map((value, index) =>
      lockedSteps.includes(index) ? value : choices[Math.floor(Math.random() * choices.length)]
    );
  }

  function digitToTimecode(digit, duration) {
    const keyNumber = Number(digit);
    return (duration * keyNumber) / 10;
  }

  function notifyObservers(message) {
    for (const port of observers) {
      try {
        port.postMessage(message);
      } catch (error) {
        observers.delete(port);
        console.warn("Could not send step update:", error);
      }
    }
  }

  function playMetronome(step) {
    if (!metronomeEnabled) return;
    try {
      if (metronomeAudio.state !== "running") throw new Error("Metronome audio is unavailable.");
      const now = metronomeAudio.currentTime;
      const oscillator = metronomeAudio.createOscillator();
      const gain = metronomeAudio.createGain();
      oscillator.frequency.setValueAtTime(step === 0 ? 1200 : 800, now);
      gain.gain.setValueAtTime(0.4, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      oscillator.connect(gain);
      gain.connect(metronomeAudio.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.05);
    } catch (error) {
      metronomeEnabled = false;
      console.error("Could not play the metronome:", error);
      notifyObservers({ ...state(), metronomeError: error.message || "Metronome audio is unavailable." });
    }
  }

  function resumeVideo(video) {
    if (!video.paused || resumeAttempt) return;
    const attempt = { generation, video };
    resumeAttempt = attempt;
    video.play().then(() => {
      if (resumeAttempt === attempt) resumeAttempt = null;
    }, () => {
      if (resumeAttempt !== attempt || generation !== attempt.generation) return;
      if (currentVideoId() !== videoId ||
          document.querySelector(".html5-video-player")?.querySelector("video") !== attempt.video) {
        stop();
        return;
      }
      stop();
      playbackError = playbackFailure;
      notifyObservers(state());
    });
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
    const randomizedSequence = randomizeOnStart && currentStep === 0 ? randomSequence() : null;
    const randomized = randomizedSequence !== null;
    if (randomized) sequence = randomizedSequence;
    stepValue = sequence[currentStep];
    if (stepValue !== "" && !prohibitedPads.includes(stepValue)) {
      if (Object.prototype.hasOwnProperty.call(recordedPadTimes, stepValue)) {
        video.currentTime = recordedPadTimes[stepValue];
      } else {
        video.currentTime = digitToTimecode(stepValue, video.duration);
      }
      padValue = stepValue;
    }
    stepSerial++;
    playMetronome(currentStep);
    notifyObservers({
      currentStep, stepValue, padValue, stepSerial, timingDelays,
      ...(randomized && { sequence, randomized })
    });
    nextTime += interval;
    const now = performance.now();
    if (nextTime - now < interval / 4) {
      nextTime = now + interval;
    }
    timer = setTimeout(tick, Math.max(0, nextTime - now));
    if (!video.paused) manuallyPaused = false;
    if (!manuallyPaused) resumeVideo(video);
  }

  document.addEventListener("yt-navigate-finish", () => {
    if (sequence && currentVideoId() !== videoId) stop();
  });
  for (const event of ["play", "pause"]) {
    document.addEventListener(event, ({ target }) => {
      if (target !== document.querySelector(".html5-video-player")?.querySelector("video")) return;
      if (!target.paused) manuallyPaused = false;
      notifyObservers({ videoPaused: target.paused });
    }, true);
  }

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
    if (message.type === `${MESSAGE_PREFIX}video-toggle`) {
      const id = currentVideoId();
      const video = document.querySelector(".html5-video-player")?.querySelector("video");
      if (!id || !video) {
        sendResponse({ ok: false, error: "Open a YouTube video and wait for the player to load." });
        return;
      }
      const request = ++videoControlVersion;
      if (video.paused) {
        video.play().then(() => {
          if (request !== videoControlVersion || currentVideoId() !== id ||
              document.querySelector(".html5-video-player")?.querySelector("video") !== video) {
            sendResponse({ ok: false, error: "Video playback was cancelled or the video changed." });
            return;
          }
          manuallyPaused = false;
          notifyObservers({ videoPaused: video.paused });
          sendResponse({ ok: true, ...state() });
        }, () => sendResponse({ ok: false, error: playbackFailure }));
        return true;
      }
      manuallyPaused = true;
      resumeAttempt = null;
      video.pause();
      notifyObservers({ videoPaused: video.paused });
      sendResponse({ ok: true, ...state() });
      return;
    }
    if (message.type === `${MESSAGE_PREFIX}metronome`) {
      if (typeof message.enabled !== "boolean") {
        sendResponse({ ok: false, error: "Metronome setting must be on or off." });
        return;
      }
      const request = ++metronomeRequest;
      if (!message.enabled) {
        metronomeEnabled = false;
        sendResponse({ ok: true, metronomeEnabled });
        return;
      }
      (async () => {
        try {
          if (!metronomeAudio || metronomeAudio.state === "closed") {
            metronomeAudio = new AudioContext();
          }
          if (metronomeAudio.state !== "running") {
            let timeout;
            try {
              await Promise.race([
                metronomeAudio.resume(),
                new Promise((_, reject) => {
                  timeout = setTimeout(() => reject(new Error(
                    "Metronome audio was blocked. Interact with the YouTube video and try again."
                  )), 2000);
                })
              ]);
            } finally {
              clearTimeout(timeout);
            }
          }
          if (request !== metronomeRequest) {
            sendResponse({ ok: false, error: "Metronome setting changed." });
            return;
          }
          if (metronomeAudio.state !== "running") throw new Error("Metronome audio is unavailable.");
          metronomeEnabled = true;
          sendResponse({ ok: true, metronomeEnabled });
        } catch (error) {
          if (request === metronomeRequest) metronomeEnabled = false;
          sendResponse({ ok: false, error: error.message || "Could not enable the metronome." });
        }
      })();
      return true;
    }
    if (message.type === `${MESSAGE_PREFIX}stop`) {
      stop();
      sendResponse({ ok: true, ...state() });
      return;
    }
    if (message.type === `${MESSAGE_PREFIX}prohibited`) {
      if (!validProhibitedPads(message.prohibitedPads)) {
        sendResponse({ ok: false, error: "Forbidden pads must be unique digits from 0 to 9." });
        return;
      }
      setProhibitedPads(message.prohibitedPads);
      sendResponse({ ok: true, ...state() });
      return;
    }
    if (message.type === `${MESSAGE_PREFIX}locks`) {
      if (!validLockedSteps(message.lockedSteps, sequence?.length ?? null)) {
        sendResponse({ ok: false, error: "Locked steps must be unique valid step indices." });
        return;
      }
      lockedSteps = message.lockedSteps.slice();
      notifyObservers({ lockedSteps: lockedSteps.slice() });
      sendResponse({ ok: true, ...state() });
      return;
    }
    if (message.type === `${MESSAGE_PREFIX}record`) {
      if (typeof message.key !== "string" || !/^[0-9]$/.test(message.key)) {
        sendResponse({ ok: false, error: "Enter a digit from 0 to 9." });
        return;
      }
      const video = document.querySelector(".html5-video-player")?.querySelector("video");
      if (!currentVideoId() || !video || !Number.isFinite(video.currentTime)) {
        sendResponse({ ok: false, error: "The video time is not available yet." });
        return;
      }
      sendResponse({ ok: true, timecode: video.currentTime });
      return;
    }
    if (message.type === `${MESSAGE_PREFIX}trigger`) {
      if (typeof message.key !== "string" || !/^[0-9]$/.test(message.key)) {
        sendResponse({ ok: false, error: "Enter a digit from 0 to 9." });
        return;
      }
      if (prohibitedPads.includes(message.key)) {
        sendResponse({ ok: false, error: "This pad is forbidden." });
        return;
      }
      if (message.timecode !== undefined &&
          (!Number.isFinite(message.timecode) || message.timecode < 0)) {
        sendResponse({ ok: false, error: "Enter a valid timecode." });
        return;
      }
      const player = document.querySelector(".html5-video-player");
      const video = player?.querySelector("video");
      if (!currentVideoId() || !player || !video) {
        sendResponse({ ok: false, error: "Open a YouTube video and wait for the player to load." });
        return;
      }
      const timecode = message.timecode;
      if (timecode !== undefined) video.currentTime = timecode;
      else video.currentTime = digitToTimecode(message.key, video.duration);
      if (video.paused) {
        const attempt = generation;
        const videoControlAttempt = videoControlVersion;
        video.play().then(
          () => {
            if (attempt === generation && videoControlAttempt === videoControlVersion) {
              manuallyPaused = false;
            }
            sendResponse({ ok: true });
          },
          () => sendResponse({ ok: false, error: playbackFailure })
        );
        return true;
      }
      manuallyPaused = false;
      sendResponse({ ok: true });
      return;
    }
    if (message.type === `${MESSAGE_PREFIX}seek`) {
      if (message.direction !== "backward" && message.direction !== "forward") {
        sendResponse({ ok: false, error: "Choose a valid seek direction." });
        return;
      }
      const video = document.querySelector(".html5-video-player")?.querySelector("video");
      if (!currentVideoId() || !video || !Number.isFinite(video.currentTime)) {
        sendResponse({ ok: false, error: "The video time is not available yet." });
        return;
      }
      const ranges = video.seekable;
      const start = ranges?.length ? ranges.start(0) : 0;
      const end = Number.isFinite(video.duration)
        ? video.duration
        : ranges?.length ? ranges.end(ranges.length - 1) : null;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        sendResponse({ ok: false, error: "The video seek range is not available yet." });
        return;
      }
      const offset = message.direction === "forward" ? 5 : -5;
      video.currentTime = Math.max(start, Math.min(end, video.currentTime + offset));
      sendResponse({ ok: true });
      return;
    }
    if (message.type === `${MESSAGE_PREFIX}scrub`) {
      if (typeof message.key !== "string" || !/^[0-9]$/.test(message.key)) {
        sendResponse({ ok: false, error: "Enter a digit from 0 to 9." });
        return;
      }
      if (!Number.isFinite(message.timecode) || message.timecode < 0) {
        sendResponse({ ok: false, error: "Enter a valid timecode." });
        return;
      }
      const video = document.querySelector(".html5-video-player")?.querySelector("video");
      if (!video) {
        sendResponse({ ok: false, error: "Open a YouTube video and wait for the player to load." });
        return;
      }
      video.currentTime = message.timecode;
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
        sendResponse({ ok: false, error: "Steps must be empty or a digit from 0 to 9, and BPM must be a whole number from 1 to 999." });
        return;
      }
      if (message.lockedSteps !== undefined && !validLockedSteps(message.lockedSteps, message.sequence.length)) {
        sendResponse({ ok: false, error: "Locked steps must be unique valid step indices." });
        return;
      }
      if (message.lockedSteps === undefined && !validLockedSteps(lockedSteps, message.sequence.length)) {
        sendResponse({ ok: false, error: "Unlock steps before removing them." });
        return;
      }
      if (message.prohibitedPads !== undefined && !validProhibitedPads(message.prohibitedPads)) {
        sendResponse({ ok: false, error: "Forbidden pads must be unique digits from 0 to 9." });
        return;
      }
      if (message.recordedPadTimes !== undefined && !validRecordedPadTimes(message.recordedPadTimes)) {
        sendResponse({ ok: false, error: "Recorded pad timecodes must be valid non-negative times." });
        return;
      }
      if (message.includeEmptySteps !== undefined && typeof message.includeEmptySteps !== "boolean") {
        sendResponse({ ok: false, error: "Include-empty-steps setting must be true or false." });
        return;
      }
      if (message.prohibitedPads !== undefined) setProhibitedPads(message.prohibitedPads);
      if (message.recordedPadTimes !== undefined) recordedPadTimes = { ...message.recordedPadTimes };
      if (message.includeEmptySteps !== undefined) includeEmptySteps = message.includeEmptySteps;
      if (message.lockedSteps !== undefined) lockedSteps = message.lockedSteps.slice();
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
        randomizeOnStart = message.randomize === true;
        videoId = id;
        timingDelays = 0;
        nextTime = performance.now();
        tick();
        if (!sequence) {
          sendResponse({ ok: false, error: "Could not start the sequence or metronome." });
          return;
        }
        sendResponse({ ok: true, ...state() });
      };
      if (video.paused) {
        video.play().then(start, () => {
          sendResponse({ ok: false, error: playbackFailure });
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
        if (lockedSteps.some(index => index >= message.sequence.length || message.sequence[index] !== sequence[index])) {
          sendResponse({ ok: false, error: "Unlock steps before changing or removing them." });
          return;
        }
        const previousLength = sequence.length;
        sequence = message.sequence.slice();
        if (sequence.length !== previousLength) {
          nextStep = currentStep >= sequence.length ? 0 : (currentStep + 1) % sequence.length;
        }
        if (sequence.every(value => value === "")) {
          padValue = null;
          notifyObservers({ currentStep, stepValue, padValue, stepSerial, timingDelays });
        }
      } else if (message.step !== undefined) {
        if (!Number.isInteger(message.step) || message.step < 0 || message.step >= sequence.length ||
            !validStep(message.value)) {
          sendResponse({ ok: false, error: "Steps must be empty or a digit from 0 to 9." });
          return;
        }
        if (lockedSteps.includes(message.step) && message.value !== sequence[message.step]) {
          sendResponse({ ok: false, error: "Unlock the step before changing it." });
          return;
        }
        sequence[message.step] = message.value;
      } else if (message.prohibitedPads !== undefined) {
        if (!validProhibitedPads(message.prohibitedPads)) {
          sendResponse({ ok: false, error: "Forbidden pads must be unique digits from 0 to 9." });
          return;
        }
        setProhibitedPads(message.prohibitedPads);
      } else if (message.includeEmptySteps !== undefined) {
        if (typeof message.includeEmptySteps !== "boolean") {
          sendResponse({ ok: false, error: "Include-empty-steps setting must be true or false." });
          return;
        }
        includeEmptySteps = message.includeEmptySteps;
      } else if (message.recordedPadTimes !== undefined) {
        if (!validRecordedPadTimes(message.recordedPadTimes)) {
          sendResponse({ ok: false, error: "Recorded pad timecodes must be valid non-negative times." });
          return;
        }
        recordedPadTimes = { ...message.recordedPadTimes };
      } else if (message.randomize !== undefined) {
        randomizeOnStart = message.randomize === true;
      } else if (message.bpm !== undefined) {
        if (!validBpm(message.bpm)) {
          sendResponse({ ok: false, error: "Enter a whole-number BPM from 1 to 999." });
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
