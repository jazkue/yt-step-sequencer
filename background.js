chrome.action.onClicked.addListener(async tab => {
  if (!Number.isInteger(tab.id)) {
    console.error("Could not open the sequencer: the tab has no ID.");
    return;
  }
  try {
    const popupUrl = chrome.runtime.getURL(`popup.html?tabId=${tab.id}`);
    const existing = (await chrome.windows.getAll({ populate: true, windowTypes: ["popup"] }))
      .find(window => window.tabs?.some(item => item.url === popupUrl));
    if (existing) {
      await chrome.windows.update(existing.id, { focused: true });
      return;
    }
    const [sourceWindow, displays] = await Promise.all([
      chrome.windows.get(tab.windowId),
      chrome.system.display.getInfo()
    ]);
    if (![sourceWindow.left, sourceWindow.top, sourceWindow.width, sourceWindow.height]
      .every(Number.isFinite)) {
      throw new Error("Could not determine the video window's position.");
    }
    const centerX = sourceWindow.left + sourceWindow.width / 2;
    const centerY = sourceWindow.top + sourceWindow.height / 2;
    const display = displays.find(({ bounds }) =>
      centerX >= bounds.left && centerX < bounds.left + bounds.width &&
      centerY >= bounds.top && centerY < bounds.top + bounds.height
    ) || displays.find(display => display.isPrimary);
    if (!display) throw new Error("Could not determine the display.");
    const area = display.workArea;
    const width = Math.min(380, area.width);
    const height = Math.min(460, area.height);
    await chrome.windows.create({
      url: `popup.html?tabId=${tab.id}`,
      type: "popup",
      width,
      height,
      left: Math.round(area.left + (area.width - width) / 2),
      top: Math.round(area.top + (area.height - height) / 2)
    });
  } catch (error) {
    console.error("Could not open the sequencer window:", error);
  }
});
