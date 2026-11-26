import { strict as assert } from "node:assert";
import { createContext, runInContext } from "node:vm";

const source = await Deno.readTextFile(new URL("../popup.js", import.meta.url));

async function setup({
  left = 100, right = 1000, width = 412, frameHeight = 0, contentHeight = 460,
  prohibitedPads = [], saved = {}, sendMessage, connected = false, closeAll = async () => ({ ok: true })
} = {}) {
  const popup = { id: 1, left, top: 100, width, height: 460 };
  const updates = [];
  const errors = [];
  const storageSets = [];
  const session = {
    bpm: saved.bpm || 120, length: saved.sequence?.length || 8, playing: false,
    clock: null, clockVersion: 0, metronome: false, resetVersion: 0, voices: {},
    recordedPadTimesByTab: { 1: saved.recordedPadTimesByVideo || {} },
    lockedPadsByTab: { 1: saved.lockedPadsByVideo || {} }
  };
  let chorusListener;
  let now = 0;
  let portMessage;
  const windowListeners = {};

  class Element {
    children = [];
    listeners = {};
    dataset = {};
    attributes = {};
    classList = {
      values: new Set(),
      add(value) { this.values.add(value); },
      remove(...values) { for (const value of values) this.values.delete(value); },
      toggle(value, force = !this.values.has(value)) {
        if (force) this.values.add(value);
        else this.values.delete(value);
      },
      contains(value) { return this.values.has(value); }
    };
    scrollLeft = 0;
    value = "";
    disabled = false;

    addEventListener(type, listener) { this.listeners[type] = listener; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    dispatchEvent(event) { this.listeners[event.type]?.(event); }
    select() { this.focus(); }
    focus() {
      if (document.activeElement === this) return;
      document.activeElement = this;
      this.listeners.focus?.();
    }
    contains(element) { return this === element || this.children.some(child => child.contains(element)); }
    scrollIntoView() { this.scrolledIntoView = true; }
    requestSubmit() { this.submissions = (this.submissions || 0) + 1; }
    append(...children) {
      for (const child of children) {
        child.parentElement = this;
        this.children.push(child);
      }
    }
    remove() {
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(this), 1);
    }
  }

  const elements = new Map();
  const document = {
    listeners: {},
    activeElement: null,
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new Element());
      return elements.get(selector);
    },
    createElement: () => new Element(),
    addEventListener(type, listener) {
      (this.listeners[type] ||= []).push(listener);
    },
    removeEventListener(type, listener) {
      this.listeners[type] = (this.listeners[type] || []).filter(item => item !== listener);
    },
    documentElement: { get scrollHeight() { return Math.max(contentHeight, popup.height - frameHeight); } }
  };
  const steps = document.querySelector("#steps");
  Object.defineProperties(steps, {
    clientWidth: { get: () => popup.width - 146 },
    scrollWidth: { get: () => Math.max(steps.clientWidth, 266 + (steps.children.length - 8) * 33) }
  });
  const removeButton = document.querySelector("#remove-step");
  removeButton.parentElement = { getBoundingClientRect: () => ({ right: popup.width }) };
  removeButton.getBoundingClientRect = () => ({
    right: popup.width - Math.max(0, popup.width - 412 - (steps.children.length - 8) * 33)
  });
  document.querySelector("#bpm").value = "120";
  document.querySelector("#pad-mode").checked = true;

  const context = createContext({
    document,
    window: {
      get innerHeight() { return popup.height - frameHeight; },
      get innerWidth() { return popup.width; },
      addEventListener(type, listener) { windowListeners[type] = listener; }
    },
    location: { search: connected ? "?tabId=1" : "" },
    URL,
    URLSearchParams,
    Event,
    performance: { timeOrigin: 1000000, now: () => now },
    Date: { now: () => now },
    console: { error: (...args) => errors.push(args), warn() {} },
    chrome: {
      runtime: {
        connect: () => ({
          onMessage: { addListener: listener => { chorusListener = listener; } },
          onDisconnect: { addListener() {} }
        }),
        sendMessage: async message => {
          if (message.type.endsWith(":close-all-windows")) return closeAll(message);
          const voice = session.voices["1"];
          if (message.type.endsWith(":chorus-register")) {
            session.voices["1"] = voice || {
              tabId: message.tabId, videoId: message.videoId,
              sequence: saved.sequence || Array(session.length).fill(""),
              lockedSteps: saved.lockedSteps || [], prohibitedPads,
              randomize: saved.randomize || false, includeEmptySteps: saved.includeEmptySteps !== false
            };
          } else if (message.type.endsWith(":chorus-voice")) {
            if (message.padTime) {
              if (voice.tabId !== message.padTime.tabId || voice.videoId !== message.padTime.videoId) {
                return { ok: false, error: "The video has changed." };
              }
              const tabTimes = session.recordedPadTimesByTab[message.padTime.tabId] ||= {};
              const old = tabTimes[message.padTime.videoId] || {};
              const next = message.padTime.times || {};
              if ((session.lockedPadsByTab[message.padTime.tabId]?.[message.padTime.videoId] || [])
                .some(key => old[key] !== next[key])) {
                return { ok: false, error: "Unlock the pad before changing its time." };
              }
              if (message.padTime.times === null) delete tabTimes[message.padTime.videoId];
              else tabTimes[message.padTime.videoId] = message.padTime.times;
            }
            Object.assign(voice, message.changes);
            storageSets.push(JSON.parse(JSON.stringify({
              ...message.changes,
              ...(message.padTime && { recordedPadTimesByVideo: session.recordedPadTimesByTab[message.padTime.tabId] })
            })));
          } else if (message.type.endsWith(":chorus-pad-lock")) {
            const tabLocks = session.lockedPadsByTab[message.tabId] ||= {};
            const locks = new Set(tabLocks[message.videoId] || []);
            if (message.locked) locks.add(message.key);
            else locks.delete(message.key);
            tabLocks[message.videoId] = [...locks];
          } else if (message.type.endsWith(":chorus-length")) {
            for (const item of Object.values(session.voices)) {
              if (message.length > session.length) item.sequence.push("");
              else item.sequence.pop();
            }
            session.length = message.length;
          } else if (message.type.endsWith(":chorus-bpm")) {
            session.bpm = message.bpm;
            if (session.playing) session.clockVersion++;
          } else if (message.type.endsWith(":chorus-metronome")) {
            session.metronome = message.enabled;
          } else if (message.type.endsWith(":chorus-transport")) {
            session.playing = message.playing;
            session.clock = message.playing ? { startAt: 1000100, step: 0 } : null;
            session.clockVersion++;
          } else if (message.type.endsWith(":chorus-unassign")) {
            voice.tabId = null;
            voice.videoId = null;
          } else if (message.type.endsWith(":chorus-reset")) {
            if (Object.values(session.voices).some(item => item.lockedSteps.some(index => index >= 8))) {
              return { ok: false, error: "Unlock steps after step 8 in every voice before resetting." };
            }
            for (const item of Object.values(session.voices)) {
              item.sequence = Array.from({ length: 8 }, (_, index) =>
                item.lockedSteps.includes(index) ? item.sequence[index] : ""
              );
              item.prohibitedPads = [];
              item.randomize = false;
              storageSets.push({ prohibitedPads: [] });
            }
            for (const item of Object.values(session.voices)) {
              if (!Number.isInteger(item.tabId) || !item.videoId) continue;
              const tabTimes = session.recordedPadTimesByTab[item.tabId] ||= {};
              const times = tabTimes[item.videoId] || {};
              const locks = session.lockedPadsByTab[item.tabId]?.[item.videoId] || [];
              tabTimes[item.videoId] = Object.fromEntries(
                locks.filter(key => Object.prototype.hasOwnProperty.call(times, key)).map(key => [key, times[key]])
              );
            }
            session.length = 8;
            session.resetVersion++;
          }
          const snapshot = JSON.parse(JSON.stringify(session));
          chorusListener?.(snapshot);
          return { ok: true, session: snapshot };
        }
      },
      tabs: {
        sendMessage: async (id, message) => {
          const response = await sendMessage(id, message);
          if (message.type.endsWith(":status") && response?.ok && !("videoId" in response)) {
            return { ...response, videoId: "first" };
          }
          return response;
        },
        get: async () => ({ id: 1, url: "https://www.youtube.com/watch?v=first", title: "Video" }),
        connect: () => ({
          onMessage: { addListener: listener => { portMessage = listener; } },
          onDisconnect: { addListener() {} }
        })
      },
      storage: {
        local: {
          get: async () => ({ prohibitedPads, ...saved }),
          set: async value => storageSets.push(JSON.parse(JSON.stringify(value)))
        }
      },
      windows: {
        getCurrent: async () => ({ ...popup }),
        update: async (_id, options) => { updates.push(options); Object.assign(popup, options); }
      },
      system: { display: { getInfo: async () => [{
        isPrimary: true,
        bounds: { left: 0, top: 0, width: 1000, height: 900 },
        workArea: { left: 0, top: 0, width: right, height: 900 }
      }] } }
    },
    setTimeout, clearTimeout, setInterval() {}
  });
  runInContext(source.replace("initialize();", "globalThis.initialized = initialize();"), context);
  await context.initialized;
  return {
    popup, updates, errors, steps, storageSets,
    add: () => elements.get("#add-step").listeners.click(),
    remove: () => elements.get("#remove-step").listeners.click(),
    reset: () => elements.get("#reset").listeners.click(),
    clear: () => elements.get("#clear").listeners.click(),
    randomize: () => elements.get("#randomize").listeners.click(),
    lock: index => steps.children[index].children[1].listeners.click(),
    removeButton,
    addButton: elements.get("#add-step"),
    padMode: elements.get("#pad-mode"),
    setPadMode: play => {
      const input = elements.get("#pad-mode");
      input.checked = play;
      input.listeners.change();
    },
    recordPad: key =>
      elements.get("#pads").children["1234567890".indexOf(key)].children[2].listeners.click(),
    lockPad: key =>
      elements.get("#pads").children["1234567890".indexOf(key)].children[5].listeners.click(),
    startPadScrub: key =>
      elements.get("#pads").children["1234567890".indexOf(key)].children[3]
        .listeners.pointerdown({ clientX: 0, preventDefault() {} }),
    scrubMove: x => {
      now += 20;
      for (const listener of document.listeners.pointermove || []) listener({ clientX: x });
    },
    finishScrub: () => {
      for (const listener of [...(document.listeners.pointerup || [])]) listener();
    },
    padButton: key => elements.get("#pads").children["1234567890".indexOf(key)].children[0],
    padControls: key => elements.get("#pads").children["1234567890".indexOf(key)].children.slice(1),
    settings: elements.get("#settings"),
    transport: elements.get("#transport"),
    videoPlayback: elements.get("#video-playback"),
    videoVolume: elements.get("#video-volume"),
    videoSpeed: elements.get("#video-speed"),
    videoSpeedValue: elements.get("#video-speed-value"),
    setVideoVolume: value => {
      const input = elements.get("#video-volume");
      input.value = String(value);
      input.listeners.input();
    },
    setVideoSpeed: value => {
      const input = elements.get("#video-speed");
      input.value = String(value);
      input.listeners.input();
    },
    startSpeedDrag: () => elements.get("#video-speed").listeners.pointerdown({ pointerId: 7 }),
    finishSpeedDrag: () => {
      for (const listener of document.listeners.pointerup || []) listener({ pointerId: 7 });
    },
    resetSpeed: () => elements.get("#video-speed").listeners.dblclick(),
    resetVolume: () => elements.get("#video-volume").listeners.dblclick(),
    toggleVideo: () => elements.get("#video-playback").listeners.click(),
    emit: message => portMessage(message),
    isPadForbidden: key => runInContext(`prohibitedPads.has("${key}")`, context),
    isPadMarkedForbidden: key => runInContext(
      `padContainers.get("${key}").classList.contains("pad-prohibited")`, context
    ),
    connect: () => {
      session.voices["1"].tabId = 1;
      session.voices["1"].videoId = "first";
      runInContext('tabId = 1; videoId = "first"; chorusSession.voices["1"].tabId = 1', context);
    },
    updateSession: update => {
      update(session);
      chorusListener(JSON.parse(JSON.stringify(session)));
    },
    metronome: elements.get("#metronome"),
    bpm: elements.get("#bpm"),
    increaseBpm: () => elements.get("#bpm-increase").listeners.click(),
    decreaseBpm: () => elements.get("#bpm-decrease").listeners.click(),
    status: elements.get("#status"),
    closeAllButton: elements.get("#close-all-windows"),
    closeAll: () => elements.get("#close-all-windows").listeners.click(),
    tap: time => { now = time; elements.get("#tap-tempo").listeners.click(); },
    selectStep: index => runInContext(`selectStep(${index})`, context),
    focusStep: index => steps.children[index].children[0].focus(),
    pressKey: (key, timeStamp, options = {}) => {
      let prevented = false;
      document.listeners.keydown[0]({
        key, timeStamp, target: document.activeElement, ...options,
        preventDefault() { prevented = true; }
      });
      return prevented;
    },
    releaseKey: (key, options = {}) => document.listeners.keyup[0]({ key, ...options }),
    pointerDown: () => {
      for (const listener of document.listeners.pointerdown) listener({ target: elements.get("#pad-mode") });
    },
    blurWindow: () => windowListeners.blur(),
    clickPad: (key, event = { detail: 1 }) => {
      const button = elements.get("#pads").children["1234567890".indexOf(key)].children[0];
      button.focus();
      return button.listeners.click(event);
    },
    form: elements.get("#sequencer"),
    activeElement: () => document.activeElement,
    updateState: state => {
      session.playing = state.playing;
      if (typeof state.metronomeEnabled === "boolean") session.metronome = state.metronomeEnabled;
      context.testState = state;
      context.testSession = JSON.parse(JSON.stringify(session));
      runInContext(`chorusSession = testSession;
        appliedClockVersion = chorusSession.clockVersion;
        if (typeof testState.metronomeEnabled === "boolean") appliedMetronome = testState.metronomeEnabled;
        updateState(testState)`, context);
    },
    settle: async () => {
      let queue;
      do {
        queue = runInContext("commandQueue", context);
        await queue;
      } while (queue !== runInContext("commandQueue", context));
    }
  };
}

