(() => {
  const MESSAGE_PREFIX = "yt-step-sequencer:";
  let timer = null;
  let sequence = null;
  let bpm = null;
  let currentStep = -1;
  let nextStep = 0;
  let nextTime = 0;
  let currentBeatTime = null;
  let previousBeatTime = null;
  let previousBeatStep = null;
  let videoId = null;
  let generation = 0;
  let stepSerial = 0;
  let stepValue = null;
  let randomizeOnStart = false;
  let prohibitedPads = [];
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
  let recordingSequence = false;
  let waitingForRecordingPad = false;
  let recordingSave = Promise.resolve();
  let recordingSaveError = null;
  const playbackFailure = "Could not start the video. Press play on YouTube and try again.";
  const observers = new Set();

  function currentVideoId() {
    const url = new URL(location.href);
    return url.pathname === "/watch" ? url.searchParams.get("v") : null;
  }

  function stop() {
    generation++;
    if (recordingSequence) metronomeEnabled = false;
    recordingSequence = false;
    waitingForRecordingPad = false;
    resumeAttempt = null;
    manuallyPaused = false;
    playbackError = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    sequence = null;
    bpm = null;
    currentStep = -1;
    currentBeatTime = null;
    previousBeatTime = null;
    previousBeatStep = null;
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
      timingDelays, playbackError, padValue, randomizeOnStart, prohibitedPads,
      includeEmptySteps, recordedPadTimes, metronomeEnabled, recordingSequence, videoId: currentVideoId(),
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
    if (choices.length === 0) return null;
    return sequence.map(() => choices[Math.floor(Math.random() * choices.length)]);
  }

  function digitToTimecode(digit, duration) {
    const keyNumber = Number(digit);
    return (duration * keyNumber) / 10;
  }

  function recordingStep(pressedAt) {
    const time = pressedAt === undefined ? performance.now() : pressedAt - performance.timeOrigin;
    if (previousBeatTime !== null && previousBeatStep < sequence.length &&
        Math.abs(time - previousBeatTime) < Math.abs(time - currentBeatTime)) {
      return previousBeatStep;
    }
    return Math.abs(time - nextTime) <= Math.abs(time - currentBeatTime) ? nextStep : currentStep;
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

  function saveRecordedSequence() {
    const snapshot = sequence.slice();
    recordingSave = recordingSave.then(async () => {
      await chrome.storage.local.set({ sequence: snapshot });
      recordingSaveError = null;
    }).catch(error => {
      recordingSaveError = error.message || "Could not save the recorded sequence.";
      console.error("Could not save the recorded sequence:", error);
      notifyObservers({ recordingError: recordingSaveError });
    });
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
      if (recordingSequence) stop();
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
    previousBeatTime = currentBeatTime;
    previousBeatStep = currentStep;
    currentBeatTime = startTime;
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
    if (!sequence) return;
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
    if (!waitingForRecordingPad && !manuallyPaused) resumeVideo(video);
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
          waitingForRecordingPad = false;
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
        if (recordingSequence) {
          sendResponse({ ok: false, error: "Stop recording before turning off the metronome." });
          return;
        }
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
      const wasRecording = recordingSequence;
      stop();
      const stopped = state();
      if (wasRecording) {
        recordingSave.then(() => sendResponse({
          ok: true, ...stopped,
          ...(recordingSaveError && { recordingError: recordingSaveError })
        }));
        return true;
      }
      sendResponse({ ok: true, ...stopped });
      return;
    }
    if (message.type === `${MESSAGE_PREFIX}finish-recording`) {
      const video = document.querySelector(".html5-video-player")?.querySelector("video");
      if (!recordingSequence || !sequence || currentVideoId() !== videoId || !video) {
        sendResponse({ ok: false, error: "The sequence is no longer recording." });
        return;
      }
      recordingSequence = false;
      waitingForRecordingPad = false;
      metronomeEnabled = false;
      notifyObservers({ ...state(), recordingFinished: true });
      if (!manuallyPaused) resumeVideo(video);
      recordingSave.then(() => sendResponse({
        ok: true, ...state(),
        ...(recordingSaveError && { recordingError: recordingSaveError })
      }));
      return true;
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
      if (message.pressedAt !== undefined &&
          (!Number.isFinite(message.pressedAt) || message.pressedAt < 0)) {
        sendResponse({ ok: false, error: "Enter a valid pad press time." });
        return;
      }
      const player = document.querySelector(".html5-video-player");
      const video = player?.querySelector("video");
      if (!currentVideoId() || !player || !video) {
        sendResponse({ ok: false, error: "Open a YouTube video and wait for the player to load." });
        return;
      }
      const recordingPad = recordingSequence && sequence && currentVideoId() === videoId && currentStep >= 0;
      if (recordingPad) {
        const recordedStep = recordingStep(message.pressedAt);
        sequence[recordedStep] = message.key;
        saveRecordedSequence();
        notifyObservers({ ...state(), sequence: sequence.slice(), recordedStep });
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
              if (recordingPad) waitingForRecordingPad = false;
            }
            sendResponse({ ok: true });
          },
          () => sendResponse({ ok: false, error: playbackFailure })
        );
        return true;
      }
      manuallyPaused = false;
      if (recordingPad) waitingForRecordingPad = false;
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
      if (message.recordingSequence !== undefined && typeof message.recordingSequence !== "boolean") {
        sendResponse({ ok: false, error: "Recording setting must be on or off." });
        return;
      }
      if (message.recordingSequence && !metronomeEnabled) {
        sendResponse({ ok: false, error: "Enable the metronome before recording." });
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
      const startRecording = message.recordingSequence === true;
      stop();
      if (startRecording) metronomeEnabled = true;
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
        recordingSequence = startRecording;
        waitingForRecordingPad = startRecording;
        if (recordingSequence) recordingSaveError = null;
        randomizeOnStart = !recordingSequence && message.randomize === true;
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
      if (startRecording) {
        if (!video.paused) video.pause();
        start();
        return;
      }
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
        if (recordingSequence && message.randomize === true) {
          sendResponse({ ok: false, error: "Stop recording before enabling automatic randomization." });
          return;
        }
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
      if (recordingSequence && (message.sequence !== undefined || message.step !== undefined)) {
        saveRecordedSequence();
      }
      sendResponse({ ok: true, ...state() });
    }
  });
})();
