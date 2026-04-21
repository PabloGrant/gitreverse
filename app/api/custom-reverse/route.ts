import { NextRequest, NextResponse } from "next/server";
import { parseGitHubRepoInput } from "@/lib/parse-github-repo";
import { getSupabase } from "@/lib/supabase";

const DEFAULT_CUSTOM_REVERSE_URL = "http://localhost:3001";

function getServiceUrl(): string {
  return (
    process.env.CUSTOM_REVERSE_SERVICE_URL?.trim() || DEFAULT_CUSTOM_REVERSE_URL
  );
}

/** Long-running upstream request; allow up to 10 minutes. */
const FETCH_TIMEOUT_MS = 600_000;

function persistCustomPromptCache(opts: {
  repoUrl: string;
  focus: string;
  prompt: string;
}): void {
  const sb = getSupabase();
  if (!sb) return;
  const parsed = parseGitHubRepoInput(opts.repoUrl);
  if (!parsed) return;
  void sb
    .from("custom_prompt_cache")
    .insert({
      owner: parsed.owner,
      repo: parsed.repo,
      focus: opts.focus,
      prompt: opts.prompt,
    })
    .then(({ error }) => {
      if (error) {
        console.error(
          "[custom-reverse] Supabase insert failed:",
          error.message
        );
      }
    });
}

export async function POST(request: NextRequest) {
  let body: { repoUrl?: string; customPrompt?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const repoUrl = body.repoUrl;
  const customPrompt = body.customPrompt;

  if (typeof repoUrl !== "string" || !repoUrl.trim()) {
    return NextResponse.json(
      { error: "repoUrl is required (string)" },
      { status: 400 }
    );
  }
  if (typeof customPrompt !== "string" || !customPrompt.trim()) {
    return NextResponse.json(
      { error: "customPrompt is required (string)" },
      { status: 400 }
    );
  }

  const base = getServiceUrl().replace(/\/$/, "");

  let res: Response;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      res = await fetch(`${base}/reverse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: repoUrl.trim(),
          customPrompt: customPrompt.trim(),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isAbort = e instanceof Error && e.name === "AbortError";
    return NextResponse.json(
      {
        error: isAbort
          ? "Custom reverse timed out. Try a smaller repo or a narrower prompt."
          : `Custom reverse service unreachable (${msg}). Check CUSTOM_REVERSE_SERVICE_URL and that the service is running.`,
      },
      { status: 503 }
    );
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return NextResponse.json(
      { error: "Custom reverse service returned invalid JSON." },
      { status: 502 }
    );
  }

  if (!res.ok) {
    const err =
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : `Request failed (${res.status})`;
    return NextResponse.json(
      { error: err },
      { status: res.status >= 400 && res.status < 600 ? res.status : 502 }
    );
  }

  const prompt =
    data &&
    typeof data === "object" &&
    "prompt" in data &&
    typeof (data as { prompt: unknown }).prompt === "string"
      ? (data as { prompt: string }).prompt
      : null;

  if (!prompt) {
    return NextResponse.json(
      { error: "Custom reverse service did not return a prompt." },
      { status: 502 }
    );
  }

  persistCustomPromptCache({
    repoUrl: repoUrl.trim(),
    focus: customPrompt.trim(),
    prompt,
  });

  return NextResponse.json({ prompt }, { status: 200 });
}
