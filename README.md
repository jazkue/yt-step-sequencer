# youtube step sequencer

<img width="410" height="419" alt="Untitled" src="https://github.com/user-attachments/assets/1edacb49-5f16-4b93-8f42-167658d98693" />


## install

1. Open `chrome://extensions`, enable developer mode, and select **load unpacked**.
2. Select this folder, open or refresh a YouTube video, and click the extension icon.

## use

- Click the extension icon to bring all existing sequencer windows to the front. When none are open, it creates one for the current tab.
- Use **+** beside the menu to choose another open YouTube video. Select a video to add a voice in a new sequencer window, or use **bring here** to replace this voice's video. If its video tab closes or navigates away, the window stays available to choose another video.
- All voices share play/stop, bpm, step count, position and one metronome. Each voice has its own step values, locks, pads and randomization controls. A voice added during playback joins on the next beat. Live bpm changes take effect on a future shared beat; speeding up can shorten the current beat. Timing uses a shared clock, but YouTube buffering and browser scheduling can cause audible delays.
- Set steps to digits `0–9` or leave them empty to continue playback without a jump. Use **+** and the trash icon after the last step to add or remove a step in every voice (at least one remains). Unlock the last step in all voices before removing it. Windows grow and shrink with the sequence up to the display edge; scroll the step row to reach steps that don't fit. Set the bpm to a whole number from 1 to 999 and press play.
- Use the play/pause icon next to the video title, or press Space when a control or text field is not focused, to control YouTube playback independently of the sequencer. Playing a pad resumes the video.
- Use the vertical slider beside the title to control that video's volume. Moving it above zero unmutes the video.
- Use the left and right arrow keys to seek the video by five seconds, except while editing a step or bpm.
- Toggle the shared metronome next to **tap** to hear a high beat at the start of each sequence and a lower beat on every other step, including empty steps.
- Click pads or use number keys to play live. The highlighted pad shows the last digit played by the sequencer, including through empty steps. Select a step to assign a pad and advance automatically; use Space or Tab to make it empty and advance, **step** or Enter to skip, and Escape to deselect.
- Use the **rec / play** switch above the pads, or tap **Ctrl**, to change what pad clicks and number keys do. In **rec**, they assign the current video time to the pad without playing it or editing the sequence, and the pad turns red while held; in **play**, they work normally. The switch starts in **play** each time the window opens. A running sequence continues playing in either mode.
- Use the lock on a step to protect its value from edits, randomization, clear, and reset. Use the small forbidden icon on a pad to mute it and exclude it from playback and randomization. The **empty steps when randomizing** checkbox controls whether **randomize** can add empty steps. Use **clear** to empty unlocked steps in this voice, or **reset** to restore eight steps and unlocked defaults across all voices. Unlock steps after step 8 in every voice before resetting. Steps and bpm can be edited during playback.
- Use a pad's record icon to assign the current video time to that pad. Its label shows the recorded time; default pads show their time when hovered. Hovering either shows the precise timecode in a tooltip. Use the pad lock to protect its time from recording, scrubbing, restoring, and **reset**, without preventing playback. Pad times and locks are shared by windows controlling the same video during the session.
- In play mode, pad icons appear on hover or keyboard focus; forbidden and recorded indicators stay visible. In rec mode, the pad record icon is hidden.
- Closing the last sequencer window stops all voices and resets the session, including recorded pad times.
- If playback is blocked, reload YouTube and try again.
