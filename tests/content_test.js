import { strict as assert } from "node:assert";
import { runInNewContext } from "node:vm";

const source = await Deno.readTextFile(new URL("../content.js", import.meta.url));

function setup({ random = Math.random } = {}) {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const events = [];
  const handlers = {};
  const location = { href: "https://www.youtube.com/watch?v=first" };
  const video = { paused: false, muted: false, currentTime: 0, duration: 100, play: () => Promise.resolve() };
  let player = {
    dispatchEvent: event => events.push(event),
    querySelector: selector => selector === "video" ? video : null
  };
  let listener;
  let connectListener;

  class KeyboardEvent {
    constructor(type, options) {
      this.type = type;
      Object.assign(this, options);
    }
  }

  const math = Object.create(Math);
  math.random = random;
  runInNewContext(source, {
    URL, location, KeyboardEvent, Math: math,
    performance: { now: () => now },
    document: {
      querySelector: () => player,
      addEventListener: (type, handler) => { handlers[type] = handler; }
    },
    chrome: { runtime: {
      onMessage: { addListener: fn => { listener = fn; } },
      onConnect: { addListener: fn => { connectListener = fn; } }
    } },
    console,
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id)
  });

  return {
    events, location, video,
    connect() {
      const updates = [];
      let disconnect;
      connectListener({
        name: "yt-step-sequencer:steps",
        postMessage: message => updates.push(message),
        onDisconnect: { addListener: fn => { disconnect = fn; } }
      });
      return { updates, disconnect: () => disconnect() };
    },
    send(type, data = {}) {
      let response;
      listener({ type: `yt-step-sequencer:${type}`, ...data }, {}, value => { response = value; });
      return response;
    },
    sendAsync(type, data = {}) {
      return new Promise(resolve => {
        listener({ type: `yt-step-sequencer:${type}`, ...data }, {}, resolve);
      });
    },
    advance(time) {
      now = time;
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= now);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
    },
    navigate(url) {
      location.href = url;
      handlers["yt-navigate-finish"]();
    },
    removePlayer() { player = null; },
    removeVideo() { player.querySelector = () => null; },
    pending() { return timers.size; }
  };
}

const sequence = ["0", "1", "2", "3", "4", "5", "6", "9"];

Deno.test("pad follows sequenced digits through empty steps and ignores video time and manual pads", () => {
  const app = setup();
  const observer = app.connect();
  app.video.currentTime = 90;
  app.send("play", { sequence: ["", "2", "", "", "7", "", "", ""], bpm: 120 });
  assert.equal(observer.updates.at(-1).padValue, null);
  assert.equal(app.send("status").padValue, null);
  app.advance(500);
  assert.equal(observer.updates.at(-1).padValue, "2");
  app.video.currentTime = 0;
  app.send("trigger", { key: "9" });
  app.send("update", { step: 1, value: "5" });
  app.advance(1000);
  assert.equal(observer.updates.at(-1).padValue, "2");
  assert.equal(app.send("status").padValue, "2");
  app.advance(1500);
  assert.equal(observer.updates.at(-1).padValue, "2");
  app.advance(2000);
  assert.equal(observer.updates.at(-1).padValue, "7");
  assert.equal(app.send("stop").padValue, null);
});

Deno.test("an all-empty sequence has no active pad and restarts clear the previous pad", () => {
  const app = setup();
  app.send("play", { sequence, bpm: 120 });
  assert.equal(app.send("status").padValue, "0");
  app.send("play", { sequence: Array(8).fill(""), bpm: 120 });
  for (let i = 1; i <= 8; i++) app.advance(i * 500);
  assert.equal(app.send("status").padValue, null);
});

Deno.test("clearing the live pattern clears the pad for all observers without restarting", () => {
  const app = setup();
  const first = app.connect();
  const second = app.connect();
  app.send("play", { sequence, bpm: 120 });
  app.advance(500);
  const previous = app.send("status");
  assert.equal(previous.padValue, "1");
  const cleared = app.send("update", { sequence: Array(8).fill("") });
  assert.equal(cleared.playing, true);
  assert.equal(cleared.currentStep, previous.currentStep);
  assert.equal(cleared.stepSerial, previous.stepSerial);
  assert.equal(cleared.bpm, previous.bpm);
  assert.equal(cleared.padValue, null);
  assert.equal(first.updates.at(-1).padValue, null);
  assert.equal(second.updates.at(-1).padValue, null);
  assert.equal(app.pending(), 1);
  app.advance(1000);
  assert.equal(app.send("status").padValue, null);
  assert.equal(app.events.length, 4);
  app.send("update", { step: 3, value: "7" });
  app.advance(1500);
  assert.equal(app.send("status").padValue, "7");
});

