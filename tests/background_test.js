import { strict as assert } from "node:assert";
import { runInNewContext } from "node:vm";

const source = await Deno.readTextFile(new URL("../background.js", import.meta.url));

function setup({ sourceWindow, displays, create = async () => {}, remove = async () => {}, open = [], saved = {} }) {
  let handler;
  let messageHandler;
  let windowRemoved;
  let tabRemoved;
  const windows = [];
  const errors = [];
  const updated = [];
  const removed = [];
  const stopped = [];
  const store = JSON.parse(JSON.stringify(saved));
  const cleared = [];
  let now = 0;
  runInNewContext(source, {
    performance: { timeOrigin: 1000000, now: () => now },
    chrome: {
      action: { onClicked: { addListener: fn => { handler = fn; } } },
      windows: {
        get: async () => sourceWindow,
        getAll: async () => open,
        update: async (id, options) => { updated.push({ id, options }); },
        remove: async id => { removed.push(id); await remove(id); windowRemoved(id); },
        onRemoved: { addListener: fn => { windowRemoved = fn; } },
        create: async options => { windows.push(options); await create(options); }
      },
      tabs: {
        onRemoved: { addListener: fn => { tabRemoved = fn; } },
        sendMessage: async (id, message) => { stopped.push({ id, message }); }
      },
      storage: {
        session: {
          get: async key => ({ [key]: store[key] }),
          set: async value => Object.assign(store, value),
          remove: async key => { delete store[key]; }
        },
        local: { remove: async keys => { cleared.push([...keys]); } }
      },
      runtime: {
        getURL: path => `chrome-extension://abc/${path}`,
        onConnect: { addListener() {} },
        onMessage: { addListener: fn => { messageHandler = fn; } }
      },
      system: { display: { getInfo: async () => displays } }
    },
    console: { error: (...args) => errors.push(args), warn() {} }
  });
  return {
    handler, windows, errors, updated, removed, stopped, cleared,
    advance: time => { now = time; },
    send: (type, data = {}) => new Promise(resolve =>
      messageHandler({ type: `yt-step-sequencer:chorus-${type}`, ...data }, {}, resolve)),
    closeAll: windowId => new Promise(resolve =>
      messageHandler({ type: "yt-step-sequencer:close-all-windows", windowId }, {}, resolve)),
    removeWindow: windowRemoved,
    removeTab: tabRemoved
  };
}

const primary = {
  isPrimary: true,
  bounds: { left: 0, top: 0, width: 1440, height: 900 },
  workArea: { left: 0, top: 25, width: 1440, height: 835 }
};
const second = {
  isPrimary: false,
  bounds: { left: -1920, top: 0, width: 1920, height: 1080 },
  workArea: { left: -1920, top: 30, width: 1920, height: 1000 }
};

Deno.test("centers the sequencer in the video tab's display work area", async () => {
  const app = setup({
    sourceWindow: { left: -1700, top: 200, width: 1000, height: 700 },
    displays: [primary, second]
  });
  await app.handler({ id: 42, windowId: 7 });
  assert.equal(app.windows.length, 1);
  const result = app.windows[0];
  assert.equal(result.url, "popup.html?tabId=42");
  assert.equal(result.type, "popup");
  assert.equal(result.width, 412);
  assert.equal(result.height, 460);
  assert.equal(result.left, -1166);
  assert.equal(result.top, 300);
  assert.equal(app.errors.length, 0);
});

Deno.test("uses primary display when window center is outside known displays", async () => {
  const app = setup({
    sourceWindow: { left: 5000, top: 5000, width: 200, height: 200 },
    displays: [second, primary]
  });
  await app.handler({ id: 1, windowId: 7 });
  assert.equal(app.windows[0].left, 514);
  assert.equal(app.windows[0].top, 213);
});

Deno.test("fits the sequencer to a small work area", async () => {
  const app = setup({
    sourceWindow: { left: 0, top: 0, width: 100, height: 100 },
    displays: [{ isPrimary: true, bounds: { left: 0, top: 0, width: 300, height: 400 },
      workArea: { left: 0, top: 20, width: 300, height: 350 } }]
  });
  await app.handler({ id: 1, windowId: 7 });
  assert.equal(app.windows[0].width, 300);
  assert.equal(app.windows[0].height, 350);
  assert.equal(app.windows[0].left, 0);
  assert.equal(app.windows[0].top, 20);
});

Deno.test("reports window creation errors", async () => {
  const app = setup({
    sourceWindow: { left: 0, top: 0, width: 100, height: 100 },
    displays: [primary],
    create: async () => { throw new Error("failed"); }
  });
  await app.handler({});
  await app.handler({ id: 42, windowId: 7 });
  assert.equal(app.errors.length, 2);
});

