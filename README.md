# agent-voice

Hands-free voice conversation for coding agents. One package works as:

- a **Pi extension**, in the [Pi](https://github.com/earendil-works/pi) TUI and in [PiChamber](https://github.com/RyderAsKing/PiChamber)
- an **opencode 2.x plugin**, in the opencode TUI and in [OpenChamber](https://github.com/openchamber/openchamber)

Talk to the agent, pause, and your words are sent as a message. Replies are spoken sentence by
sentence while they stream. Start talking and the reply stops so you can cut in. The agent keeps its
model, tools, skills, sessions and project behavior; voice is only another way in and out.

## How it works

Audio stays on the machine running the agent. No browser is involved, so it works the same in a
terminal or in a desktop or web client that talks to that machine.

```
microphone ─ ffmpeg ─ 16 kHz mono PCM ─▶ recognition websocket ─▶ transcript ─▶ agent
speakers ◀─ afplay / ffplay ◀─ WAV ◀─ /v1/audio/speech ◀─ sentences ◀─ streamed reply
```

- **Capture:** FFmpeg reads the default (or configured) microphone and pipes raw mono 16 kHz signed
  16-bit PCM. AVFoundation is used on macOS, DirectShow on Windows and PulseAudio on Linux.
- **Turn taking:** voice activity is measured on 20 ms frames. About 160 ms of speech opens an
  utterance, which includes 300 ms of audio from just before it. A pause of `pauseMs` ends it.
- **Recognition:** each utterance streams to a websocket speech-to-text server.
- **Speech:** reply text is cleaned for speaking (code blocks, links and markdown are dropped) and split
  into sentences. Each sentence goes to an OpenAI-compatible `/v1/audio/speech` endpoint as WAV, and the
  next sentence is fetched while the current one plays. Nothing is transcoded.
- **Feedback:** the mic is muted while speech plays unless you turn on duplex (use headphones;
  FFmpeg capture has no echo cancellation).

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

FFmpeg captures the microphone: `brew install ffmpeg` on macOS. Windows and Linux also need
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
loads there too.

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
| `asrApiKey` / `ttsApiKey` | none | Sent as `Authorization: Bearer …` |
| `pauseMs` | `1100` | Silence that ends an utterance |
| `threshold` | `0.012` | RMS level that counts as speech |
| `device` | `default` | Microphone: AVFoundation name or index (macOS), DirectShow name (Windows), Pulse source (Linux) |
| `duplex` | `false` | Keep the mic live during playback so you can interrupt by talking |
| `ffmpeg` / `ffplay` | found on `PATH` | Binary paths |

`/voice devices` and `/voice duplex` save their choice to this file. After editing it by hand, run
`/reload` in Pi or restart opencode.

## Commands

The same `/voice` command works in every host:

| Command | Behavior |
| --- | --- |
| `/voice on` | Listen continuously, submit after a pause, speak replies |
| `/voice off` | Stop capture and speech |
| `/voice dictate` | Speech without read-aloud (Pi: into the editor; opencode: sent as messages) |
| `/voice read on` / `off` | Read replies aloud with the microphone off |
| `/voice stop` | Stop the spoken reply and abort the current agent turn |
| `/voice devices` | List microphones and pick one (opencode: `/voice devices <name or index>`) |
| `/voice duplex on` / `off` | Allow spoken interruption during playback / mute the mic during playback |
| `/voice test` | Speak a test sentence |
| `/voice status` | Show endpoints, microphone, FFmpeg path and settings file |

Voice follows the session where you ran `/voice on`. Running it in another session moves the mic
there, because there is one microphone per machine.

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
- Speaking while the agent works steers your words into the running turn.
- On/off confirmations are spoken. `/voice status`, device lists and errors appear as `[voice]` entries
  in the session; opencode hands those to the model with your next message.
- OpenChamber's own dictation and read-aloud buttons use the browser device's mic. They are separate
  from this plugin; leave them off while voice is on.

## Development

```sh
npm test
```

| File | Role |
| --- | --- |
| `voice.mjs` | Capture, utterance detection, recognition client, speech synthesis and playback |
| `speech.mjs` | Cleans reply text and splits it into speakable sentences |
| `engine.mjs` | Host-agnostic voice loop, settings, one-mic-per-process ownership |
| `index.ts` | Pi extension |
| `opencode.mjs` / `server.js` | opencode 2.x plugin; `server.js` is the entry opencode resolves |

## License

MIT. See [LICENSE](LICENSE).
