import { strict as assert } from "node:assert";
import { runInNewContext } from "node:vm";

const source = await Deno.readTextFile(new URL("../background.js", import.meta.url));

Deno.test("opens a separate sequencer window for the clicked tab", async () => {
  let handler;
  const windows = [];
  runInNewContext(source, {
    chrome: {
      action: { onClicked: { addListener: fn => { handler = fn; } } },
      windows: { create: async options => { windows.push(options); } }
    },
    console
  });
  await handler({ id: 42 });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].url, "popup.html?tabId=42");
  assert.equal(windows[0].type, "popup");
  assert.ok(windows[0].width >= 360);
  assert.ok(windows[0].height > 0);
});

Deno.test("reports window creation errors", async () => {
  let handler;
  const errors = [];
  runInNewContext(source, {
    chrome: {
      action: { onClicked: { addListener: fn => { handler = fn; } } },
      windows: { create: async () => { throw new Error("failed"); } }
    },
    console: { error: (...args) => errors.push(args) }
  });
  await handler({});
  await handler({ id: 42 });
  assert.equal(errors.length, 2);
});