Deno.test("brings all existing sequencer windows forward without opening another", async () => {
  const app = setup({
    sourceWindow: { left: 0, top: 0, width: 800, height: 600 },
    displays: [primary],
    open: [
      { id: 5, state: "normal", tabs: [{ url: "chrome-extension://abc/popup.html?tabId=41" }] },
      { id: 6, state: "minimized", tabs: [{ url: "chrome-extension://abc/popup.html?tabId=42" }] },
      { id: 7, tabs: [{ url: "chrome-extension://abc/popup.html" }] },
      { id: 8, tabs: [{ url: "chrome-extension://abc/popup.html-other" }] },
      { id: 9, tabs: [{ url: "chrome-extension://other/popup.html" }] }
    ]
  });
  await app.handler({ id: 99, windowId: 7 });
  assert.deepEqual(app.updated.map(item => item.id), [5, 6, 7]);
  assert.ok(app.updated.every(item => item.options.focused));
  assert.equal(app.updated[1].options.state, "normal");
  assert.equal(app.updated[0].options.state, undefined);
  assert.equal(app.windows.length, 0);
});

Deno.test("close all removes only sequencer windows and cleans up voices", async () => {
  const app = setup({
    sourceWindow: {}, displays: [],
    open: [
      { id: 5, tabs: [{ url: "chrome-extension://abc/popup.html?tabId=11" }] },
      { id: 6, tabs: [{ url: "chrome-extension://abc/popup.html" }] },
      { id: 7, tabs: [{ url: "https://www.youtube.com/watch?v=other" }] },
      { id: 8, tabs: [{ url: "chrome-extension://other/popup.html" }] }
    ]
  });
  await app.send("register", { windowId: 5, tabId: 11, videoId: "a" });
  await app.send("register", { windowId: 6, tabId: 12, videoId: "b" });
  await app.send("transport", { playing: true });
  assert.equal((await app.closeAll(5)).ok, true);
  assert.deepEqual(app.removed, [6, 5]);
  const state = await app.send("get");
  assert.equal(Object.keys(state.session.voices).length, 0);
  assert.deepEqual(app.stopped.map(item => item.id), [12, 11]);
  assert.ok(app.cleared[0].includes("recordedPadTimesByVideo"));
});

Deno.test("close all reports failures and keeps the initiating window open", async () => {
  const app = setup({
    sourceWindow: {}, displays: [],
    open: [5, 6, 7].map(id => ({ id, tabs: [{ url: "chrome-extension://abc/popup.html" }] })),
    remove: async id => { if (id === 6) throw new Error("blocked"); }
  });
  const result = await app.closeAll(5);
  assert.equal(result.ok, false);
  assert.match(result.error, /could not close all/i);
  assert.deepEqual(app.removed, [6, 7]);
  assert.equal(app.errors.length, 1);
  assert.equal((await app.closeAll(99)).ok, false);
});

Deno.test("chorus shares transport, tempo and length while protecting all locked steps", async () => {
  const app = setup({ sourceWindow: {}, displays: [] });
  await app.send("register", { windowId: 1, tabId: 11, videoId: "a" });
  await app.send("register", { windowId: 2, tabId: 12, videoId: "b" });
  await app.send("voice", { windowId: 2, changes: { lockedSteps: [7] } });
  assert.equal((await app.send("length", { length: 7 })).ok, false);
  await app.send("voice", { windowId: 2, changes: { lockedSteps: [] } });
  const resized = await app.send("length", { length: 7 });
  assert.equal(resized.session.voices["1"].sequence.length, 7);
  assert.equal(resized.session.voices["2"].sequence.length, 7);
  const started = await app.send("transport", { playing: true });
  assert.equal(started.session.clock.startAt, 1000350);
  assert.equal(started.session.clock.step, 0);
  const changed = await app.send("bpm", { bpm: 90 });
  assert.equal(changed.session.bpm, 90);
  assert.equal(changed.session.clockVersion, 2);
  assert.equal((await app.send("transport", { playing: false })).session.clock, null);
});

Deno.test("speeding up from a slow tempo schedules the next beat promptly", async () => {
  const app = setup({ sourceWindow: {}, displays: [] });
  await app.send("register", { windowId: 1, tabId: 11, videoId: "a" });
  await app.send("bpm", { bpm: 1 });
  await app.send("transport", { playing: true });
  app.advance(400);
  const changed = await app.send("bpm", { bpm: 120 });
  assert.equal(changed.session.clock.startAt, 1001250);
  assert.equal(changed.session.clock.step, 1);
});

