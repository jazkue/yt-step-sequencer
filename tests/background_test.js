import { strict as assert } from "node:assert";
import { runInNewContext } from "node:vm";

const source = await Deno.readTextFile(new URL("../background.js", import.meta.url));

function setup({ sourceWindow, displays, create = async () => {}, open = [] }) {
  let handler;
  let messageHandler;
  let windowRemoved;
  let tabRemoved;
  const windows = [];
  const errors = [];
  const updated = [];
  const stopped = [];
  const store = {};
  const cleared = [];
  runInNewContext(source, {
    performance: { timeOrigin: 1000000, now: () => 0 },
    chrome: {
      action: { onClicked: { addListener: fn => { handler = fn; } } },
      windows: {
        get: async () => sourceWindow,
        getAll: async () => open,
        update: async (id, options) => { updated.push({ id, options }); },
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
    handler, windows, errors, updated, stopped, cleared,
    send: (type, data = {}) => new Promise(resolve =>
      messageHandler({ type: `yt-step-sequencer:chorus-${type}`, ...data }, {}, resolve)),
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

Deno.test("voices can join playback and retain their sequence after losing or replacing a video", async () => {
  const app = setup({ sourceWindow: {}, displays: [] });
  await app.send("register", { windowId: 1, tabId: 11, videoId: "a" });
  const started = await app.send("transport", { playing: true });
  const joined = await app.send("register", { windowId: 2, tabId: 12, videoId: "b" });
  assert.equal(joined.session.clock.startAt, started.session.clock.startAt);
  assert.equal(joined.session.playing, true);
  await app.send("voice", {
    windowId: 2, changes: { sequence: ["9", "1", "2", "3", "4", "5", "6", "7"] },
    padTime: { videoId: "b", times: { "9": 12.5 } }
  });
  app.removeTab(12);
  let state = await app.send("get");
  assert.equal(state.session.voices["2"].tabId, null);
  assert.equal(state.session.voices["2"].sequence[0], "9");
  state = await app.send("register", { windowId: 2, tabId: 13, videoId: "c" });
  assert.equal(state.session.voices["2"].sequence[0], "9");
  assert.equal(state.session.recordedPadTimesByVideo.b["9"], 12.5);
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
    padTime: { videoId: "a", times: { "1": 10 } }
  });
  await app.send("voice", {
    windowId: 2, changes: { sequence: ["8", "7", "6", "5", "4", "3", "2", "1", "9"],
      lockedSteps: [1, 8], prohibitedPads: ["2"], randomize: true },
    padTime: { videoId: "b", times: { "2": 20 } }
  });
  await app.send("bpm", { bpm: 90 });
  await app.send("transport", { playing: true });
  const blocked = await app.send("reset", { windowId: 1 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /Unlock steps after step 8/);
  const unchanged = (await app.send("get")).session;
  assert.equal(unchanged.length, 9);
  assert.equal(unchanged.voices["1"].sequence[1], "8");
  assert.equal(unchanged.recordedPadTimesByVideo.a["1"], 10);
  await app.send("voice", { windowId: 2, changes: { lockedSteps: [1] } });
  const result = await app.send("reset", { windowId: 1 });
  const session = result.session;
  assert.equal(session.playing, true);
  assert.equal(session.bpm, 90);
  assert.equal(session.length, 8);
  assert.equal(session.resetVersion, 1);
  assert.equal(session.voices["1"].sequence.join(","), "9,1,2,3,4,5,6,7");
  assert.equal(session.voices["2"].sequence.join(","), "0,7,2,3,4,5,6,7");
  for (const voice of Object.values(session.voices)) {
    assert.equal(voice.prohibitedPads.length, 0);
    assert.equal(voice.randomize, false);
  }
  assert.equal(Object.keys(session.recordedPadTimesByVideo).length, 0);
});

Deno.test("reset expands short sequences to eight steps", async () => {
  const app = setup({ sourceWindow: {}, displays: [] });
  await app.send("register", { windowId: 1, tabId: 11, videoId: "a" });
  await app.send("register", { windowId: 2, tabId: 12, videoId: "b" });
  await app.send("length", { length: 7 });
  const { session } = await app.send("reset", { windowId: 2 });
  assert.equal(session.length, 8);
  assert.equal(session.voices["1"].sequence.join(","), "0,1,2,3,4,5,6,7");
  assert.equal(session.voices["2"].sequence.join(","), "0,1,2,3,4,5,6,7");
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
