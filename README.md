# agent-voice

Hands-free voice conversation for coding agents. One package works as:

- a **Pi extension**, in the [Pi](https://github.com/earendil-works/pi) TUI and in [PiChamber](https://github.com/RyderAsKing/PiChamber)
- an **opencode 2.x plugin**, in the opencode TUI and in [OpenChamber](https://github.com/openchamber/openchamber)

Talk to the agent, pause, and your words are sent as a message. Replies are spoken sentence by
sentence while they stream. Start talking and the spoken reply stops so you can cut in; the agent keeps
working and takes your words as a steer. The agent keeps its
model, tools, skills, sessions and project behavior; voice is only another way in and out.

## How it works

Audio stays on the machine running the agent. No browser is involved, so it works the same in a
terminal or in a desktop or web client that talks to that machine.

```
microphone ─ native audio / ffmpeg ─ 16 kHz mono PCM ─▶ recognition websocket ─▶ transcript ─▶ agent
speakers ◀─ native audio / ffplay ◀─ WAV ◀─ /v1/audio/speech ◀─ sentences ◀─ streamed reply
```

- **macOS audio:** a small audio helper runs as a child of the native Pi/OpenCode plugin. It
  captures the selected microphone and plays through the selected output device using the same
  audio engine. With echo cancellation on, that is Apple's voice-processing engine; with it off, the
  plain device input is converted to the same 16 kHz mono stream (see `echoCancellation`). It has no
  window, focus watcher, or clipboard.
  Device choices use persistent CoreAudio IDs; a disconnected device produces an error.
  Bluetooth setup can briefly stop Apple's audio engine. Before reporting ready, the helper
  waits for live microphone frames and resets the engine and playback clock on the same confirmed route.
- **Other platforms:** FFmpeg captures 16 kHz mono PCM using DirectShow on Windows or PulseAudio
  on Linux. FFplay handles output.
- **Turn taking:** voice activity is measured on 20 ms frames. About 160 ms of speech opens an
  utterance, which includes 300 ms of audio from just before it. A pause of `pauseMs` ends it.
- **Recognition:** each utterance streams to a websocket speech-to-text server.
- **Speech:** reply text is cleaned for speaking (code blocks, links and markdown are dropped) and split
  into sentences. Each sentence goes to an OpenAI-compatible `/v1/audio/speech` endpoint as WAV, and the
  next sentence is fetched while the current one plays. macOS converts the WAV to PCM in memory. With
  `ttsStream`, macOS instead requests raw PCM and schedules each chunk on the native player as it arrives.
- **Interruption (barge-in):** macOS keeps the mic live during playback by default. Speaking stops
  playback and the rest of that reply stays silent, but the agent's work is not cancelled. When the
  utterance ends it is submitted as a *steer*: opencode delivers it into the running turn
  (`delivery: "steer"`), Pi injects it after the current tool calls (`deliverAs: "steer"`). When the
  agent is idle it starts a normal turn. Onset is debounced: playback stops only after `bargeInMs` of
  voiced speech or the first non-empty partial transcript, and onset is ignored for `onsetGraceMs`
  after capture starts or restarts (for example after changing devices), when route changes tend to
  produce noise. Only an explicit stop (`/voice stop`, Ctrl+Alt+X in Pi, **Interrupt reply** in the
  panel) aborts the agent turn. Set `bargeInAborts: true` for the old behaviour, where speaking cancels
  the turn and waits for cancellation before submitting. Other platforms keep duplex off by default;
  their FFmpeg capture has no echo cancellation.

### Speech services you provide

**Recognition websocket (`asrUrl`).** One connection per utterance:

1. The client sends binary frames of raw PCM (s16le, 16 kHz, mono) as it captures.
2. The client sends a text frame `{"type":"input_audio.end"}` when the speaker pauses.
3. The server sends `{"type":"transcript","text":"..."}` frames. Text from successive frames is
   appended, so a server may stream partial text or send everything at once.
4. The server closes the socket when the transcript is final. `{"type":"error","message":"..."}`
   reports a failure.

A small adapter around any streaming or batch speech-to-text model (Whisper, Parakeet and similar)
can serve this.

**Speech endpoint (`ttsUrl`).** The OpenAI audio speech API:
`POST {model, voice, input, response_format: "wav"}` returns WAV bytes. OpenAI itself, Kokoro-FastAPI,
openedai-speech and other compatible servers work. Lower first-chunk latency makes the conversation
feel snappier.

## Install

```sh
git clone https://github.com/batteryshark/agent-voice.git
cd agent-voice
npm ci --ignore-scripts --legacy-peer-deps
```

FFmpeg converts speech audio in memory on macOS: `brew install ffmpeg`. The native macOS helper
is built once with Xcode Command Line Tools; the installed local package includes that build. Windows and Linux also need
`ffplay`, which ships with FFmpeg. The extension also checks `/opt/homebrew/bin` and `/usr/local/bin`,
so desktop apps launched from the Dock find it.

**Pi / PiChamber:** `pi install "$PWD"`. PiChamber loads the same Pi packages.

**opencode / OpenChamber:** link the folder into opencode's global plugin directory:

```sh
mkdir -p ~/.config/opencode/plugins
ln -s "$PWD" ~/.config/opencode/plugins/agent-voice
```

Instead of the link, you can add `"plugins": ["/absolute/path/to/agent-voice"]` to
`~/.config/opencode/opencode.json`. OpenChamber starts opencode with your global config, so the plugin
loads there too. Use one registration method to avoid loading the plugin twice.

Then create the settings file (next section). Allow microphone access when macOS asks; permission
belongs to the app that launched the agent (your terminal, PiChamber or OpenChamber).

## Settings

Pi reads `~/.pi/agent/agent-voice.json` (or `$PI_CODING_AGENT_DIR/agent-voice.json`). opencode reads
`~/.config/opencode/agent-voice.json` first and falls back to the Pi file, so one file can serve both.

```json
{
  "asrUrl": "ws://localhost:8000/v1/transcribe",
  "ttsUrl": "http://localhost:8880/v1/audio/speech",
  "ttsModel": "tts-1",
  "voice": "alloy"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `asrUrl` | (required) | Recognition websocket |
| `ttsUrl` | (required) | OpenAI-compatible speech endpoint |
| `ttsModel` / `voice` | `tts-1` / `alloy` | Sent to the speech endpoint |
| `ttsStream` | `false` | macOS: request `response_format: "pcm"` and play each chunk as it arrives instead of waiting for the whole WAV. Needs a server that streams raw PCM (OpenAI's pcm format, 24 kHz s16le) |
| `asrApiKey` / `ttsApiKey` | none | Sent as `Authorization: Bearer …` |
| `pauseMs` | `1100` | Silence that ends an utterance |
| `threshold` | `0.012` | RMS level that counts as speech |
| `inputDevice` | `default` | macOS microphone ID, saved by the native device selector |
| `outputDevice` | `default` | macOS output-device ID, saved by the native device selector |
| `device` | `default` | Legacy microphone setting; Windows DirectShow name or Linux Pulse source |
| `duplex` | `true` on macOS, `false` elsewhere | Allow spoken interruption during playback |
| `bargeInMs` | `320` | Voiced speech (ms) within an utterance before it stops playback. A non-empty partial transcript also counts. `160` or less stops at onset |
| `onsetGraceMs` | `1200` | Ignore speech onset for this long after capture starts or restarts |
| `echoCancellation` | `auto` | macOS: `on` uses Apple's voice processing (echo cancellation) while the mic is live; `off` captures without it; `auto` turns it off when the output is headphones (Bluetooth / Bluetooth LE, or the built-in headphone jack) and on otherwise (built-in speakers, displays, external speakers). Decided each time capture starts |
| `bargeInAborts` | `false` | Speaking also cancels the running agent turn before your words are sent (the earlier behaviour) |
| `ffmpeg` / `ffplay` | found on `PATH` | Binary paths |

### Echo cancellation and headphones

Apple's voice processing routes playback through call-style processing, which can make the agent's voice
sound slightly muffled or ducked. With headphones there is no path from the speakers back into the mic,
so `auto` turns it off there. Auto checks the selected (or system default) output device each time capture
starts or devices change; plugging headphones into the built-in jack mid-session is picked up on the next
start. If CoreAudio cannot be read, auto keeps echo cancellation on.

Turning it `off` while playing through speakers lets the agent's own voice reach the mic. That can
trigger barge-in and cut the reply short. Because barge-in only stops playback, it does not cancel the
agent's work (unless `bargeInAborts` is on), but the reply may stop early and the echo can end up in your
next transcript. Keep `on` or `auto` for speakers, or use `/voice duplex off` to mute the mic during playback.

With echo cancellation off, the helper captures the microphone through its own input-only CoreAudio unit
(AVAudioEngine shares one unit between input and output on macOS, so it cannot capture from a different
device without voice processing), converts it to the same 16 kHz mono stream, and keeps playback on the
selected output.

The native helper (`bin/audio-macos`, not committed) is compiled from `native/audio.swift` the first time
it is needed and again whenever the source is newer than the binary. To rebuild it by hand (for example
after pulling a helper change, before restarting the app that runs the agent):

```sh
xcrun swiftc native/audio.swift -o bin/audio-macos -framework AVFoundation -framework CoreAudio \
  -module-cache-path "${TMPDIR:-/tmp}/agent-voice-swift-cache"
```

A helper built before `echoCancellation` existed ignores the setting and always uses voice processing;
`/voice status` then says it needs a rebuild.

`/voice devices`, `/voice input`, `/voice output`, `/voice duplex`, and `/voice echo` save their choices to this file.
Device changes restart active capture in place, preserving the voice mode. After editing it by hand, run
`/reload` in the Pi TUI or restart the native backend for PiChamber/OpenChamber.

## Commands

The same `/voice` command works in every host:

| Command | Behavior |
| --- | --- |
| `/voice on` | Listen continuously, submit after a pause, speak replies |
| `/voice off` | Stop capture and speech |
| `/voice dictate` | Speech without read-aloud (Pi: into the editor; opencode: sent as messages) |
| `/voice read on` / `off` | Read replies aloud with the microphone off |
| `/voice stop` | Stop the spoken reply and abort the current agent turn (speaking only stops the reply) |
| `/voice devices` | Choose microphone and output in the app's native selectors. |
| `/voice input` / `/voice output` | Choose one direction in a native dialog, or append a device name or ID. |
| `/voice duplex on` / `off` | Allow spoken interruption during playback / mute the mic during playback |
| `/voice echo auto` / `on` / `off` | Set echo cancellation; restarts active capture |
| `/voice test` | Speak a test sentence on the selected output device |
| `/voice check` | Native speaker-interruption test: say the word shown in status while the sample plays. No speech is sent to the agent. |
| `/voice status` | Show endpoints, microphone, echo cancellation (setting and, while listening, whether it is on), FFmpeg path and settings file |

Voice follows the session where you ran `/voice on`. Running it in another session moves the mic
there. Each native backend owns one voice session; turn voice off before enabling it in the other app.

### Pi TUI

Ctrl+Alt+V toggles capture; Ctrl+Alt+X stops a reply. Status shows in the footer. Voice survives
`/reload` and `/new`.

### PiChamber

PiChamber runs Pi in a session daemon on the PiChamber host, so the mic and speakers are that
machine's.

- Status shows in the extension strip above the composer, and errors show as toasts.
- `/voice dictate` inserts text at the composer caret.
- Pi keyboard shortcuts don't fire in PiChamber. Use **Settings › Shortcuts › Command triggers** to
  bind `/voice on` and `/voice stop` to a key or pinned button.
- PiChamber parks a session after 5 idle minutes. Voice stops with it and resumes when you reopen the
  session within 30 minutes.

### opencode / OpenChamber

The plugin runs inside the opencode server, on the same machine. OpenChamber starts that server
locally by default.

- Your speech appears as normal user messages, and replies are read as they stream.
- Speaking while the agent works stops the spoken reply and steers your words into the running turn;
  it does not cancel the turn. `/voice stop` or **Interrupt reply** cancels it.
- On/off confirmations are spoken. In OpenChamber, device lists, status and errors use its native
  notification channel. Other OpenCode clients receive `[voice]` entries in their synthetic inbox.
- OpenChamber's own dictation and read-aloud buttons use the browser device's mic. They are separate
  from this plugin; leave them off while voice is on.

#### OpenChamber Voice panel

Install this same folder in **Settings → Extensions → Add** and enable its local service.
Open **Voice** on the right-hand rail. Choose microphone and output, then click **Start conversation**.
The panel has **Interrupt reply** and **Test speaker interruption** controls, plus live microphone status.
While voice is on, **Mute mic** stops sending your audio (for example while you talk to someone else)
and **Mute agent voice** silences spoken replies; each leaves the other direction and the session running.
In any opencode client, `/voice mic off|on` and `/voice speaker off|on` do the same. Stopping voice clears both mutes.
When the speech server lists its voices (`GET …/v1/voices` beside `/v1/audio/speech`), a **Voice** picker shows
them, plus **Server default**, which follows the server's own default. The choice is saved as `voice` in
agent-voice.json and applies from the next sentence. **Preview voice** speaks a short line in it.
The capture device stays open while the mic is muted, so the macOS microphone indicator stays on.
**Echo cancellation** chooses Auto, On or Off; while voice runs, the selected option shows whether it is
currently on and why. Changing it restarts capture in place.
It uses OpenChamber's extension SDK and the native OpenCode plugin. It does not alter the composer draft.
Changing chats pauses voice. Closing or disconnecting the panel releases audio within 5 seconds.
Voice keeps running while the panel is hidden (another tab in front, such as a file the agent opens,
or a closed zone), so you can keep talking while you look at other panels. Turn off **Keep running when
hidden** to pause voice whenever the panel is out of sight. Closing the Voice tab itself still releases
audio within 5 seconds.
The microphone starts off. Extension service requests travel over a private local socket; approvals stay
in OpenChamber's usual interface. The panel's speech test turns the microphone off afterward.

Starting voice shows **Warming up** immediately, with a spinner and separate device-connection
and speech-preparation messages. Speech synthesis runs while the microphone/output initialize;
the interruption test accepts speech only after the native player confirms the sample started.
Its first sentence is prepared separately so you can hear it without waiting for the whole sample.
The panel then shows when to say the challenge word. Cancelling startup discards its pending speech.
Microphone and output can be selected independently; a built-in microphone is worth trying if
Bluetooth setup is slow, but the voice-processing engine itself also takes time to initialize.

The panel ships prebuilt. To rebuild it after editing `openchamber/panel/main.ts`, run `npm run build:panel`
(esbuild against the installed `@openchamber/sdk`), which writes `openchamber/panel/main.js`.

## Development

```sh
npm test
```

On macOS, `npm run test:audio` checks the selected devices with quiet generated tones. It verifies
microphone frames, completed playback, and stopping playback while capture continues. It saves no
microphone audio and sends nothing to recognition services. `--input` and `--output` can override
devices for the check without changing saved settings; `--output-only` keeps the microphone off.

| File | Role |
| --- | --- |
| `voice.mjs` | Capture, utterance detection, recognition client, speech synthesis and playback |
| `native-audio.mjs` / `native/audio.swift` | macOS device selection, echo cancellation, and playback in memory |
| `speech.mjs` | Cleans reply text and splits it into speakable sentences |
| `engine.mjs` | Host-agnostic voice loop, settings, one-mic-per-process ownership |
| `index.ts` | Pi extension |
| `opencode.mjs` / `server.js` | opencode 2.x plugin; `server.js` is the entry opencode resolves |

## License

MIT. See [LICENSE](LICENSE).