Deno.test("new voices start empty at the shared length without changing existing voices", async () => {
  const app = setup({ sourceWindow: {}, displays: [] });
  let state = await app.send("register", { windowId: 1, tabId: 11, videoId: "a" });
  assert.deepEqual([...state.session.voices["1"].sequence], Array(8).fill(""));
  await app.send("voice", {
    windowId: 1, changes: { sequence: ["4", "", "", "", "", "", "", ""] }
  });
  await app.send("length", { length: 9 });
  state = await app.send("register", { windowId: 2, tabId: 12, videoId: "b" });
  assert.deepEqual([...state.session.voices["2"].sequence], Array(9).fill(""));
  assert.equal(state.session.voices["1"].sequence[0], "4");
  state = await app.send("register", { windowId: 1, tabId: 11, videoId: "a" });
  assert.equal(state.session.voices["1"].sequence[0], "4");
});

Deno.test("voices can join playback and retain their sequence after losing or replacing a video", async () => {
  const app = setup({ sourceWindow: {}, displays: [] });
  await app.send("register", { windowId: 1, tabId: 11, videoId: "a" });
  const started = await app.send("transport", { playing: true });
  const joined = await app.send("register", { windowId: 2, tabId: 12, videoId: "b" });
  assert.equal(joined.session.clock.startAt, started.session.clock.startAt);
  assert.equal(joined.session.playing, true);
  await app.send("voice", {
    windowId: 2, changes: { sequence: ["9", "1", "2", "3", "4", "5", "6", "7"] },
    padTime: { tabId: 12, videoId: "b", times: { "9": 12.5 } }
  });
  app.removeTab(12);
  let state = await app.send("get");
  assert.equal(state.session.voices["2"].tabId, null);
  assert.equal(state.session.voices["2"].sequence[0], "9");
  state = await app.send("register", { windowId: 2, tabId: 13, videoId: "c" });
  assert.equal(state.session.voices["2"].sequence[0], "9");
  assert.equal(state.session.recordedPadTimesByTab["12"], undefined);
  assert.equal(state.session.playing, true);
  assert.equal((await app.send("register", { windowId: 3, tabId: 11, videoId: "a" })).ok, false);
});

