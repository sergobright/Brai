"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { setBraiCmdFunctionEnabled } from "@/lib/braiCmdSummary";
import { readPrimaryUserId } from "@/lib/database";

type RequestHeaders = { get(name: string): string | null };
type AdminSessionResponse = { authenticated?: boolean; user?: { id?: unknown } | null };

export async function toggleBraiCmdFunctionAction(formData: FormData) {
  const requestHeaders = await headers();
  await assertAdminAllowed(requestHeaders);
  const key = String(formData.get("key") ?? "").trim();
  const enabled = String(formData.get("enabled") ?? "") === "true";
  await setBraiCmdFunctionEnabled(key, enabled);
  revalidatePath("/");
  redirect("/?section=brai-cmd");
}

async function assertAdminAllowed(requestHeaders: RequestHeaders) {
  const userId = await readAuthenticatedUserId(requestHeaders);
  if (!userId) throw new Error("admin_session_required");
  const primaryUserId = await readPrimaryUserId();
  if (!primaryUserId || primaryUserId !== userId) throw new Error("admin_forbidden");
}

async function readAuthenticatedUserId(requestHeaders: RequestHeaders) {
  const cookie = requestHeaders.get("cookie");
  if (!cookie) return null;

  const response = await fetch(`${resolveAdminApiBase()}/auth/session`, {
    cache: "no-store",
    headers: { cookie },
  });
  if (!response.ok) throw new Error(`Brai API session check failed: ${response.status}`);

  const session = (await response.json()) as AdminSessionResponse;
  const userId = session.authenticated ? session.user?.id : null;
  return typeof userId === "string" && userId ? userId : null;
}

function resolveAdminApiBase() {
  const value = process.env.BRAI_ADMIN_API_BASE ?? "http://127.0.0.1:3020";
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("BRAI_ADMIN_API_BASE must be an HTTP URL");
  return url.href.replace(/\/+$/, "");
}