Deno.test("starting a paused video awaits playback before the first step", async () => {
  const app = setup();
  app.video.paused = true;
  let resolvePlay;
  app.video.play = () => new Promise(resolve => { resolvePlay = resolve; });
  const response = app.sendAsync("play", { sequence, bpm: 120 });
  assert.equal(app.events.length, 0);
  app.video.paused = false;
  resolvePlay();
  const state = await response;
  assert.equal(state.playing, true);
  assert.equal(app.events[0].key, "0");
  app.send("stop");
  assert.equal(app.pending(), 0);
});

Deno.test("already playing video is not restarted", () => {
  const app = setup();
  let calls = 0;
  app.video.play = () => { calls++; return Promise.resolve(); };
  assert.equal(app.send("play", { sequence, bpm: 120 }).playing, true);
  assert.equal(calls, 0);
});

Deno.test("starting on an empty step leaves mute unchanged on success, failure and cancellation", async () => {
  for (const outcome of ["play", "reject", "stop", "navigate"]) {
    const app = setup();
    app.video.paused = true;
    let resolvePlay;
    let rejectPlay;
    app.video.play = () => {
      assert.equal(app.video.muted, false);
      return new Promise((resolve, reject) => { resolvePlay = resolve; rejectPlay = reject; });
    };
    const response = app.sendAsync("play", { sequence: ["", ...sequence.slice(1)], bpm: 120 });
    if (outcome === "stop") app.send("stop");
    if (outcome === "navigate") app.navigate("https://www.youtube.com/watch?v=other");
    if (outcome === "reject") rejectPlay(new Error("blocked"));
    else {
      app.video.paused = false;
      resolvePlay();
    }
    assert.equal((await response).ok, outcome === "play");
    assert.equal(app.events.length, 0);
    if (outcome === "play") app.send("stop");
    assert.equal(app.video.muted, false);
  }
});

Deno.test("playback failure is reported without starting the sequence", async () => {
  const app = setup();
  app.video.paused = true;
  app.video.play = () => Promise.reject(new Error("blocked"));
  const result = await app.sendAsync("play", { sequence, bpm: 120 });
  assert.equal(result.ok, false);
  assert.match(result.error, /Could not start the video/);
  assert.equal(app.events.length, 0);
  assert.equal(app.pending(), 0);
});

Deno.test("stop or navigation cancels a pending video start", async () => {
  for (const cancel of [app => app.send("stop"), app => app.navigate("https://www.youtube.com/watch?v=other")]) {
    const app = setup();
    app.video.paused = true;
    let resolvePlay;
    app.video.play = () => new Promise(resolve => { resolvePlay = resolve; });
    const response = app.sendAsync("play", { sequence, bpm: 120 });
    cancel(app);
    resolvePlay();
    assert.equal((await response).ok, false);
    assert.equal(app.events.length, 0);
    assert.equal(app.pending(), 0);
  }
});

Deno.test("a paused video resumes during the sequence, including on empty steps", async () => {
  for (const step of ["1", ""]) {
    const app = setup();
    app.send("play", { sequence: ["0", step, ...sequence.slice(2)], bpm: 120 });
    app.video.paused = true;
    let calls = 0;
    let resolvePlay;
    app.video.play = () => {
      calls++;
      return new Promise(resolve => { resolvePlay = resolve; });
    };
    app.advance(500);
    assert.equal(calls, 1);
    assert.equal(app.events.length, step ? 4 : 2);
    app.advance(1000);
    assert.equal(calls, 1);
    assert.equal(app.send("status").playing, true);
    app.video.paused = false;
    resolvePlay();
    await Promise.resolve();
    app.advance(1500);
    assert.equal(calls, 1);
    assert.equal(app.send("status").currentStep, 3);
    app.send("stop");
  }
});

