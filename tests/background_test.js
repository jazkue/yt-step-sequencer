import { strict as assert } from "node:assert";
import { runInNewContext } from "node:vm";

const source = await Deno.readTextFile(new URL("../background.js", import.meta.url));

function setup({ sourceWindow, displays, create = async () => {}, open = [] }) {
  let handler;
  const windows = [];
  const errors = [];
  const removed = [];
  runInNewContext(source, {
    chrome: {
      action: { onClicked: { addListener: fn => { handler = fn; } } },
      windows: {
        get: async () => sourceWindow,
        getAll: async () => open,
        remove: async id => { removed.push(id); },
        create: async options => { windows.push(options); await create(options); }
      },
      runtime: { getURL: path => `chrome-extension://abc/${path}` },
      system: { display: { getInfo: async () => displays } }
    },
    console: { error: (...args) => errors.push(args) }
  });
  return { handler, windows, errors, removed };
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

Deno.test("closes the existing sequencer window for the same tab and opens a fresh one", async () => {
  const app = setup({
    sourceWindow: { left: 0, top: 0, width: 800, height: 600 },
    displays: [primary],
    open: [
      { id: 5, tabs: [{ url: "chrome-extension://abc/popup.html?tabId=41" }] },
      { id: 6, tabs: [{ url: "chrome-extension://abc/popup.html?tabId=42" }] }
    ]
  });
  await app.handler({ id: 42, windowId: 7 });
  assert.deepEqual(app.removed, [6]);
  assert.equal(app.windows.length, 1);
});