Deno.test("close all sends the current window and reports failures", async () => {
  const messages = [];
  let fail = true;
  const app = await setup({
    closeAll: async message => {
      messages.push(message);
      return fail ? { ok: false, error: "windows blocked" } : { ok: true };
    }
  });
  await app.closeAll();
  assert.equal(app.status.textContent, "windows blocked");
  assert.equal(app.closeAllButton.disabled, false);
  fail = false;
  await app.closeAll();
  assert.equal(app.closeAllButton.disabled, true);
  assert.deepEqual(messages.map(message => [message.type, message.windowId]), [
    ["yt-step-sequencer:close-all-windows", 1],
    ["yt-step-sequencer:close-all-windows", 1]
  ]);
});

Deno.test("a new sequencer window starts with eight empty steps", async () => {
  const app = await setup();
  assert.deepEqual(app.steps.children.map(step => step.children[0].value), Array(8).fill(""));
});

Deno.test("adding steps grows right without scrolling or shifting the window", async () => {
  const app = await setup();
  app.add();
  app.add();
  await app.settle();
  assert.equal(app.steps.children.length, 10);
  assert.equal(app.steps.scrollLeft, 0);
  assert.equal(app.popup.left, 100);
  assert.equal(app.popup.top, 100);
  assert.ok(app.popup.width >= 478);
  assert.equal(app.errors.length, 0);
});

