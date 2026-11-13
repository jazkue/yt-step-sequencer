chrome.action.onClicked.addListener(async tab => {
  if (!Number.isInteger(tab.id)) {
    console.error("Could not open the sequencer: the tab has no ID.");
    return;
  }
  try {
    await chrome.windows.create({
      url: `popup.html?tabId=${tab.id}`,
      type: "popup",
      width: 380,
      height: 460
    });
  } catch (error) {
    console.error("Could not open the sequencer window:", error);
  }
});
