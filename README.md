# youtube step sequencer

<img width="403" height="421" alt="Screenshot 2026-11-14 at 4 40 27 PM" src="https://github.com/user-attachments/assets/6e5be946-55bb-43e8-b7a5-ffdf0ee13781" />

## install

1. Open `chrome://extensions`, enable developer mode, and select **load unpacked**.
2. Select this folder, open or refresh a YouTube video, and click the extension icon.

## use

- Set steps to digits `0–9` or leave them empty to continue playback without a jump. Use **+** and the trash icon after the last step to add or remove steps (at least one remains). The window fits the saved sequence when opened, up to the display size; resize it to see more steps added afterward. Set the bpm and press play.
- Click pads or use number keys to play live. The highlighted pad shows the last digit played by the sequencer, including through empty steps. Select a step to assign a pad; use **step** or Enter to advance, and Escape to deselect.
- Use the small forbidden icon on a pad to mute it and exclude it from playback and randomization. The **empty steps when randomizing** checkbox controls whether **randomize** can add empty steps. Use **clear** to empty the pattern or **reset** to restore eight steps. Steps and bpm can be edited during playback.
- Use a pad's record icon to assign the current video time to that pad. Its label shows the recorded time; default pads show their time when hovered. Hovering either shows the precise timecode in a tooltip. Recordings are saved per video; **reset** clears them and restores the default 0–9 seek positions.
- If playback is blocked, reload YouTube and try again.