Deno.test("blocked resumption stops the sequence and reports the error to observers and status", async () => {
  const app = setup();
  const observer = app.connect();
  app.send("play", { sequence, bpm: 120 });
  app.video.paused = true;
  app.video.play = () => Promise.reject(new Error("blocked"));
  app.advance(500);
  await Promise.resolve();
  const state = app.send("status");
  assert.equal(state.playing, false);
  assert.match(state.playbackError, /Could not start the video/);
  assert.equal(observer.updates.at(-1).playbackError, state.playbackError);
  assert.equal(app.pending(), 0);
  app.video.paused = false;
  assert.equal(app.send("play", { sequence, bpm: 120 }).playbackError, null);
});

Deno.test("an old resume failure cannot stop a later sequence", async () => {
  const app = setup();
  app.send("play", { sequence, bpm: 120 });
  app.video.paused = true;
  let rejectPlay;
  app.video.play = () => new Promise((_resolve, reject) => { rejectPlay = reject; });
  app.advance(500);
  app.send("stop");
  app.video.paused = false;
  app.send("play", { sequence, bpm: 120 });
  rejectPlay(new Error("cancelled"));
  await Promise.resolve();
  assert.equal(app.send("status").playing, true);
  assert.equal(app.send("status").playbackError, null);
  assert.equal(app.pending(), 1);
});

Deno.test("plays eight keyboard events at one step per beat and loops", () => {
  const app = setup();
  const state = app.send("play", { sequence, bpm: 120 });
  assert.equal(state.playing, true);
  assert.equal(state.currentStep, 0);
  assert.equal(app.events[0].type, "keydown");
  assert.equal(app.events[0].key, "0");
  assert.equal(app.events[0].code, "Digit0");
  assert.equal(app.events[0].keyCode, 48);
  assert.equal(app.events[0].which, 48);
  assert.equal(app.events[0].bubbles, true);
  assert.equal(app.events[1].type, "keyup");
  for (let i = 1; i <= 8; i++) app.advance(i * 500);
  assert.deepEqual(app.events.filter(event => event.type === "keydown").map(event => event.key),
    [...sequence, "0"]);
  assert.equal(app.send("status").currentStep, 0);
});

Deno.test("empty steps continue playback without seeking or changing mute", () => {
  const app = setup();
  const observer = app.connect();
  const pattern = ["", "", "2", "", "4", "5", "6", "9"];
  assert.equal(app.send("play", { sequence: pattern, bpm: 120 }).playing, true);
  assert.equal(app.video.muted, false);
  assert.equal(app.events.length, 0);
  app.advance(500);
  assert.equal(app.video.muted, false);
  assert.equal(app.events.length, 0);
  app.advance(1000);
  assert.equal(app.video.muted, false);
  assert.equal(app.events[0].key, "2");
  app.advance(1500);
  assert.equal(app.video.muted, false);
  assert.equal(app.events.length, 2);
  assert.deepEqual(observer.updates.map(update => update.currentStep), [0, 1, 2, 3]);
  app.send("stop");
  assert.equal(app.video.muted, false);
});

Deno.test("empty steps leave mute settings unchanged during playback and navigation", () => {
  const app = setup();
  app.video.muted = true;
  app.send("play", { sequence: ["", "1", "2", "3", "4", "5", "6", "9"], bpm: 120 });
  app.advance(500);
  assert.equal(app.video.muted, true);
  app.send("stop");
  assert.equal(app.video.muted, true);
  app.video.muted = false;
  app.send("play", { sequence: Array(8).fill(""), bpm: 120 });
  assert.equal(app.video.muted, false);
  app.navigate("https://www.youtube.com/watch?v=other");
  assert.equal(app.video.muted, false);
});

Deno.test("mute changes during consecutive empty steps are preserved", () => {
  const app = setup();
  app.video.muted = true;
  app.send("play", { sequence: ["", "", "2", "3", "4", "5", "6", "9"], bpm: 120 });
  app.video.muted = false;
  app.advance(500);
  assert.equal(app.video.muted, false);
  app.advance(1000);
  assert.equal(app.video.muted, false);
});

Deno.test("live empty steps and an all-empty pattern keep timing and pads working", () => {
  const app = setup();
  app.send("play", { sequence, bpm: 120 });
  assert.equal(app.send("update", { step: 1, value: "" }).ok, true);
  app.advance(500);
  assert.equal(app.video.muted, false);
  assert.equal(app.events.length, 2);
  assert.equal(app.send("trigger", { key: "9" }).ok, true);
  assert.equal(app.video.muted, false);
  assert.equal(app.events[2].key, "9");
  assert.equal(app.send("update", { sequence: Array(8).fill("") }).ok, true);
  app.advance(1000);
  assert.equal(app.video.muted, false);
  assert.equal(app.send("status").currentStep, 2);
  assert.equal(app.pending(), 1);
  app.send("stop");
  assert.equal(app.video.muted, false);
});

