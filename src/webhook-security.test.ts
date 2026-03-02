import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyTwilioWebhook } from "./webhook-security.js";

function signTwilio(authToken: string, url: string, rawBody: string): string {
  const params = new URLSearchParams(rawBody);
  let data = url;
  const sorted = Array.from(params.entries()).sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  for (const [k, v] of sorted) data += k + v;
  return crypto.createHmac("sha1", authToken).update(data).digest("base64");
}

describe("verifyTwilioWebhook", () => {
  it("keeps configured publicUrl path when local proxy rewrites request path", () => {
    const authToken = "token";
    const rawBody = "CallSid=CA123&CallStatus=ringing";

    const signedUrl =
      "https://demo.ngrok-free.app/voice/webhook?callId=abc&type=status";
    const signature = signTwilio(authToken, signedUrl, rawBody);

    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "127.0.0.1:3334",
          "x-twilio-signature": signature,
        },
        rawBody,
        url: "http://127.0.0.1:3334/?callId=abc&type=status",
        method: "POST",
      },
      authToken,
      { publicUrl: "https://demo.ngrok-free.app/voice/webhook" },
    );

    expect(result.ok).toBe(true);
  });

  it("uses forwarded non-default port when reconstructing verification URL", () => {
    const authToken = "token";
    const rawBody = "CallSid=CA456&CallStatus=initiated";

    const signedUrl = "https://example.com:8443/voice/webhook?foo=1";
    const signature = signTwilio(authToken, signedUrl, rawBody);

    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "127.0.0.1:3334",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "example.com",
          "x-forwarded-port": "8443",
          "x-twilio-signature": signature,
        },
        rawBody,
        url: "http://127.0.0.1:3334/voice/webhook?foo=1",
        method: "POST",
      },
      authToken,
    );

    expect(result.ok).toBe(true);
  });
});
