# @clawdbot/voice-call-ws

Voice Call WebSocket extension for **OpenClaw**.

Telephony:
- **Twilio** (Programmable Voice + Media Streams)

Realtime providers:
- **xAI Voice Agent** (default)
- **Gemini Live**
- **Mock realtime** (local dev)

Docs: Refer to your OpenClaw plugin/extension docs for this plugin's config and install path.

## Install (local dev)

### Option A: install via OpenClaw (recommended)

```bash
openclaw plugins install @clawdbot/voice-call-ws
```

Restart the Gateway afterwards.

### Option B: copy into your global extensions folder (dev)

```bash
mkdir -p ~/.clawdbot/extensions
cp -R extensions/voice-call-ws ~/.clawdbot/extensions/voice-call-ws
cd ~/.clawdbot/extensions/voice-call-ws && pnpm install
```

## Config

Put under `plugins.entries.voice-call-ws.config`:

```json5
{
  telephony: {
    provider: "twilio",
    twilio: {
      accountSid: "<TWILIO_ACCOUNT_SID>",
      authToken: "<TWILIO_AUTH_TOKEN>"
    }
  },

  fromNumber: "+15550001234",
  toNumber: "+15550005678",

  realtime: {
    provider: "xai-voice-agent",
    streamPath: "/voice/stream",
    xai: {
      apiKey: "<XAI_API_KEY>",
      voice: "Ara",
      vadThreshold: 0.5
    }
  },

  // Restrict tools available to the voice-call agent
  tools: {
    profile: "messaging" // or "minimal" / "full"
  },

  serve: {
    port: 3334,
    path: "/voice/webhook"
  },

  // Public exposure (pick one):
  // publicUrl: "https://example.ngrok.app/voice/webhook",
  // tunnel: { provider: "ngrok" },
  // tailscale: { mode: "funnel", path: "/voice/webhook" }

  outbound: {
    defaultMode: "notify" // or "conversation"
  }
}
```

Notes:
- Twilio requires a **publicly reachable** webhook URL.
- `realtime.provider` controls the voice pipeline. Mock mode does not hit the network.
- For Gemini Live, set `realtime.provider: "gemini-live"` and configure `realtime.gemini`.

## CLI

If your CLI binary is still named `clawdbot`, substitute it below.

```bash
openclaw voicecall-ws call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall-ws speak --call-id <id> --message "One moment"
openclaw voicecall-ws end --call-id <id>
openclaw voicecall-ws status --call-id <id>
openclaw voicecall-ws tail
openclaw voicecall-ws expose --mode funnel
```

## Tool

Tool name: `voice_call_ws`

Actions:
- `initiate_call` (message, to?, mode?)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

## Gateway RPC

- `voicecallws.initiate` (to?, message, mode?)
- `voicecallws.speak` (callId, message)
- `voicecallws.end` (callId)
- `voicecallws.status` (callId)

## Notes

- WebSocket audio runs over Twilio Media Streams.
- Realtime provider handles STT + TTS end-to-end.

## Development

```bash
npm run test
npm run build
```