Deno.test("editing an unassigned voice keeps its pads disabled", async () => {
  const app = await setup();
  const input = app.steps.children[0].children[0];
  input.value = "9";
  input.listeners.input();
  await app.settle();
  assert.equal(app.padButton("1").disabled, true);
  assert.equal(app.padMode.disabled, true);
  assert.ok(app.storageSets.some(value => value.sequence?.[0] === "9"));
});

Deno.test("adding steps stops growth at the display edge without hiding the start", async () => {
  const app = await setup({ left: 550, right: 1000 });
  app.add();
  app.add();
  await app.settle();
  assert.equal(app.popup.left, 550);
  assert.equal(app.popup.width, 450);
  assert.equal(app.steps.scrollLeft, 0);
  assert.ok(app.steps.scrollWidth > app.steps.clientWidth);
});

Deno.test("removing steps shrinks from the right down to the minimum width", async () => {
  const app = await setup();
  app.add();
  app.add();
  await app.settle();
  app.remove();
  await app.settle();
  assert.equal(app.popup.width, 445);
  assert.equal(app.popup.left, 100);
  assert.equal(app.popup.top, 100);
  app.remove();
  app.remove();
  await app.settle();
  assert.equal(app.popup.width, 412);
  assert.equal(app.steps.children.length, 7);
  assert.equal(app.errors.length, 0);
});

Deno.test("removing overflowing steps keeps the window size until the sequence fits", async () => {
  const app = await setup({ left: 550, right: 1000 });
  app.add();
  app.add();
  app.add();
  await app.settle();
  app.remove();
  await app.settle();
  assert.equal(app.popup.width, 450);
  app.remove();
  await app.settle();
  assert.equal(app.popup.width, 445);
  assert.equal(app.popup.left, 550);
});

Deno.test("reset restores the default window size", async () => {
  const app = await setup();
  app.popup.width = 550;
  app.popup.height = 600;
  app.reset();
  await app.settle();
  assert.equal(app.popup.width, 412);
  assert.equal(app.popup.height, 460);
  assert.equal(app.errors.length, 0);
});

Deno.test("reset fits the content after restoring a window with browser frame height", async () => {
  const app = await setup({ frameHeight: 40, contentHeight: 442 });
  app.popup.width = 550;
  app.popup.height = 600;
  app.reset();
  await app.settle();
  assert.equal(app.popup.width, 412);
  assert.equal(app.popup.height, 482);
  assert.equal(app.popup.height - 40, 442);
  assert.equal(app.errors.length, 0);
});

Deno.test("reset allows all pads and clears their forbidden state", async () => {
  const app = await setup({ prohibitedPads: ["1", "4"] });
  assert.equal(app.isPadForbidden("1"), true);
  assert.equal(app.isPadMarkedForbidden("1"), true);
  app.reset();
  await app.settle();
  assert.equal(app.isPadForbidden("1"), false);
  assert.equal(app.isPadForbidden("4"), false);
  assert.equal(app.isPadMarkedForbidden("1"), false);
  assert.ok(app.storageSets.some(value =>
    Array.isArray(value.prohibitedPads) && value.prohibitedPads.length === 0
  ));
});

Deno.test("a global reset updates a playing voice's sequence, pads, times and randomization", async () => {
  const messages = [];
  const app = await setup({
    prohibitedPads: ["1"],
    saved: { sequence: ["9", "8"], lockedSteps: [0], randomize: true,
      recordedPadTimesByVideo: { first: { "1": 25 } } },
    sendMessage: async (_tab, message) => {
      messages.push(message);
      return { ok: true, playing: true };
    }
  });
  app.connect();
  app.updateState({ playing: true });
  app.reset();
  await app.settle();
  assert.equal(app.steps.children[0].children[0].value, "9");
  assert.equal(app.steps.children[1].children[0].value, "");
  assert.equal(app.isPadForbidden("1"), false);
  assert.deepEqual(messages.map(message => message.type), [
    "yt-step-sequencer:prohibited", "yt-step-sequencer:update",
    "yt-step-sequencer:update", "yt-step-sequencer:update"
  ]);
  assert.equal(messages[1].randomize, false);
  assert.equal(Object.keys(messages[2].recordedPadTimes).length, 0);
  assert.deepEqual([...messages[3].sequence], ["9", "", "", "", "", "", "", ""]);
  assert.equal(app.steps.children.length, 8);
});

Deno.test("a reset initiated in another window updates this voice", async () => {
  const messages = [];
  const app = await setup({
    prohibitedPads: ["1"],
    saved: { sequence: ["9", "8"], randomize: true },
    sendMessage: async (_tab, message) => {
      messages.push(message);
      return { ok: true, playing: false };
    }
  });
  app.connect();
  app.updateSession(session => {
    session.voices["1"].sequence = Array(8).fill("");
    session.length = 8;
    session.voices["1"].prohibitedPads = [];
    session.voices["1"].randomize = false;
    session.resetVersion++;
  });
  await app.settle();
  assert.equal(app.steps.children[0].children[0].value, "");
  assert.equal(app.isPadForbidden("1"), false);
  assert.equal(messages.at(-1).type, "yt-step-sequencer:prohibited");
});

