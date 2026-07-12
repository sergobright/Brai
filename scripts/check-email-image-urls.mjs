#!/usr/bin/env node
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { renderOtpEmail } from "../services/brai_api/src/auth.js";

export function externalImageUrls(html) {
  return [...String(html).matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)]
    .map((match) => match[1])
    .filter((value) => /^https:\/\//i.test(value));
}

export async function verifyPublicImageUrl(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { method: "GET", redirect: "manual" });
  const contentType = response.headers.get("content-type") ?? "";
  assert.equal(response.status, 200, `${url} returned HTTP ${response.status}`);
  assert.match(contentType, /^image\//i, `${url} returned ${contentType || "no Content-Type"}`);
  await response.body?.cancel();
  return { url, status: response.status, contentType };
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const urls = externalImageUrls(renderOtpEmail({ otp: "000000" }).html);
  assert.ok(urls.length > 0, "OTP email has no public image URLs to verify");
  for (const url of urls) {
    const result = await verifyPublicImageUrl(url);
    console.log(`${result.status} ${result.contentType} ${result.url}`);
  }
}
