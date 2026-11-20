import { strict as assert } from "node:assert";
import { createContext, runInContext } from "node:vm";

const source = await Deno.readTextFile(new URL("../popup.js", import.meta.url));

async function setup({ left = 100, right = 1000, width = 412, prohibitedPads = [], saved = {}, sendMessage, connected = false } = {}) {
  const popup = { id: 1, left, top: 100, width, height: 460 };
  const updates = [];
  const errors = [];
  const storageSets = [];
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
    documentElement: { scrollHeight: 460 }
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

  const context = createContext({
    document,
    window: { innerHeight: 460, get innerWidth() { return popup.width; } },
    location: { search: connected ? "?tabId=1" : "" },
    URL,
    URLSearchParams,
    Event,
    performance: { timeOrigin: 1000000 },
    Date: { now: () => now },
    console: { error: (...args) => errors.push(args) },
    chrome: {
      tabs: {
        sendMessage,
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
    record: () => elements.get("#sequence-record").listeners.click(),
    recordButton: elements.get("#sequence-record"),
    settings: elements.get("#settings"),
    transport: elements.get("#transport"),
    videoPlayback: elements.get("#video-playback"),
    toggleVideo: () => elements.get("#video-playback").listeners.click(),
    emit: message => portMessage(message),
    isPadForbidden: key => runInContext(`prohibitedPads.has("${key}")`, context),
    isPadMarkedForbidden: key => runInContext(
      `padContainers.get("${key}").classList.contains("pad-prohibited")`, context
    ),
    connect: () => runInContext("tabId = 1", context),
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
    pressPad: (key, timeStamp) =>
      elements.get("#pads").children["1234567890".indexOf(key)].children[0]
        .listeners.pointerdown({ button: 0, timeStamp }),
    form: elements.get("#sequencer"),
    activeElement: () => document.activeElement,
    updateState: state => { context.testState = state; runInContext("updateState(testState)", context); },
    settle: () => runInContext("commandQueue", context)
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
  assert.equal(app.steps.children[0].children[0].value, "4");
  assert.equal(app.steps.children[1].children[0].value, "1");
  assert.equal(app.steps.children[8].children[0].value, "9");
  app.lock(8);
  await app.settle();
  assert.equal(app.removeButton.disabled, false);
  assert.ok(app.storageSets.some(value => JSON.stringify(value.lockedSteps) === "[0]"));
  app.remove();
  await app.settle();
  assert.equal(app.steps.children.length, 8);
});

Deno.test("reopening during playback uses the live sequence and locks instead of stale storage", async () => {
  const messages = [];
  const app = await setup({
    connected: true,
    saved: { sequence: ["0"], lockedSteps: [0] },
    sendMessage: async (_tab, message) => {
      messages.push(message);
      if (message.type.endsWith(":status")) {
        return {
          ok: true, playing: true, sequence: ["0", "7"], lockedSteps: [1],
          bpm: 120, currentStep: 0, stepSerial: 1
        };
      }
      return { ok: true };
    }
  });
  assert.equal(app.steps.children.length, 2);
  assert.equal(app.steps.children[0].children[0].readOnly, false);
  assert.equal(app.steps.children[1].children[0].readOnly, true);
  assert.equal(messages.some(message => message.type.endsWith(":locks")), false);
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

Deno.test("recording clears only unlocked steps and sends locks to the sequencer", async () => {
  const messages = [];
  const app = await setup({
    saved: { sequence: ["4", "1", "2"], lockedSteps: [0] },
    sendMessage: async (_tab, message) => {
      messages.push(message);
      if (message.type.endsWith(":metronome")) return { ok: true, metronomeEnabled: true };
      return { ok: true, playing: true, recordingSequence: true, metronomeEnabled: true };
    }
  });
  app.connect();
  app.updateState({ playing: false });
  app.record();
  await app.settle();
  const play = messages.find(message => message.type.endsWith(":play"));
  assert.deepEqual([...play.sequence], ["4", "", ""]);
  assert.deepEqual([...play.lockedSteps], [0]);
});

Deno.test("metronome checkbox follows tab state and reports failed changes", async () => {
  const messages = [];
  const app = await setup({
    sendMessage: async (_tab, message) => {
      messages.push(message);
      return message.enabled
        ? { ok: true, metronomeEnabled: true }
        : { ok: false, error: "audio error" };
    }
  });
  app.connect();
  app.updateState({ playing: false, metronomeEnabled: true });
  assert.equal(app.metronome.checked, true);
  app.metronome.checked = false;
  app.metronome.listeners.change();
  await app.settle();
  assert.equal(messages[0].type, "yt-step-sequencer:metronome");
  assert.equal(messages[0].enabled, false);
  assert.equal(app.metronome.checked, true);
  assert.equal(app.status.textContent, "audio error");
  app.metronome.checked = true;
  app.metronome.listeners.change();
  await app.settle();
  assert.equal(app.metronome.checked, true);
  assert.equal(messages[1].enabled, true);
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

Deno.test("record button clears the pattern and leaves playback running after recording", async () => {
  const messages = [];
  const app = await setup({
    sendMessage: async (_tab, message) => {
      messages.push(message);
      if (message.type.endsWith(":metronome")) return { ok: true, metronomeEnabled: message.enabled };
      if (message.type.endsWith(":play")) {
        return {
          ok: true, playing: true, sequence: message.sequence, bpm: message.bpm,
          currentStep: 0, stepSerial: 1, recordingSequence: true, metronomeEnabled: true
        };
      }
      if (message.type.endsWith(":finish-recording")) {
        return { ok: true, playing: true, recordingSequence: false, metronomeEnabled: false };
      }
      return { ok: true };
    }
  });
  app.connect();
  app.updateState({ playing: false });
  app.record();
  await app.settle();
  assert.deepEqual(messages.map(message => message.type), [
    "yt-step-sequencer:metronome", "yt-step-sequencer:play"
  ]);
  assert.equal(messages[1].recordingSequence, true);
  assert.deepEqual([...messages[1].sequence], Array(8).fill(""));
  assert.ok(app.storageSets.some(value => value.sequence?.every(step => step === "")));
  assert.equal(app.recordButton.attributes["aria-pressed"], "true");
  assert.equal(app.metronome.checked, true);
  assert.equal(app.metronome.disabled, true);

  app.selectStep(3);
  await app.clickPad("5");
  assert.equal(app.steps.children[3].children[0].value, "");
  assert.equal(app.steps.children[3].classList.contains("selected"), true);

  app.record();
  await app.settle();
  assert.equal(messages.at(-1).type, "yt-step-sequencer:finish-recording");
  assert.equal(app.recordButton.attributes["aria-pressed"], "false");
  assert.equal(app.metronome.checked, false);
  assert.equal(app.metronome.disabled, false);
  assert.equal(app.transport.attributes["aria-label"], "stop");
});

Deno.test("reopened window follows recording state and recorded step updates", async () => {
  const app = await setup({
    connected: true,
    sendMessage: async (_tab, message) => {
      if (message.type.endsWith(":status")) {
        return {
          ok: true, playing: true, recordingSequence: true, metronomeEnabled: true,
          sequence: ["2", "", "", ""], bpm: 120, currentStep: 1, stepSerial: 2
        };
      }
      return { ok: true };
    }
  });
  assert.equal(app.recordButton.attributes["aria-pressed"], "true");
  assert.equal(app.steps.children[0].children[0].value, "2");
  app.emit({ recordingSequence: true, recordedStep: 2, sequence: ["2", "", "7", ""], currentStep: 2, stepSerial: 3 });
  assert.equal(app.steps.children[2].children[0].value, "7");
  assert.equal(app.steps.children[2].classList.contains("active"), true);
  app.emit({ playing: true, recordingSequence: false, metronomeEnabled: false, recordingFinished: true });
  assert.equal(app.recordButton.attributes["aria-pressed"], "false");
  assert.equal(app.metronome.checked, false);
  assert.equal(app.transport.attributes["aria-label"], "stop");
});

Deno.test("recording sends pad press timestamps without triggering twice on mouse release", async () => {
  const messages = [];
  const app = await setup({
    sendMessage: async (_tab, message) => { messages.push(message); return { ok: true }; }
  });
  app.connect();
  app.updateState({ playing: true, recordingSequence: true, metronomeEnabled: true });
  app.pressPad("5", 123);
  await app.clickPad("5", { detail: 1, timeStamp: 223 });
  app.pressKey("6", 300);
  await app.clickPad("7", { detail: 0, timeStamp: 400 });
  assert.deepEqual(messages.map(message => [message.key, message.pressedAt]), [
    ["5", 1000123], ["6", 1000300], ["7", 1000400]
  ]);
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

Deno.test("starting recording during playback restarts with a cleared pattern", async () => {
  const messages = [];
  const app = await setup({
    sendMessage: async (_tab, message) => {
      messages.push(message);
      if (message.type.endsWith(":stop")) {
        return { ok: true, playing: false, recordingSequence: false, metronomeEnabled: false };
      }
      if (message.type.endsWith(":metronome")) return { ok: true, metronomeEnabled: true };
      return {
        ok: true, playing: true, sequence: message.sequence, bpm: message.bpm,
        currentStep: 0, stepSerial: 2, recordingSequence: true, metronomeEnabled: true
      };
    }
  });
  app.connect();
  app.updateState({ playing: true, currentStep: 3, stepSerial: 1 });
  app.record();
  await app.settle();
  assert.deepEqual(messages.map(message => message.type), [
    "yt-step-sequencer:stop", "yt-step-sequencer:metronome", "yt-step-sequencer:play"
  ]);
  assert.deepEqual([...messages[2].sequence], Array(8).fill(""));
  assert.equal(app.steps.children[0].classList.contains("active"), true);
});

Deno.test("recording reports a metronome startup failure and leaves controls usable", async () => {
  const messages = [];
  const app = await setup({
    sendMessage: async (_tab, message) => {
      messages.push(message);
      if (message.type.endsWith(":metronome") && message.enabled) {
        return { ok: false, error: "audio blocked" };
      }
      return { ok: true, metronomeEnabled: false };
    }
  });
  app.connect();
  app.updateState({ playing: false });
  app.record();
  await app.settle();
  assert.equal(app.status.textContent, "audio blocked");
  assert.equal(app.recordButton.disabled, false);
  assert.equal(app.metronome.checked, false);
  assert.deepEqual(messages.map(message => message.enabled), [true, false]);
});