Deno.test("locked steps persist and resist pad entry, randomize, clear, reset, and removal", async () => {
  const app = await setup({
    saved: { sequence: ["4", "1", "2", "3", "4", "5", "6", "7", "9"], lockedSteps: [0, 8] },
    sendMessage: async () => ({ ok: true })
  });
  app.connect();
  app.updateState({ playing: false });
  assert.equal(app.steps.children[0].children[0].readOnly, true);
  assert.equal(app.steps.children[0].children[1].attributes["aria-pressed"], "true");
  app.selectStep(0);
  await app.clickPad("5");
  assert.equal(app.steps.children[0].children[0].value, "4");
  app.steps.children[0].children[0].value = "6";
  app.steps.children[0].children[0].listeners.input();
  assert.equal(app.steps.children[0].children[0].value, "4");
  app.steps.listeners.drop({
    target: { closest: () => app.steps.children[0] },
    dataTransfer: { types: ["application/x-yt-pad"], getData: () => "8" },
    preventDefault() { throw new Error("locked steps must reject drops"); }
  });
  assert.equal(app.steps.children[0].children[0].value, "4");
  app.randomize();
  await app.settle();
  assert.equal(app.steps.children[0].children[0].value, "4");
  assert.equal(app.steps.children[8].children[0].value, "9");
  app.clear();
  await app.settle();
  assert.equal(app.steps.children[0].children[0].value, "4");
  assert.equal(app.steps.children[1].children[0].value, "");
  assert.equal(app.steps.children[8].children[0].value, "9");
  assert.equal(app.removeButton.disabled, false);
  assert.equal(app.addButton.disabled, false);
  app.remove();
  assert.equal(app.steps.children.length, 9);
  assert.equal(app.status.textContent, "unlock the last step before removing it.");
  app.add();
  await app.settle();
  assert.equal(app.steps.children.length, 10);
  app.remove();
  await app.settle();
  assert.equal(app.steps.children.length, 9);
  app.reset();
  await app.settle();
  assert.equal(app.steps.children.length, 9);
  assert.match(app.status.textContent, /unlock steps after step 8/);
  assert.equal(app.steps.children[0].children[0].value, "4");
  assert.equal(app.steps.children[1].children[0].value, "");
  assert.equal(app.steps.children[8].children[0].value, "9");
  app.lock(8);
  await app.settle();
  assert.equal(app.removeButton.disabled, false);
  assert.ok(app.storageSets.some(value => JSON.stringify(value.lockedSteps) === "[0]"));
  app.reset();
  await app.settle();
  assert.equal(app.steps.children.length, 8);
  assert.equal(app.steps.children[0].children[0].value, "4");
  assert.equal(app.steps.children[1].children[0].value, "");
  assert.equal(app.status.classList.contains("error"), false);
});

Deno.test("reopening preserves the session voice rather than adopting an old player sequence", async () => {
  const messages = [];
  let liveLocks = [1];
  const app = await setup({
    connected: true,
    saved: { sequence: ["0"], lockedSteps: [0] },
    sendMessage: async (_tab, message) => {
      messages.push(message);
      if (message.type.endsWith(":locks")) liveLocks = message.lockedSteps;
      if (message.type.endsWith(":status")) {
        return {
          ok: true, playing: true, sequence: ["0", "7"], lockedSteps: liveLocks,
          bpm: 120, currentStep: 0, stepSerial: 1
        };
      }
      return { ok: true };
    }
  });
  assert.equal(app.steps.children.length, 1);
  assert.equal(app.steps.children[0].children[0].readOnly, true);
  assert.equal(messages.some(message => message.type.endsWith(":locks")), true);
});

Deno.test("lock synchronization failure restores the lock and keeps controls usable", async () => {
  const app = await setup({
    sendMessage: async () => ({ ok: false, error: "lock sync failed" })
  });
  app.connect();
  app.updateState({ playing: false });
  app.lock(7);
  await app.settle();
  assert.equal(app.status.textContent, "lock sync failed");
  assert.equal(app.steps.children[7].children[0].readOnly, false);
  assert.equal(app.settings.disabled, false);
  assert.equal(app.addButton.disabled, false);
  assert.equal(app.removeButton.disabled, false);
  app.add();
  await app.settle();
  assert.equal(app.steps.children.length, 9);
});

Deno.test("global metronome reports audio initialization failure", async () => {
  const messages = [];
  const app = await setup({
    sendMessage: async (_tab, message) => {
      messages.push(message);
      return message.enabled
        ? { ok: false, error: "audio error" }
        : { ok: true, metronomeEnabled: false };
    }
  });

  app.connect();
  app.updateState({ playing: false, metronomeEnabled: false });
  app.metronome.checked = true;
  app.metronome.listeners.change();
  await app.settle();
  assert.equal(messages[0].type, "yt-step-sequencer:metronome");
  assert.equal(messages[0].enabled, true);
  assert.equal(app.metronome.checked, false);
  assert.equal(app.status.textContent, "audio error");
});

Deno.test("metronome ownership transfers between assigned voices", async () => {
  const messages = [];
  const app = await setup({
    sendMessage: async (_tab, message) => {
      messages.push(message);
      return { ok: true, playing: false };
    }
  });
  app.connect();
  app.updateSession(session => {
    session.metronome = true;
    session.voices["0"] = { tabId: 2 };
  });
  await app.settle();
  assert.equal(messages.filter(message => message.type.endsWith(":metronome")).length, 0);
  app.updateSession(session => { delete session.voices["0"]; });
  await app.settle();
  assert.equal(messages.at(-1).enabled, true);
  app.updateSession(session => { session.voices["0"] = { tabId: 2 }; });
  await app.settle();
  assert.equal(messages.at(-1).enabled, false);
});

Deno.test("tap tempo sends rounded integer BPM while playing", async () => {
  const messages = [];
  const app = await setup({
    sendMessage: async (_tab, message) => {
      messages.push(message);
      return { ok: true, playing: true, sequence: ["0"], bpm: message.bpm, currentStep: 0, stepSerial: 1 };
    }
  });
  app.connect();
  app.updateState({ playing: true, currentStep: 0, stepSerial: 1 });
  app.tap(1000);
  app.tap(1523);
  await app.settle();
  assert.equal(app.bpm.value, "115");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].bpm, 115);
  assert.equal(app.status.classList.contains("error"), false);
});

Deno.test("BPM entry rejects decimals and tap tempo restores a valid value", async () => {
  const app = await setup();
  for (const [value, invalid] of [["0", "true"], ["999", "false"], ["1000", "true"]]) {
    app.bpm.value = value;
    app.bpm.listeners.input();
    assert.equal(app.bpm.attributes["aria-invalid"], invalid);
  }
  app.bpm.value = "120.5";
  app.bpm.listeners.input();
  assert.equal(app.bpm.attributes["aria-invalid"], "true");
  assert.match(app.status.textContent, /whole-number/);
  app.tap(1000);
  app.tap(1500);
  assert.equal(app.bpm.value, "120");
  assert.equal(app.bpm.attributes["aria-invalid"], "false");
  assert.equal(app.status.classList.contains("error"), false);
});

Deno.test("incoming chorus tempo does not overwrite a manual BPM draft", async () => {
  const app = await setup();
  app.bpm.value = "145";
  app.bpm.listeners.input();
  app.updateSession(session => { session.bpm = 130; });
  assert.equal(app.bpm.value, "145");
  app.bpm.listeners.change();
  await app.settle();
  assert.equal(app.bpm.value, "145");
  app.updateSession(session => { session.bpm = 140; });
  assert.equal(app.bpm.value, "140");
});

Deno.test("queued BPM changes do not overwrite a newer manual draft", async () => {
  const app = await setup();
  app.tap(1000);
  app.tap(1500);
  app.bpm.value = "90";
  app.bpm.listeners.input();
  await app.settle();
  assert.equal(app.bpm.value, "90");
  app.bpm.listeners.change();
  await app.settle();
  assert.equal(app.bpm.value, "90");
});

Deno.test("tap and rapid BPM adjustments retain the latest requested value", async () => {
  const app = await setup();
  app.tap(1000);
  app.tap(1523);
  app.updateSession(session => { session.bpm = 130; });
  assert.equal(app.bpm.value, "115");
  app.increaseBpm();
  app.increaseBpm();
  app.decreaseBpm();
  await app.settle();
  assert.equal(app.bpm.value, "116");
});

