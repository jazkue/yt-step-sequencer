# youtube step sequencer

<img width="410" height="416" alt="Screenshot 2026-11-20 at 12 35 24 PM" src="https://github.com/user-attachments/assets/19f6aa4b-fc9e-47de-885d-d0791a443ee5" />


## install

1. Open `chrome://extensions`, enable developer mode, and select **load unpacked**.
2. Select this folder, open or refresh a YouTube video, and click the extension icon.

## use

- Set steps to digits `0–9` or leave them empty to continue playback without a jump. Use **+** and the trash icon after the last step to add or remove steps (at least one remains). The window fits the saved sequence when opened, grows to the right as steps are added, and shrinks when they are removed, up to the display edge and down to its minimum size; scroll the step row to reach steps that don't fit. Set the bpm to a whole number from 1 to 999 and press play.
- Use the play/pause icon next to the video title, or press Space when a control or text field is not focused, to control YouTube playback independently of the sequencer. Playing a pad resumes the video.
- Use the left and right arrow keys to seek the video by five seconds, except while editing a step or bpm.
- Toggle the metronome next to **tap** to hear a high beat at the start of each sequence and a lower beat on every other step, including empty steps. It keeps playing with the sequence when the sequencer window is closed.
- Click pads or use number keys to play live. The highlighted pad shows the last digit played by the sequencer, including through empty steps. Select a step to assign a pad and advance automatically; use **step** or Enter to skip, and Escape to deselect.
- Use the **rec / play** switch above the pads to change what pad clicks and number keys do. In **rec**, they assign the current video time to the pad without playing it or editing the sequence; in **play**, they work normally. The switch starts in **play** each time the window opens. A running sequence continues playing in either mode.
- Use the lock on a step to protect its value from edits, randomization, clear, and reset. Unlock it before removing it. Locks are saved with the sequence; reset retains any extra steps needed to keep locked values. Use the small forbidden icon on a pad to mute it and exclude it from playback and randomization. The **empty steps when randomizing** checkbox controls whether **randomize** can add empty steps. Use **clear** to empty unlocked steps or **reset** to restore the unlocked defaults. Steps and bpm can be edited during playback.
- Use a pad's record icon to assign the current video time to that pad. Its label shows the recorded time; default pads show their time when hovered. Hovering either shows the precise timecode in a tooltip. Recordings are saved per video; **reset** clears them and restores the default 0–9 seek positions.
- In play mode, pad icons appear on hover or keyboard focus; forbidden and recorded indicators stay visible. In rec mode, the pad record icon is hidden.
- If playback is blocked, reload YouTube and try again.
