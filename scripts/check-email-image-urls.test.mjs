import test from "node:test";
import assert from "node:assert/strict";
import { externalImageUrls, verifyPublicImageUrl } from "./check-email-image-urls.mjs";

test("extracts only public HTTPS email images", () => {
  assert.deepEqual(externalImageUrls('<img src="https://brai.one/logo.png"><img src="cid:logo">'), [
    "https://brai.one/logo.png",
  ]);
});

test("accepts only unauthenticated HTTP 200 image responses", async () => {
  const image = await verifyPublicImageUrl("https://brai.one/logo.png", async () => new Response("png", {
    status: 200,
    headers: { "content-type": "image/png" },
  }));
  assert.equal(image.contentType, "image/png");

  await assert.rejects(
    verifyPublicImageUrl("https://brai.one/login", async () => new Response("html", {
      status: 200,
      headers: { "content-type": "text/html" },
    })),
    /text\/html/,
  );
  await assert.rejects(
    verifyPublicImageUrl("https://brai.one/private.png", async () => new Response(null, { status: 401 })),
    /HTTP 401/,
  );
  await assert.rejects(
    verifyPublicImageUrl("https://brai.one/missing.png", async () => new Response(null, { status: 404 })),
    /HTTP 404/,
  );
});