Deno.test("speed defaults to 1x for a selected video and tracks later changes", async () => {
  const messages = [];
  let speed = 1.5;
  let fail = false;
  const app = await setup({
    connected: true,
    sendMessage: async (tab, message) => {
      if (message.type.endsWith(":status")) {
        return { ok: true, playing: false, videoId: "first", videoSpeed: speed };
      }
      if (message.type.endsWith(":video-speed")) {
        messages.push({ tab, speed: message.speed, videoId: message.videoId });
        if (fail) return { ok: false, error: "speed unavailable" };
        speed = message.speed;
        return { ok: true, videoSpeed: speed };
      }
      return { ok: true };
    }
  });
  await app.settle();
  assert.deepEqual(messages, [{ tab: 1, speed: 1, videoId: "first" }]);
  assert.equal(app.videoSpeed.value, "1");
  assert.equal(app.videoSpeedValue.textContent, "1x");
  app.emit({ videoSpeed: 1.5 });
  assert.equal(app.videoSpeedValue.textContent, "1.5x");
  app.videoSpeed.focus();
  assert.equal(app.pressKey("ArrowLeft"), false);
  assert.equal(app.pressKey("2"), false);
  app.setVideoSpeed(0.25);
  await app.settle();
  assert.equal(app.videoSpeedValue.textContent, "0.25x");
  fail = true;
  app.setVideoSpeed(2);
  await app.settle();
  assert.equal(app.videoSpeed.value, "0.25");
  assert.equal(app.status.textContent, "speed unavailable");
  app.updateSession(session => { session.voices["1"].tabId = null; });
  assert.equal(app.videoSpeed.disabled, true);
});

Deno.test("speed resets when a delayed player becomes available and keeps the latest drag", async () => {
  let resolveFirst;
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const speeds = [];
  const app = await setup({
    connected: true,
    sendMessage: async (_tab, message) => {
      if (message.type.endsWith(":status")) {
        return { ok: true, playing: false, videoId: "first", videoSpeed: null };
      }
      if (message.type.endsWith(":video-speed")) {
        speeds.push(message.speed);
        if (speeds.length === 2) {
          signalStarted();
          return new Promise(resolve => { resolveFirst = resolve; });
        }
        return { ok: true, videoSpeed: message.speed };
      }
      return { ok: true };
    }
  });
  assert.equal(app.videoSpeed.disabled, true);
  app.updateState({ playing: false, videoSpeed: 1.5 });
  await app.settle();
  assert.deepEqual(speeds, [1]);
  app.setVideoSpeed(0.5);
  await started;
  app.setVideoSpeed(1.5);
  app.setVideoSpeed(2);
  app.emit({ videoSpeed: 0.5 });
  assert.equal(app.videoSpeedValue.textContent, "2x");
  resolveFirst({ ok: true, videoSpeed: 0.5 });
  await app.settle();
  assert.deepEqual(speeds, [1, 0.5, 2]);
  assert.equal(app.videoSpeed.value, "2");
});

Deno.test("speed snaps while dragging and allows precise keyboard values", async () => {
  const speeds = [];
  const app = await setup({
    connected: true,
    sendMessage: async (_tab, message) => {
      if (message.type.endsWith(":status")) {
        return { ok: true, playing: false, videoId: "first", videoSpeed: 1 };
      }
      if (message.type.endsWith(":video-speed")) {
        speeds.push(message.speed);
        return { ok: true, videoSpeed: message.speed };
      }
      return { ok: true };
    }
  });
  app.startSpeedDrag();
  for (const [value, expected] of [[0.94, 0.94], [0.95, 1], [1.05, 1], [1.06, 1.06]]) {
    app.setVideoSpeed(value);
    assert.equal(app.videoSpeed.value, String(expected));
    assert.equal(app.videoSpeedValue.textContent, `${expected}x`);
    await app.settle();
    assert.equal(speeds.at(-1), expected);
  }
  app.finishSpeedDrag();
  app.setVideoSpeed(0.99);
  await app.settle();
  assert.equal(speeds.at(-1), 0.99);
  assert.equal(app.videoSpeed.value, "0.99");
});

Deno.test("double-click resets speed and restores volume, including when muted", async () => {
  const messages = [];
  const app = await setup({
    connected: true,
    sendMessage: async (_tab, message) => {
      if (message.type.endsWith(":status")) {
        return { ok: true, playing: false, videoId: "first", videoSpeed: 1,
          videoVolume: 0.4, videoMuted: true };
      }
      if (message.type.endsWith(":video-speed")) {
        messages.push(["speed", message.speed]);
        return { ok: true, videoSpeed: message.speed };
      }
      if (message.type.endsWith(":video-volume")) {
        messages.push(["volume", message.volume]);
        return { ok: true, videoVolume: message.volume / 100, videoMuted: false };
      }
      return { ok: true };
    }
  });
  app.setVideoSpeed(1.5);
  app.resetSpeed();
  app.resetVolume();
  assert.equal(app.videoSpeed.value, "1");
  assert.equal(app.videoSpeedValue.textContent, "1x");
  assert.equal(app.videoVolume.value, "100");
  await app.settle();
  assert.deepEqual(messages, [["speed", 1], ["volume", 100]]);
  assert.equal(app.videoVolume.attributes["aria-valuetext"], "100%");
});

Deno.test("video volume tracks YouTube, controls only its video, and reports failures", async () => {
  const messages = [];
  let fail = false;
  const app = await setup({
    connected: true,
    sendMessage: async (tab, message) => {
      if (message.type.endsWith(":status")) {
        return { ok: true, playing: false, videoId: "first", videoVolume: 0.75, videoMuted: false };
      }
      if (message.type.endsWith(":video-volume")) {
        messages.push({ tab, volume: message.volume });
        return fail ? { ok: false, error: "volume unavailable" } :
          { ok: true, videoVolume: message.volume / 100, videoMuted: false };
      }
      return { ok: true };
    }
  });
  assert.equal(app.videoVolume.disabled, false);
  assert.equal(app.videoVolume.value, "75");
  app.emit({ videoVolume: 0.4, videoMuted: true });
  assert.equal(app.videoVolume.value, "0");
  app.videoVolume.focus();
  assert.equal(app.pressKey("ArrowLeft"), false);
  assert.equal(app.pressKey("2"), false);
  app.setVideoVolume(50);
  app.setVideoVolume(70);
  await app.settle();
  assert.deepEqual(messages, [{ tab: 1, volume: 70 }]);
  assert.equal(app.videoVolume.value, "70");
  fail = true;
  app.setVideoVolume(20);
  await app.settle();
  assert.equal(app.videoVolume.value, "70");
  assert.equal(app.status.textContent, "volume unavailable");
  app.updateSession(session => { session.voices["1"].tabId = null; });
  assert.equal(app.videoVolume.disabled, true);
});

Deno.test("video volume keeps the latest drag value while a command is pending", async () => {
  let resolveFirst;
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const volumes = [];
  const app = await setup({
    connected: true,
    sendMessage: async (_tab, message) => {
      if (message.type.endsWith(":status")) {
        return { ok: true, playing: false, videoId: "first", videoVolume: 1, videoMuted: false };
      }
      if (message.type.endsWith(":video-volume")) {
        volumes.push(message.volume);
        if (volumes.length === 1) {
          signalStarted();
          return new Promise(resolve => { resolveFirst = resolve; });
        }
        return { ok: true, videoVolume: message.volume / 100, videoMuted: false };
      }
      return { ok: true };
    }
  });
  app.setVideoVolume(25);
  await started;
  app.setVideoVolume(70);
  app.setVideoVolume(80);
  app.emit({ videoVolume: 0.25, videoMuted: false });
  assert.equal(app.videoVolume.value, "80");
  resolveFirst({ ok: true, videoVolume: 0.25, videoMuted: false });
  await app.settle();
  assert.deepEqual(volumes, [25, 80]);
  assert.equal(app.videoVolume.value, "80");
});