Deno.test("delayed beats preserve step order without firing a burst", () => {
  const app = setup();
  app.send("play", { sequence, bpm: 120 });
  app.advance(1700);
  assert.equal(app.events.length, 4);
  assert.equal(app.send("status").currentStep, 1);
  assert.equal(app.send("status").timingDelays, 1);
  app.advance(2000);
  assert.equal(app.events.length, 4);
  app.advance(2200);
  assert.equal(app.events[4].key, "2");
});

Deno.test("step observers receive every dispatched beat, including at 999 BPM", () => {
  const app = setup();
  const observer = app.connect();
  app.send("play", { sequence, bpm: 999 });
  for (let i = 1; i < 16; i++) app.advance(i * 60000 / 999 + 0.001);
  assert.deepEqual(observer.updates.map(update => update.currentStep),
    [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(observer.updates.at(-1).timingDelays, 0);
  observer.disconnect();
  app.advance(16 * 60000 / 999 + 0.001);
  assert.equal(observer.updates.length, 16);
});

Deno.test("step events and state carry the executed value, not later edits", () => {
  const app = setup();
  const observer = app.connect();
  app.send("play", { sequence: ["0", "", ...sequence.slice(2)], bpm: 120 });
  assert.equal(observer.updates[0].stepValue, "0");
  assert.equal(app.send("status").stepValue, "0");
  app.send("update", { step: 0, value: "9" });
  assert.equal(app.send("status").stepValue, "0");
  app.send("update", { step: 2, value: "8" });
  app.advance(500);
  assert.equal(observer.updates[1].stepValue, "");
  assert.equal(app.send("status").stepValue, "");
  app.advance(1000);
  assert.equal(observer.updates[2].stepValue, "8");
  assert.equal(app.events.at(-1).key, "8");
  assert.equal(app.send("stop").stepValue, null);
});

Deno.test("a delayed timer is reported and the counter resets on restart", () => {
  const app = setup();
  const observer = app.connect();
  app.send("play", { sequence, bpm: 120 });
  app.advance(1500);
  assert.equal(observer.updates.at(-1).timingDelays, 1);
  app.send("stop");
  app.send("play", { sequence, bpm: 120 });
  assert.equal(observer.updates.at(-1).timingDelays, 0);
});

Deno.test("stop and navigation cancel the timer", () => {
  const app = setup();
  app.send("play", { sequence, bpm: 120 });
  app.send("stop");
  assert.equal(app.pending(), 0);
  app.advance(500);
  assert.equal(app.events.length, 2);
  app.send("play", { sequence, bpm: 120 });
  app.navigate("https://www.youtube.com/watch?v=second");
  assert.equal(app.send("status").playing, false);
  assert.equal(app.pending(), 0);
});

Deno.test("rejects malformed settings and non-video pages", () => {
  const app = setup();
  for (const data of [
    { sequence: [], bpm: 120 },
    { sequence: [...sequence.slice(0, 7), "10"], bpm: 120 },
    { sequence, bpm: 0 },
    { sequence, bpm: 1000 },
    { sequence, bpm: 120.5 }
  ]) {
    assert.equal(app.send("play", data).ok, false);
  }
  assert.equal(app.events.length, 0);
  app.navigate("https://www.youtube.com/");
  assert.equal(app.send("play", { sequence, bpm: 120 }).ok, false);
});

Deno.test("stops if the player disappears", () => {
  const app = setup();
  app.send("play", { sequence, bpm: 120 });
  app.removePlayer();
  app.advance(500);
  assert.equal(app.send("status").playing, false);
  assert.equal(app.pending(), 0);
});

Deno.test("status reports when the original tab is not on a video", () => {
  const app = setup();
  app.send("play", { sequence, bpm: 120 });
  app.navigate("https://www.youtube.com/");
  assert.equal(app.send("status").ok, false);
  assert.equal(app.pending(), 0);
});

Deno.test("live pads dispatch digit events with or without a running sequence", () => {
  const app = setup();
  assert.equal(app.send("trigger", { key: "9" }).ok, true);
  assert.equal(app.events[0].type, "keydown");
  assert.equal(app.events[0].key, "9");
  assert.equal(app.events[0].code, "Digit9");
  assert.equal(app.events[0].keyCode, 57);
  assert.equal(app.events[1].type, "keyup");
  app.send("play", { sequence, bpm: 120 });
  assert.equal(app.send("trigger", { key: "0" }).ok, true);
  assert.equal(app.send("status").playing, true);
  assert.equal(app.pending(), 1);
  app.advance(500);
  assert.equal(app.events[6].key, "1");
});

Deno.test("live pads seek immediately and resume a paused video", async () => {
  for (const running of [false, true]) {
    const app = setup();
    if (running) app.send("play", { sequence, bpm: 120 });
    app.video.paused = true;
    let resolvePlay;
    let calls = 0;
    app.video.play = () => {
      calls++;
      return new Promise(resolve => { resolvePlay = resolve; });
    };
    const eventCount = app.events.length;
    const response = app.sendAsync("trigger", { key: "9" });
    assert.equal(calls, 1);
    assert.equal(app.events[eventCount].key, "9");
    assert.equal(app.events[eventCount + 1].type, "keyup");
    resolvePlay();
    assert.equal((await response).ok, true);
    assert.equal(app.send("status").playing, running);
    assert.equal(app.pending(), running ? 1 : 0);
  }
});

Deno.test("live pads report failed playback and preserve rapid seek order", async () => {
  const app = setup();
  app.video.paused = true;
  const plays = [];
  app.video.play = () => new Promise((resolve, reject) => plays.push({ resolve, reject }));
  const first = app.sendAsync("trigger", { key: "1" });
  const second = app.sendAsync("trigger", { key: "2" });
  assert.deepEqual(app.events.filter(event => event.type === "keydown").map(event => event.key), ["1", "2"]);
  plays[1].resolve();
  plays[0].reject(new Error("blocked"));
  assert.equal((await second).ok, true);
  const failure = await first;
  assert.equal(failure.ok, false);
  assert.match(failure.error, /Could not start the video/);
});

Deno.test("live pads do not restart already playing video", () => {
  const app = setup();
  app.video.play = () => { throw new Error("unexpected play"); };
  assert.equal(app.send("trigger", { key: "5" }).ok, true);
});

Deno.test("recorded pad times seek exactly on live pads and sequencer steps", () => {
  const app = setup();
  app.video.currentTime = 42.375;
  const recorded = app.send("record", { key: "8" });
  assert.equal(recorded.timecode, 42.375);
  app.video.currentTime = 0;
  assert.equal(app.send("trigger", { key: "8", timecode: recorded.timecode }).ok, true);
  assert.equal(app.video.currentTime, 42.375);
  assert.equal(app.events.length, 0);

  const state = app.send("play", {
    sequence: ["2", ...sequence.slice(1)], bpm: 120, recordedPadTimes: { "2": 18.625 }
  });
  assert.equal(state.padValue, "2");
  assert.equal(app.video.currentTime, 18.625);
  assert.equal(app.events.length, 0);
  assert.equal(app.send("status").videoDuration, 100);
});

Deno.test("recorded pad times can be updated while the sequence is playing", () => {
  const app = setup();
  app.send("play", { sequence: ["0", "2", ...sequence.slice(2)], bpm: 120 });
  assert.equal(app.send("update", { recordedPadTimes: { "2": 18.625 } }).ok, true);
  app.advance(500);
  assert.equal(app.video.currentTime, 18.625);
  assert.equal(app.events.length, 2);
});

Deno.test("live pads reject invalid digits and missing players", () => {
  const app = setup();
  for (const key of ["", "10", "x", 1, null]) {
    assert.equal(app.send("trigger", { key }).ok, false);
  }
  app.removePlayer();
  assert.equal(app.send("trigger", { key: "1" }).ok, false);
  assert.equal(app.events.length, 0);
  const noVideo = setup();
  noVideo.removeVideo();
  assert.equal(noVideo.send("trigger", { key: "1" }).ok, false);
  assert.equal(noVideo.events.length, 0);
  app.navigate("https://www.youtube.com/");
  assert.equal(app.send("trigger", { key: "1" }).ok, false);
});

Deno.test("live step edits take effect without restarting the pattern", () => {
  const app = setup();
  app.send("play", { sequence, bpm: 120 });
  app.advance(250);
  const state = app.send("update", { step: 1, value: "9" });
  assert.equal(state.currentStep, 0);
  assert.equal(state.sequence[1], "9");
  assert.equal(app.pending(), 1);
  app.advance(500);
  assert.equal(app.events[2].key, "9");
  assert.equal(app.send("status").currentStep, 1);
});

Deno.test("replacing the pattern during playback preserves position, tempo and timing", () => {
  const app = setup();
  app.send("play", { sequence, bpm: 120 });
  app.advance(250);
  const replacement = ["9", "8", "7", "6", "5", "4", "3", "2"];
  const state = app.send("update", { sequence: replacement });
  assert.equal(state.currentStep, 0);
  assert.equal(state.bpm, 120);
  assert.deepEqual([...state.sequence], replacement);
  assert.equal(app.pending(), 1);
  replacement[1] = "0";
  app.advance(500);
  assert.equal(app.events[2].key, "8");
});

Deno.test("resizing a live sequence continues with the next valid step", () => {
  const app = setup();
  const observer = app.connect();
  app.send("play", { sequence: ["1", "2"], bpm: 120 });
  app.advance(500);
  assert.equal(app.send("update", { sequence: ["1", "2", "3"] }).ok, true);
  app.advance(1000);
  assert.equal(observer.updates.at(-1).stepValue, "3");
  assert.equal(app.send("update", { sequence: ["1"] }).ok, true);
  app.advance(1500);
  assert.equal(observer.updates.at(-1).stepValue, "1");
  app.advance(2000);
  assert.equal(observer.updates.at(-1).stepValue, "1");
  app.send("stop");
});

Deno.test("randomization preserves a sequence longer than eight steps", () => {
  const app = setup({ random: () => 0 });
  const pattern = Array(12).fill("1");
  const state = app.send("play", { sequence: pattern, bpm: 120, randomize: true });
  assert.equal(state.sequence.length, 12);
  for (let step = 1; step <= 12; step++) app.advance(step * 500);
  assert.equal(app.send("status").currentStep, 0);
  app.send("stop");
});

Deno.test("rejects invalid replacement patterns without changing playback", () => {
  const app = setup();
  app.send("play", { sequence, bpm: 120 });
  for (const replacement of [[], [...sequence.slice(0, 7), "10"], "12345678"]) {
    assert.equal(app.send("update", { sequence: replacement }).ok, false);
  }
  assert.deepEqual([...app.send("status").sequence], sequence);
  assert.equal(app.pending(), 1);
  app.advance(500);
  assert.equal(app.events[2].key, "1");
});

Deno.test("live BPM changes preserve the remaining fraction of the beat", () => {
  const app = setup();
  app.send("play", { sequence, bpm: 120 });
  app.advance(250);
  const state = app.send("update", { bpm: 60 });
  assert.equal(state.currentStep, 0);
  assert.equal(state.bpm, 60);
  assert.equal(app.pending(), 1);
  app.advance(749);
  assert.equal(app.events.length, 2);
  app.advance(750);
  assert.equal(app.events[2].key, "1");
  app.advance(1750);
  assert.equal(app.events[4].key, "2");
});

Deno.test("invalid live edits leave the existing pattern and timer intact", () => {
  const app = setup();
  assert.equal(app.send("update", { bpm: 60 }).ok, false);
  app.send("play", { sequence, bpm: 120 });
  for (const data of [
    { step: -1, value: "1" },
    { step: 8, value: "1" },
    { step: 1, value: "x" },
    { bpm: 0 },
    { bpm: 1000 },
    {}
  ]) {
    assert.equal(app.send("update", data).ok, false);
  }
  assert.equal(app.send("status").bpm, 120);
  assert.equal(app.send("status").sequence[1], "1");
  assert.equal(app.pending(), 1);
  app.advance(500);
  assert.equal(app.events[2].key, "1");
});

Deno.test("randomize on step 1 reshuffles the sequence each loop", () => {
  const app = setup();
  const observer = app.connect();
  const sequence = Array(8).fill("1");
  const state = app.send("play", { sequence, bpm: 120, randomize: true });
  assert.equal(state.randomizeOnStart, true);
  assert.equal(observer.updates[0].randomized, true);
  assert.equal(observer.updates[0].sequence.length, 8);
  app.advance(500);
  assert.equal(observer.updates[1].randomized, undefined);
  app.send("update", { randomize: false });
  for (let i = 2; i <= 8; i++) app.advance(500 * i);
  assert.equal(observer.updates.at(-1).currentStep, 0);
  assert.equal(observer.updates.at(-1).randomized, undefined);
  app.send("stop");
});

Deno.test("automatic step randomization preserves recorded pad times", () => {
  const app = setup({ random: () => 0.25 });
  const observer = app.connect();
  const state = app.send("play", {
    sequence, bpm: 120, randomize: true, randomizePadTimecodes: true,
    recordedPadTimes: { "2": 18.625 }
  });
  assert.equal(state.sequence[0], "2");
  assert.equal(app.video.currentTime, 18.625);
  assert.equal(app.events.length, 0);
  for (let step = 1; step <= 8; step++) app.advance(step * 500);
  assert.equal(observer.updates.at(-1).randomized, true);
  assert.equal(app.video.currentTime, 18.625);
  assert.deepEqual({ ...app.send("status").recordedPadTimes }, { "2": 18.625 });
  app.send("stop");
});

Deno.test("forbidden pads cannot be triggered or played by the sequence", () => {
  const app = setup();
  assert.equal(app.send("prohibited", { prohibitedPads: ["1"] }).ok, true);
  assert.equal(app.send("trigger", { key: "1" }).ok, false);
  assert.equal(app.events.length, 0);
  app.send("play", { sequence: ["1", "2", "", "3", "4", "5", "6", "9"], bpm: 120 });
  assert.equal(app.events.length, 0);
  app.advance(500);
  assert.equal(app.events[0].key, "2");
  assert.equal(app.events.some(event => event.key === "1"), false);
});

Deno.test("forbidding the currently active pad mutes it immediately during playback", () => {
  const app = setup();
  const observer = app.connect();
  app.send("play", { sequence, bpm: 120 });
  assert.equal(app.send("status").padValue, "0");
  app.send("prohibited", { prohibitedPads: ["0"] });
  assert.equal(app.send("status").padValue, null);
  assert.equal(observer.updates.at(-1).padValue, null);
  app.advance(500);
  assert.equal(app.events.at(-2).key, "1");
});

Deno.test("forbidden pads are excluded from loop randomization", () => {
  const app = setup({ random: () => 0 });
  const observer = app.connect();
  const state = app.send("play", {
    sequence: Array(8).fill("1"), bpm: 120, randomize: true, prohibitedPads: ["0", "1"]
  });
  assert.equal(state.sequence.every(key => key === "2"), true);
  assert.equal(observer.updates[0].sequence.every(key => key === "2"), true);
  app.send("stop");
});

Deno.test("loop randomization includes empty steps only when enabled", () => {
  const withEmptySteps = setup({ random: () => 0.999 });
  const included = withEmptySteps.send("play", {
    sequence: Array(8).fill("1"), bpm: 120, randomize: true, includeEmptySteps: true
  });
  assert.equal(included.sequence.every(value => value === ""), true);
  withEmptySteps.send("stop");

  const withoutEmptySteps = setup({ random: () => 0.999 });
  const excluded = withoutEmptySteps.send("play", {
    sequence: Array(8).fill("1"), bpm: 120, randomize: true, includeEmptySteps: false
  });
  assert.equal(excluded.sequence.every(value => value === "9"), true);
  withoutEmptySteps.send("stop");
});

Deno.test("include-empty setting updates live loop randomization", () => {
  const app = setup({ random: () => 0.999 });
  app.send("play", { sequence: Array(8).fill("1"), bpm: 120, randomize: true });
  assert.equal(app.send("status").sequence.every(value => value === ""), true);
  assert.equal(app.send("update", { includeEmptySteps: false }).ok, true);
  for (let step = 1; step <= 8; step++) app.advance(step * 500);
  assert.equal(app.send("status").sequence.every(value => value === "9"), true);
  app.send("stop");
});

Deno.test("forbidden pad lists reject invalid values without changing current settings", () => {
  const app = setup();
  app.send("prohibited", { prohibitedPads: ["2"] });
  for (const prohibitedPads of [["x"], ["2", "2"], Array(11).fill("2"), "2"]) {
    assert.equal(app.send("prohibited", { prohibitedPads }).ok, false);
  }
  assert.deepEqual([...app.send("status").prohibitedPads], ["2"]);
});
