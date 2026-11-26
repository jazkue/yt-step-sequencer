# youtube step sequencer

<img width="410" height="419" alt="Untitled" src="https://github.com/user-attachments/assets/1edacb49-5f16-4b93-8f42-167658d98693" />


## install

1. Open `chrome://extensions`, enable developer mode, and select **load unpacked**.
2. Select this folder, open or refresh a YouTube video, and click the extension icon.

## use

- Click the extension icon to bring all existing sequencer windows to the front. When none are open, it creates one for the current tab.
- Use **+** beside the menu to choose another open YouTube video. Select a video to add a voice in a new sequencer window, or use **bring here** to replace this voice's video. If its video tab closes or navigates away, the window stays available to choose another video.
- All voices share play/stop, bpm, step count, position and one metronome. Each voice has its own step values, locks, pads and randomization controls. A voice added during playback joins on the next beat. Live bpm changes take effect on a future shared beat; speeding up can shorten the current beat. Timing uses a shared clock, but YouTube buffering and browser scheduling can cause audible delays.
- New voices start with empty steps. Set steps to digits `0–9` or leave them empty to continue playback without a jump. Alternating tints mark groups of four steps. Use **+** and the trash icon after the last step to add or remove a step in every voice (at least one remains). Unlock the last step in all voices before removing it. Windows grow and shrink with the sequence up to the display edge; scroll the step row to reach steps that don't fit. Set the bpm to a whole number from 1 to 999 and press play.
- Use the play/pause icon next to the video title, or press Space when a control or text field is not focused, to control YouTube playback independently of the sequencer. Playing a pad resumes the video.
- Use the vertical slider beside the title to control that video's volume. Moving it above zero unmutes the video; double-click it to restore full volume.
- Use the speed slider to control playback from 0.25x to 2x in 0.01x increments. Dragging between 0.95x and 1.05x snaps to 1x; use the arrow keys for precise values in that range. Double-click to reset to 1x. The selected video starts at 1x when a sequencer window connects, including when choosing a different video.
- Use the left and right arrow keys to seek the video by five seconds, except while editing a step or bpm.
- Toggle the shared metronome next to **tap** to hear a high beat at the start of each sequence and a lower beat on every other step, including empty steps.
- Click pads or use number keys to play live. The highlighted pad shows the last digit played by the sequencer, including through empty steps. Select a step to assign a pad and advance automatically; use Space or Tab to make it empty and advance, **step** or Enter to skip, and Escape to deselect.
- Use the **rec / play** switch above the pads, or tap **Ctrl**, to change what pad clicks and number keys do. In **rec**, they assign the current video time to the pad without playing it or editing the sequence, and the pad turns red while held; in **play**, they work normally. The switch starts in **play** each time the window opens. A running sequence continues playing in either mode.
- Use the lock on a step to protect its value from edits, randomization, clear, and reset. Use the small forbidden icon on a pad to mute it and exclude it from playback and randomization. The **empty steps when randomizing** checkbox controls whether **randomize** can add empty steps. Use **clear** to empty unlocked steps in this voice, or **reset** to restore eight steps, empty unlocked steps, and other unlocked defaults across all voices. Unlock steps after step 8 in every voice before resetting. Steps and bpm can be edited during playback.
- Use a pad's record icon to assign the current video time to that pad. Its label shows the recorded time; default pads show their time when hovered. Hovering either shows the precise timecode in a tooltip. Use the pad lock to protect its time from recording, scrubbing, restoring, and **reset**, without preventing playback. Pad times and locks are independent for each video tab, even when tabs show the same video.
- In play mode, pad icons appear on hover or keyboard focus; forbidden and recorded indicators stay visible. In rec mode, the pad record icon is hidden.
- Closing the last sequencer window stops all voices and resets the session, including recorded pad times.
- Use **close all windows** in the options menu to close all sequencer windows at once; YouTube windows stay open.
- If playback is blocked, reload YouTube and try again.
