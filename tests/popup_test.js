import { strict as assert } from "node:assert";
import { createContext, runInContext } from "node:vm";

const source = await Deno.readTextFile(new URL("../popup.js", import.meta.url));

async function setup({
  left = 100, right = 1000, width = 412, frameHeight = 0, contentHeight = 460,
  prohibitedPads = [], saved = {}, sendMessage, connected = false
} = {}) {
  const popup = { id: 1, left, top: 100, width, height: 460 };
  const updates = [];
  const errors = [];
  const storageSets = [];
  const session = {
    bpm: saved.bpm || 120, length: saved.sequence?.length || 8, playing: false,
    clock: null, clockVersion: 0, metronome: false, resetVersion: 0, voices: {},
    recordedPadTimesByVideo: saved.recordedPadTimesByVideo || {}
  };
  let chorusListener;
  let now = 0;
  let portMessage;

  class Element {
    children = [];
    listeners = {};
    dataset = {};
    attributes = {};
    classList = {
      values: new Set(),
      add(value) { this.values.add(value); },
      remove(value) { this.values.delete(value); },
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
    window: { get innerHeight() { return popup.height - frameHeight; }, get innerWidth() { return popup.width; } },
    location: { search: connected ? "?tabId=1" : "" },
    URL,
    URLSearchParams,
    Event,
    performance: { timeOrigin: 1000000 },
    Date: { now: () => now },
    console: { error: (...args) => errors.push(args), warn() {} },
    chrome: {
      runtime: {
        connect: () => ({
          onMessage: { addListener: listener => { chorusListener = listener; } },
          onDisconnect: { addListener() {} }
        }),
        sendMessage: async message => {
          const voice = session.voices["1"];
          if (message.type.endsWith(":chorus-register")) {
            session.voices["1"] = voice || {
              tabId: message.tabId, videoId: message.videoId,
              sequence: saved.sequence || Array.from({ length: 8 }, (_, index) => String(index)),
              lockedSteps: saved.lockedSteps || [], prohibitedPads,
              recordedPadTimesByVideo: saved.recordedPadTimesByVideo || {},
              randomize: saved.randomize || false, includeEmptySteps: saved.includeEmptySteps !== false
            };
          } else if (message.type.endsWith(":chorus-voice")) {
            Object.assign(voice, message.changes);
            if (message.padTime) {
              if (message.padTime.times === null) delete session.recordedPadTimesByVideo[message.padTime.videoId];
              else session.recordedPadTimesByVideo[message.padTime.videoId] = message.padTime.times;
            }
            storageSets.push(JSON.parse(JSON.stringify({
              ...message.changes,
              ...(message.padTime && { recordedPadTimesByVideo: session.recordedPadTimesByVideo })
            })));
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
                item.lockedSteps.includes(index) ? item.sequence[index] : String(index)
              );
              item.prohibitedPads = [];
              item.randomize = false;
              if (item.videoId) delete session.recordedPadTimesByVideo[item.videoId];
              storageSets.push({ prohibitedPads: [] });
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
    padButton: key => elements.get("#pads").children["1234567890".indexOf(key)].children[0],
    padControls: key => elements.get("#pads").children["1234567890".indexOf(key)].children.slice(1),
    settings: elements.get("#settings"),
    transport: elements.get("#transport"),
    videoPlayback: elements.get("#video-playback"),
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
    status: elements.get("#status"),
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
  assert.equal(app.steps.children[1].children[0].value, "1");
  assert.equal(app.isPadForbidden("1"), false);
  assert.deepEqual(messages.map(message => message.type), [
    "yt-step-sequencer:prohibited", "yt-step-sequencer:update",
    "yt-step-sequencer:update", "yt-step-sequencer:update"
  ]);
  assert.equal(messages[1].randomize, false);
  assert.equal(Object.keys(messages[2].recordedPadTimes).length, 0);
  assert.deepEqual([...messages[3].sequence], ["9", "1", "2", "3", "4", "5", "6", "7"]);
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
    session.voices["1"].sequence = ["0", "1", "2", "3", "4", "5", "6", "7"];
    session.length = 8;
    session.voices["1"].prohibitedPads = [];
    session.voices["1"].randomize = false;
    session.resetVersion++;
  });
  await app.settle();
  assert.equal(app.steps.children[0].children[0].value, "0");
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
  assert.equal(app.steps.children[1].children[0].value, "1");
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

Deno.test("pad rec mode captures clicks and keys without playing or editing the sequence", async () => {
  const messages = [];
  const app = await setup({
    prohibitedPads: ["4"],
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