Deno.test("reset restores eight steps in all voices while protecting locked steps", async () => {
  const app = setup({ sourceWindow: {}, displays: [] });
  await app.send("register", { windowId: 1, tabId: 11, videoId: "a" });
  await app.send("register", { windowId: 2, tabId: 12, videoId: "b" });
  await app.send("length", { length: 9 });
  await app.send("voice", {
    windowId: 1, changes: { sequence: ["9", "8", "7", "6", "5", "4", "3", "2", "1"],
      lockedSteps: [0], prohibitedPads: ["1"], randomize: true },
    padTime: { tabId: 11, videoId: "a", times: { "1": 10 } }
  });
  await app.send("voice", {
    windowId: 2, changes: { sequence: ["8", "7", "6", "5", "4", "3", "2", "1", "9"],
      lockedSteps: [1, 8], prohibitedPads: ["2"], randomize: true },
    padTime: { tabId: 12, videoId: "b", times: { "2": 20 } }
  });
  await app.send("bpm", { bpm: 90 });
  await app.send("transport", { playing: true });
  const blocked = await app.send("reset", { windowId: 1 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /Unlock steps after step 8/);
  const unchanged = (await app.send("get")).session;
  assert.equal(unchanged.length, 9);
  assert.equal(unchanged.voices["1"].sequence[1], "8");
  assert.equal(unchanged.recordedPadTimesByTab["11"].a["1"], 10);
  await app.send("voice", { windowId: 2, changes: { lockedSteps: [1] } });
  const result = await app.send("reset", { windowId: 1 });
  const session = result.session;
  assert.equal(session.playing, true);
  assert.equal(session.bpm, 90);
  assert.equal(session.length, 8);
  assert.equal(session.resetVersion, 1);
  assert.deepEqual([...session.voices["1"].sequence], ["9", "", "", "", "", "", "", ""]);
  assert.deepEqual([...session.voices["2"].sequence], ["", "7", "", "", "", "", "", ""]);
  for (const voice of Object.values(session.voices)) {
    assert.equal(voice.prohibitedPads.length, 0);
    assert.equal(voice.randomize, false);
  }
  assert.equal(session.recordedPadTimesByTab["11"].a, undefined);
  assert.equal(session.recordedPadTimesByTab["12"].b, undefined);
});

Deno.test("reset expands short sequences to eight steps", async () => {
  const app = setup({ sourceWindow: {}, displays: [] });
  await app.send("register", { windowId: 1, tabId: 11, videoId: "a" });
  await app.send("register", { windowId: 2, tabId: 12, videoId: "b" });
  await app.send("length", { length: 7 });
  const { session } = await app.send("reset", { windowId: 2 });
  assert.equal(session.length, 8);
  assert.deepEqual([...session.voices["1"].sequence], Array(8).fill(""));
  assert.deepEqual([...session.voices["2"].sequence], Array(8).fill(""));
});

Deno.test("duplicate video tabs keep independent pad times and locks", async () => {
  const app = setup({ sourceWindow: {}, displays: [] });
  await app.send("register", { windowId: 1, tabId: 11, videoId: "a" });
  await app.send("register", { windowId: 2, tabId: 12, videoId: "a" });
  await app.send("voice", {
    windowId: 1, changes: {}, padTime: { tabId: 11, videoId: "a", times: { "1": 10, "2": 20 } }
  });
  await app.send("pad-lock", { windowId: 1, tabId: 11, videoId: "a", key: "1", locked: true });
  let state = await app.send("get");
  assert.equal(state.session.recordedPadTimesByTab["12"], undefined);
  assert.equal(state.session.lockedPadsByTab["12"], undefined);
  await app.send("pad-lock", { windowId: 2, tabId: 12, videoId: "a", key: "3", locked: true });
  for (const times of [{ "1": 11, "2": 20 }, { "2": 20 }, null]) {
    const result = await app.send("voice", {
      windowId: 1, changes: {}, padTime: { tabId: 11, videoId: "a", times }
    });
    assert.equal(result.ok, false);
  }
  const edit = await app.send("voice", {
    windowId: 2, changes: {}, padTime: { tabId: 12, videoId: "a", times: { "1": 15, "2": 21 } }
  });
  assert.equal(edit.ok, true);
  assert.equal(edit.session.recordedPadTimesByTab["11"].a["1"], 10);
  assert.equal(edit.session.recordedPadTimesByTab["12"].a["1"], 15);
  const reset = await app.send("reset", { windowId: 2 });
  assert.equal(JSON.stringify(reset.session.recordedPadTimesByTab["11"].a), '{"1":10}');
  assert.equal(reset.session.recordedPadTimesByTab["12"].a, undefined);
  assert.equal(reset.session.lockedPadsByTab["11"].a.join(","), "1");
  assert.equal(reset.session.lockedPadsByTab["12"].a.join(","), "3");
  await app.send("pad-lock", { windowId: 1, tabId: 11, videoId: "a", key: "1", locked: false });
  const unlocked = await app.send("voice", {
    windowId: 1, changes: {}, padTime: { tabId: 11, videoId: "a", times: { "1": 15 } }
  });
  assert.equal(unlocked.session.recordedPadTimesByTab["11"].a["1"], 15);
  const stale = await app.send("voice", {
    windowId: 2, changes: {}, padTime: { tabId: 11, videoId: "a", times: { "1": 99 } }
  });
  assert.equal(stale.ok, false);
});

Deno.test("existing session pad data migrates only to its already assigned tabs", async () => {
  const app = setup({
    sourceWindow: {}, displays: [],
    saved: { chorusSession: {
      bpm: 120, length: 8, playing: false, clock: null, clockVersion: 0,
      metronome: false, resetVersion: 0,
      voices: { "1": { tabId: 11, videoId: "a", sequence: Array(8).fill(""),
        lockedSteps: [], prohibitedPads: [], randomize: false, includeEmptySteps: true } },
      recordedPadTimesByVideo: { a: { "1": 10 }, b: { "2": 20 } }, lockedPadsByVideo: { a: ["1"] }
    } }
  });
  let state = await app.send("get");
  assert.equal(state.session.recordedPadTimesByTab["11"].a["1"], 10);
  assert.equal(state.session.recordedPadTimesByTab["11"].b["2"], 20);
  assert.deepEqual([...state.session.lockedPadsByTab["11"].a], ["1"]);
  state = await app.send("register", { windowId: 2, tabId: 12, videoId: "a" });
  assert.equal(state.session.recordedPadTimesByTab["12"], undefined);
  assert.equal(state.session.lockedPadsByTab["12"], undefined);
  state = await app.send("get");
  assert.equal(state.session.recordedPadTimesByTab["11"].a["1"], 10);
});

Deno.test("closing the last voice stops playback and clears session settings", async () => {
  const app = setup({ sourceWindow: {}, displays: [] });
  await app.send("register", { windowId: 1, tabId: 11, videoId: "a" });
  await app.send("register", { windowId: 2, tabId: 12, videoId: "b" });
  await app.send("bpm", { bpm: 99 });
  app.removeWindow(1);
  let state = await app.send("get");
  assert.equal(state.session.bpm, 99);
  assert.equal(state.session.voices["1"], undefined);
  assert.equal(app.stopped[0].id, 11);
  assert.equal(app.cleared.length, 0);
  app.removeWindow(2);
  state = await app.send("get");
  assert.equal(state.session.bpm, 120);
  assert.equal(Object.keys(state.session.voices).length, 0);
  assert.ok(app.cleared[0].includes("recordedPadTimesByVideo"));
  assert.equal(app.stopped[1].id, 12);
});
