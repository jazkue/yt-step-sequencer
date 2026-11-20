import { strict as assert } from "node:assert";
import { createContext, runInContext } from "node:vm";

const source = await Deno.readTextFile(new URL("../popup.js", import.meta.url));

async function setup({ left = 100, right = 1000, width = 412, prohibitedPads = [], sendMessage } = {}) {
  const popup = { id: 1, left, top: 100, width, height: 460 };
  const updates = [];
  const errors = [];
  const storageSets = [];
  let now = 0;

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

    addEventListener(type, listener) { this.listeners[type] = listener; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
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
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new Element());
      return elements.get(selector);
    },
    createElement: () => new Element(),
    addEventListener() {},
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
    location: { search: "" },
    URLSearchParams,
    Date: { now: () => now },
    console: { error: (...args) => errors.push(args) },
    chrome: {
      tabs: { sendMessage },
      storage: {
        local: {
          get: async () => ({ prohibitedPads }),
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
    setTimeout, clearTimeout
  });
  runInContext(source.replace("initialize();", "globalThis.initialized = initialize();"), context);
  await context.initialized;
  return {
    popup, updates, errors, steps, storageSets,
    add: () => elements.get("#add-step").listeners.click(),
    remove: () => elements.get("#remove-step").listeners.click(),
    reset: () => elements.get("#reset").listeners.click(),
    isPadForbidden: key => runInContext(`prohibitedPads.has("${key}")`, context),
    isPadMarkedForbidden: key => runInContext(
      `padContainers.get("${key}").classList.contains("pad-prohibited")`, context
    ),
    connect: () => runInContext("tabId = 1", context),
    metronome: elements.get("#metronome"),
    bpm: elements.get("#bpm"),
    status: elements.get("#status"),
    tap: time => { now = time; elements.get("#tap-tempo").listeners.click(); },
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