Deno.test("arrow keys seek the video, including repeats, except while editing text", async () => {
  const messages = [];
  const app = await setup({
    sendMessage: async (_tab, message) => { messages.push(message); return { ok: true }; }
  });
  app.connect();
  app.updateState({ playing: false });
  assert.equal(app.pressKey("ArrowLeft"), true);
  assert.equal(app.pressKey("ArrowRight", 0, { repeat: true }), true);
  assert.equal(app.pressKey("ArrowLeft", 0, { ctrlKey: true }), false);
  app.focusStep(0);
  assert.equal(app.pressKey("ArrowLeft"), false);
  app.bpm.focus();
  assert.equal(app.pressKey("ArrowRight"), false);
  assert.deepEqual(messages.map(message => [message.type, message.direction]), [
    ["yt-step-sequencer:seek", "backward"],
    ["yt-step-sequencer:seek", "forward"]
  ]);
});

Deno.test("arrow-key seek failures are reported", async () => {
  const app = await setup({ sendMessage: async () => ({ ok: false, error: "seek unavailable" }) });
  app.connect();
  app.updateState({ playing: false });
  assert.equal(app.pressKey("ArrowLeft"), true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(app.status.textContent, "seek unavailable");
});

Deno.test("space toggles video playback without repeating or interrupting focused controls", async () => {
  const messages = [];
  let paused = true;
  const app = await setup({
    sendMessage: async (_tab, message) => {
      messages.push(message);
      paused = !paused;
      return { ok: true, playing: false, videoPaused: paused };
    }
  });
  app.connect();
  app.updateState({ playing: false, videoPaused: true });
  assert.equal(app.pressKey(" "), true);
  assert.equal(app.pressKey(" ", 0, { repeat: true }), true);
  await app.settle();
  assert.equal(app.videoPlayback.attributes["aria-label"], "pause video");
  assert.equal(app.pressKey(" "), true);
  await app.settle();
  assert.equal(app.videoPlayback.attributes["aria-label"], "play video");
  assert.equal(app.pressKey(" ", 0, { target: { closest: () => ({}) } }), false);
  assert.equal(app.pressKey(" ", 0, { ctrlKey: true }), false);
  assert.deepEqual(messages.map(message => message.type), [
    "yt-step-sequencer:video-toggle", "yt-step-sequencer:video-toggle"
  ]);
});

Deno.test("space uses video playback availability and error handling", async () => {
  const messages = [];
  const app = await setup({
    sendMessage: async (_tab, message) => {
      messages.push(message);
      return { ok: false, error: "video blocked" };
    }
  });
  app.connect();
  app.updateState({ playing: false, videoPaused: null });
  app.pressKey(" ");
  await app.settle();
  assert.equal(messages.length, 0);
  app.updateState({ playing: false, videoPaused: true });
  app.pressKey(" ");
  await app.settle();
  assert.equal(app.status.textContent, "video blocked");
  assert.equal(app.videoPlayback.disabled, false);
});

Deno.test("assigning pads advances the selected step with mouse and keyboard", async () => {
  const messages = [];
  const app = await setup({
    prohibitedPads: ["4"],
    saved: { sequence: ["0", "1", "2", "3", "4", "5", "6", "7"] },
    sendMessage: async (_tab, message) => { messages.push(message); return { ok: true }; }
  });
  app.connect();
  app.updateState({ playing: false, currentStep: -1 });
  await app.clickPad("2");
  assert.equal(app.steps.children[0].children[0].value, "0");
  assert.equal(app.steps.children[0].classList.contains("selected"), false);

  app.focusStep(0);
  app.pressKey("9");
  await app.settle();
  assert.equal(app.steps.children[0].children[0].value, "9");
  assert.equal(app.steps.children[1].classList.contains("selected"), true);
  assert.equal(app.activeElement(), app.steps.children[1].children[0]);

  await app.clickPad("3");
  assert.equal(app.steps.children[1].children[0].value, "3");
  assert.equal(app.steps.children[2].classList.contains("selected"), true);
  assert.equal(app.activeElement(), app.steps.children[2].children[0]);

  await app.clickPad("4");
  assert.equal(app.steps.children[2].children[0].value, "4");
  assert.equal(app.steps.children[3].classList.contains("selected"), true);
  assert.deepEqual(messages.map(message => message.key), ["2", "9", "3"]);

  app.selectStep(7);
  await app.clickPad("5");
  await app.settle();
  assert.equal(app.steps.children[7].children[0].value, "5");
  assert.equal(app.steps.children[0].classList.contains("selected"), true);
  assert.equal(app.form.submissions, 1);
});

Deno.test("space and tab empty selected steps and advance without playing the video", async () => {
  const messages = [];
  const app = await setup({
    saved: { sequence: ["0", "1", "2", "3", "4", "5", "6", "7"] },
    sendMessage: async (_tab, message) => { messages.push(message); return { ok: true }; }
  });
  app.connect();
  app.updateState({ playing: false, videoPaused: true });
  app.focusStep(0);
  assert.equal(app.pressKey(" "), true);
  assert.equal(app.steps.children[0].children[0].value, "");
  assert.equal(app.activeElement(), app.steps.children[1].children[0]);
  assert.equal(app.pressKey(" ", 0, { repeat: true }), true);
  assert.equal(app.steps.children[1].children[0].value, "1");
  assert.equal(app.pressKey("Tab"), true);
  assert.equal(app.steps.children[1].children[0].value, "");
  assert.equal(app.activeElement(), app.steps.children[2].children[0]);
  assert.equal(app.pressKey("Tab", 0, { shiftKey: true }), false);
  await app.settle();
  assert.deepEqual(app.storageSets.at(-1).sequence.slice(0, 3), ["", "", "2"]);
  assert.equal(messages.some(message => message.type.endsWith(":video-toggle")), false);

  app.selectStep(7);
  app.padButton("1").focus();
  assert.equal(app.pressKey(" "), true);
  assert.equal(app.steps.children[7].children[0].value, "");
  assert.equal(app.steps.children[0].classList.contains("selected"), true);
  assert.equal(app.form.submissions, 1);
});

Deno.test("space and tab do not change locked steps or other controls", async () => {
  const app = await setup({
    saved: { sequence: ["0", "1", "2", "3", "4", "5", "6", "7"], lockedSteps: [0] },
    sendMessage: async () => ({ ok: true })
  });
  app.connect();
  app.updateState({ playing: false });
  app.focusStep(0);
  assert.equal(app.pressKey(" "), true);
  assert.equal(app.pressKey("Tab"), true);
  assert.equal(app.steps.children[0].children[0].value, "0");
  assert.equal(app.steps.children[0].classList.contains("selected"), true);
  const otherControl = { closest: () => ({}) };
  assert.equal(app.pressKey(" ", 0, { target: otherControl }), false);
  assert.equal(app.pressKey("Tab", 0, { target: otherControl }), false);
});

Deno.test("emptying a selected step updates the running sequence", async () => {
  const messages = [];
  const app = await setup({
    sendMessage: async (_tab, message) => {
      messages.push(message);
      return { ok: true, playing: true, sequence: ["", "1", "2", "3", "4", "5", "6", "7"] };
    }
  });
  app.connect();
  app.updateState({ playing: true });
  app.focusStep(0);
  app.pressKey("Tab");
  await app.settle();
  assert.equal(messages.some(message =>
    message.type.endsWith(":update") && message.step === 0 && message.value === ""
  ), true);
  assert.equal(app.storageSets.at(-1).sequence[0], "");
});

Deno.test("tapping Control toggles pad mode without disrupting shortcuts", async () => {
  const app = await setup();
  app.pressKey("Control", 0, { ctrlKey: true });
  app.releaseKey("Control");
  assert.equal(app.padMode.checked, true);
  app.connect();
  app.updateState({ playing: false });
  app.bpm.focus();
  app.pressKey("Control", 0, { ctrlKey: true });
  app.pressKey("Control", 0, { ctrlKey: true, repeat: true });
  assert.equal(app.padMode.checked, true);
  app.releaseKey("Control");
  assert.equal(app.padMode.checked, false);
  assert.equal(app.padControls("1")[1].hidden, true);
  assert.equal(app.padMode.attributes["aria-label"], "pad mode: rec");
  app.pressKey("Control", 0, { ctrlKey: true });
  assert.equal(app.pressKey("c", 0, { ctrlKey: true }), false);
  app.releaseKey("Control");
  assert.equal(app.padMode.checked, false);
  app.pressKey("Control", 0, { ctrlKey: true });
  app.pointerDown();
  app.releaseKey("Control");
  assert.equal(app.padMode.checked, false);
  app.pressKey("Control", 0, { ctrlKey: true });
  app.blurWindow();
  app.releaseKey("Control");
  assert.equal(app.padMode.checked, false);
  app.pressKey("Control", 0, { ctrlKey: true, shiftKey: true });
  app.releaseKey("Control", { shiftKey: true });
  assert.equal(app.padMode.checked, false);
  app.pressKey("Control", 0, { ctrlKey: true });
  app.releaseKey("Control");
  assert.equal(app.padMode.checked, true);
  assert.equal(app.padControls("1")[1].hidden, false);
});

Deno.test("pad rec mode captures clicks and keys without playing or editing the sequence", async () => {
  const messages = [];
  const app = await setup({
    prohibitedPads: ["4"],
    saved: { sequence: ["0", "1", "2", "3", "4", "5", "6", "7"] },
    sendMessage: async (_tab, message) => {
      messages.push(message);
      return { ok: true, timecode: message.key === "4" ? 42.375 : 18.5 };
    }
  });
  app.connect();
  app.updateState({ playing: false, videoId: "first" });
  assert.equal(app.padMode.checked, true);
  app.setPadMode(false);
  assert.equal(app.padMode.attributes["aria-label"], "pad mode: rec");
  assert.equal(app.padButton("4").attributes["aria-label"], "record current time on pad 4");
  app.selectStep(0);
  await app.clickPad("4");
  app.pressKey("5");
  await app.settle();
  assert.deepEqual(messages.map(message => [message.type, message.key]), [
    ["yt-step-sequencer:record", "4"],
    ["yt-step-sequencer:record", "5"]
  ]);
  assert.equal(app.steps.children[0].children[0].value, "0");
  assert.equal(app.steps.children[0].classList.contains("selected"), true);
  assert.deepEqual(app.storageSets.at(-1).recordedPadTimesByVideo.first, { "4": 42.375, "5": 18.5 });

  app.setPadMode(true);
  assert.equal(app.padMode.attributes["aria-label"], "pad mode: play");
  await app.clickPad("6");
  await app.settle();
  assert.equal(messages.at(-1).type, "yt-step-sequencer:trigger");
  assert.equal(app.steps.children[0].children[0].value, "6");
});

Deno.test("rec mode highlights held number keys and clears on release, mode change, or blur", async () => {
  const messages = [];
  const app = await setup({
    sendMessage: async (_tab, message) => {
      messages.push(message);
      return { ok: true, timecode: 12 };
    }
  });
  app.connect();
  app.updateState({ playing: false });
  app.setPadMode(false);
  app.pressKey("1");
  app.pressKey("2");
  assert.equal(app.padButton("1").classList.contains("record-pressed"), true);
  assert.equal(app.padButton("2").classList.contains("record-pressed"), true);
  app.releaseKey("1");
  assert.equal(app.padButton("1").classList.contains("record-pressed"), false);
  assert.equal(app.padButton("2").classList.contains("record-pressed"), true);
  app.blurWindow();
  assert.equal(app.padButton("2").classList.contains("record-pressed"), false);
  app.pressKey("3");
  app.setPadMode(true);
  assert.equal(app.padButton("3").classList.contains("record-pressed"), false);
  await app.settle();
  assert.equal(messages.filter(message => message.type.endsWith(":record")).length, 3);
});

Deno.test("another tab of the same video cannot change this voice's pads or sequence", async () => {
  const messages = [];
  const app = await setup({
    connected: true,
    saved: { sequence: ["1", "2"], recordedPadTimesByVideo: { first: { "1": 12 } } },
    sendMessage: async (_tab, message) => {
      messages.push(message);
      if (message.type.endsWith(":status")) {
        return { ok: true, playing: false, videoId: "first", videoDuration: 100 };
      }
      return { ok: true };
    }
  });
  let otherVoice;
  app.updateSession(session => {
    otherVoice = session.voices["2"] = {
      tabId: 2, videoId: "first", sequence: ["8", "9"], lockedSteps: [],
      prohibitedPads: [], randomize: false, includeEmptySteps: true
    };
    session.recordedPadTimesByTab["2"] = { first: { "1": 33 } };
    session.lockedPadsByTab["2"] = { first: ["1"] };
  });
  await app.settle();
  assert.equal(app.padButton("1").textContent, "00:12.00");
  assert.equal(app.padControls("1")[4].attributes["aria-pressed"], "false");
  assert.equal(app.steps.children[0].children[0].value, "1");
  app.clear();
  await app.settle();
  assert.equal(app.steps.children[0].children[0].value, "");
  assert.deepEqual(otherVoice.sequence, ["8", "9"]);
  assert.equal(messages.some(message => message.type.endsWith(":update")), false);
});

Deno.test("pad locks prevent recording and reset but allow playback", async () => {
  const messages = [];
  const app = await setup({
    connected: true,
    saved: { recordedPadTimesByVideo: { first: { "1": 12, "2": 24 } } },
    sendMessage: async (_tab, message) => {
      messages.push(message);
      if (message.type.endsWith(":status")) {
        return { ok: true, playing: false, videoId: "first", videoDuration: 100 };
      }
      if (message.type.endsWith(":record")) return { ok: true, timecode: 33 };
      return { ok: true, playing: false };
    }
  });
  messages.length = 0;
  app.lockPad("1");
  await app.settle();
  const [forbid, record, scrub, undo, lock] = app.padControls("1");
  assert.equal(lock.attributes["aria-pressed"], "true");
  assert.equal(app.padButton("1").disabled, false);
  assert.equal(forbid.disabled, false);
  assert.equal(record.disabled && scrub.disabled && undo.disabled, true);
  app.setPadMode(false);
  await app.clickPad("1");
  app.pressKey("1");
  app.startPadScrub("1");
  undo.listeners.click();
  await app.settle();
  assert.equal(messages.length, 0);
  assert.match(app.status.textContent, /pad locked/);
  app.setPadMode(true);
  await app.clickPad("1");
  assert.equal(messages.at(-1).type, "yt-step-sequencer:trigger");
  assert.equal(messages.at(-1).timecode, 12);
  app.reset();
  await app.settle();
  assert.equal(app.padButton("1").textContent, "00:12.00");
  assert.equal(app.padButton("2").textContent, "2");
  assert.equal(lock.attributes["aria-pressed"], "true");
  app.lockPad("1");
  await app.settle();
  assert.equal(app.status.classList.contains("error"), false);
  app.setPadMode(false);
  await app.clickPad("1");
  await app.settle();
  assert.equal(app.padButton("1").textContent, "00:33.00");
});

Deno.test("a lock from another window cancels an active pad scrub", async () => {
  const app = await setup({
    connected: true,
    saved: { recordedPadTimesByVideo: { first: { "1": 12 } } },
    sendMessage: async (_tab, message) => message.type.endsWith(":status")
      ? { ok: true, playing: false, videoId: "first", videoDuration: 100 }
      : { ok: true }
  });
  app.startPadScrub("1");
  app.scrubMove(10);
  assert.equal(app.padButton("1").textContent, "00:13.00");
  app.updateSession(session => { session.lockedPadsByTab["1"].first = ["1"]; });
  app.finishScrub();
  await app.settle();
  assert.equal(app.padButton("1").textContent, "00:12.00");
  assert.match(app.status.textContent, /pad locked/);
  assert.equal(app.padControls("1")[4].attributes["aria-pressed"], "true");
  assert.ok(!app.storageSets.some(value => value.recordedPadTimesByVideo));
});

Deno.test("a pad locked while recording cannot be overwritten by the pending capture", async () => {
  let resolveRecord;
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const app = await setup({
    connected: true,
    saved: { recordedPadTimesByVideo: { first: { "1": 12 } } },
    sendMessage: async (_tab, message) => {
      if (message.type.endsWith(":status")) {
        return { ok: true, playing: false, videoId: "first", videoDuration: 100 };
      }
      if (message.type.endsWith(":record")) {
        signalStarted();
        return new Promise(resolve => { resolveRecord = resolve; });
      }
      return { ok: true };
    }
  });
  app.setPadMode(false);
  app.clickPad("1");
  await started;
  app.updateSession(session => { session.lockedPadsByTab["1"].first = ["1"]; });
  resolveRecord({ ok: true, timecode: 33 });
  await app.settle();
  assert.equal(app.padButton("1").textContent, "00:12.00");
  assert.match(app.status.textContent, /unlock the pad/);
});

Deno.test("pad rec mode hides only the record icons and restores them in play mode", async () => {
  const app = await setup();
  for (const key of "1234567890") {
    assert.ok(!app.padControls(key)[1].hidden);
  }
  app.setPadMode(false);
  for (const key of "1234567890") {
    const [prohibit, record, scrubber, undo] = app.padControls(key);
    assert.equal(record.hidden, true);
    assert.ok(!prohibit.hidden && !scrubber.hidden && !undo.hidden);
  }
  app.setPadMode(true);
  for (const key of "1234567890") {
    assert.equal(app.padControls(key)[1].hidden, false);
  }
});

Deno.test("pad mode is disabled when pads are unavailable", async () => {
  const app = await setup();
  assert.equal(app.padMode.disabled, true);
  app.connect();
  app.updateState({ playing: false });
  assert.equal(app.padMode.disabled, false);
});

Deno.test("pad rec mode updates pad times while the sequence is playing", async () => {
  const messages = [];
  const app = await setup({
    sendMessage: async (_tab, message) => {
      messages.push(message);
      return { ok: true, timecode: 12.5 };
    }
  });
  app.connect();
  app.updateState({ playing: true, videoId: "first" });
  app.setPadMode(false);
  await app.clickPad("5", { detail: 1, timeStamp: 223 });
  await app.settle();
  assert.deepEqual(messages.map(message => message.type), [
    "yt-step-sequencer:record", "yt-step-sequencer:update"
  ]);
  assert.deepEqual(app.storageSets.at(-1).recordedPadTimesByVideo.first, { "5": 12.5 });
});

Deno.test("pad mode switch leaves Enter and arrow keys available and pad recording errors visible", async () => {
  const messages = [];
  const app = await setup({
    sendMessage: async (_tab, message) => {
      messages.push(message);
      return { ok: false, error: "time unavailable" };
    }
  });
  app.connect();
  app.updateState({ playing: false, videoId: "first" });
  app.selectStep(0);
  app.padMode.focus();
  assert.equal(app.pressKey("Enter"), false);
  assert.equal(app.pressKey("ArrowLeft"), false);
  app.setPadMode(false);
  app.pressKey("2");
  await app.settle();
  assert.equal(app.status.textContent, "time unavailable");
  assert.equal(app.steps.children[0].classList.contains("selected"), true);
  app.setPadMode(true);
  app.recordPad("3");
  await app.settle();
  assert.deepEqual(messages.map(message => [message.type, message.key]), [
    ["yt-step-sequencer:record", "2"], ["yt-step-sequencer:record", "3"]
  ]);
});

Deno.test("transport starts and stops the saved pattern without changing the metronome", async () => {
  const messages = [];
  const app = await setup({
    saved: { sequence: ["4", "1", "2"], lockedSteps: [0] },
    sendMessage: async (_tab, message) => {
      messages.push(message);
      if (message.type.endsWith(":play")) {
        return {
          ok: true, playing: true, sequence: message.sequence, bpm: message.bpm,
          currentStep: 0, stepSerial: 1, metronomeEnabled: true
        };
      }
      return { ok: true, playing: false, metronomeEnabled: true };
    }
  });
  app.connect();
  app.updateState({ playing: false, metronomeEnabled: true });
  await app.form.listeners.submit({ preventDefault() {} });
  assert.deepEqual([...messages[0].sequence], ["4", "1", "2"]);
  assert.deepEqual([...messages[0].lockedSteps], [0]);
  assert.equal(app.transport.attributes["aria-label"], "stop");
  await app.form.listeners.submit({ preventDefault() {} });
  assert.deepEqual(messages.map(message => message.type), [
    "yt-step-sequencer:play", "yt-step-sequencer:stop"
  ]);
  assert.equal(app.metronome.checked, true);
  assert.equal(app.transport.attributes["aria-label"], "play");
});

Deno.test("video icon follows playback state and reports toggle errors", async () => {
  const messages = [];
  let fail = false;
  const app = await setup({
    sendMessage: async (_tab, message) => {
      messages.push(message);
      if (fail) return { ok: false, error: "video blocked" };
      return { ok: true, playing: true, videoPaused: true };
    }
  });
  app.connect();
  app.updateState({ playing: true, videoPaused: false });
  assert.equal(app.videoPlayback.attributes["aria-label"], "pause video");
  app.toggleVideo();
  assert.equal(app.videoPlayback.disabled, true);
  await app.settle();
  assert.equal(messages.at(-1).type, "yt-step-sequencer:video-toggle");
  assert.equal(app.videoPlayback.attributes["aria-label"], "play video");
  assert.equal(app.videoPlayback.disabled, false);
  fail = true;
  app.toggleVideo();
  await app.settle();
  assert.equal(app.status.textContent, "video blocked");
  assert.equal(app.videoPlayback.disabled, false);
  app.updateState({ playing: true, videoPaused: null });
  assert.equal(app.videoPlayback.disabled, true);
});
