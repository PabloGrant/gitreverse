import { NextRequest, NextResponse } from "next/server";
import { SYSTEM_PROMPT } from "@/lib/system-prompt";
import { getFileTree, getReadme, getRepoMeta, getAiInstructionFiles, getPackageJsonFiles } from "@/lib/github-client";
import { formatAsFilteredTree } from "@/lib/file-tree-formatter";
import { parseGitHubRepoInput } from "@/lib/parse-github-repo";
import { getSupabase } from "@/lib/supabase";

const POLLINATIONS_URL = "https://gen.pollinations.ai/v1/chat/completions";
const GOOGLE_AI_STUDIO_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

type LlmTarget =
  | { provider: "pollinations"; url: string; apiKey: string; model: string }
  | { provider: "google"; url: string; apiKey: string; model: string };

function resolveLlmTarget(): LlmTarget | { error: string } {
  const pollinationsKey = process.env.POLLINATIONS_API_KEY?.trim();
  if (pollinationsKey) {
    return {
      provider: "pollinations",
      url: POLLINATIONS_URL,
      apiKey: pollinationsKey,
      model: process.env.POLLINATIONS_MODEL?.trim() || "minimax",
    };
  }
  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (googleKey) {
    return {
      provider: "google",
      url: GOOGLE_AI_STUDIO_URL,
      apiKey: googleKey,
      model:
        process.env.GOOGLE_AI_STUDIO_MODEL?.trim() || "gemini-2.5-pro",
    };
  }
  return {
    error:
      "No LLM API key configured. Set POLLINATIONS_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY in .env.local.",
  };
}

const inFlight = new Map<string, Promise<{ prompt: string } | NextResponse>>();

function buildUserMessage(
  owner: string,
  repo: string,
  meta: Awaited<ReturnType<typeof getRepoMeta>>,
  fileTree: string,
  readme: string,
  truncatedTree: boolean,
  aiFiles: Record<string, string>,
  packageJsons: Record<string, string>
): string {
  const topicsLine =
    meta.topics.length > 0 ? `\n**Topics:** ${meta.topics.join(", ")}` : "";
  const readmeBody = readme || "*(No README or empty)*";

  const parts = [
    `# Repository: ${owner}/${repo}`,
    "",
    `**Description:** ${meta.description ?? "*(none)*"}`,
    `**Primary language:** ${meta.language ?? "*(unknown)*"}`,
    `**Stars:** ${meta.stargazers_count}`,
    `**Default branch:** ${meta.default_branch}`,
    topicsLine,
    truncatedTree ? "\n**Note:** Full repository tree was truncated by GitHub." : "",
    "",
    "## Root file tree (depth 3)",
    "",
    "```",
    fileTree,
    "```",
  ];

  if (Object.keys(aiFiles).length > 0) {
    parts.push("", "## AI Instruction Files");
    for (const [filename, content] of Object.entries(aiFiles)) {
      parts.push("", `### ${filename}`, "", content);
    }
  }

  if (Object.keys(packageJsons).length > 0) {
    parts.push("", "## package.json files");
    for (const [filepath, content] of Object.entries(packageJsons)) {
      parts.push("", `### ${filepath}`, "", "```json", content, "```");
    }
  }

  parts.push("", "## README", "", readmeBody);

  return parts.join("\n");
}

/** Maps to client 429 handling → “Browse the library” (same as GitHub/rate limits). */
function isExhaustedCreditsOrQuotaMessage(msg: string): boolean {
  const lower = msg.toLowerCase();
  if (
    lower.includes("requires more credits") ||
    lower.includes("can only afford") ||
    lower.includes("openrouter.ai/settings/credits") ||
    lower.includes("openrouter.ai/settings/keys") ||
    lower.includes("key limit exceeded") ||
    (lower.includes("total limit") && lower.includes("key")) ||
    (lower.includes("credit") && lower.includes("max_tokens"))
  ) {
    return true;
  }
  if (
    lower.includes("resource exhausted") ||
    lower.includes("quota exceeded") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("billing has not been enabled")
  ) {
    return true;
  }
  return false;
}

function extractProviderErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const err = (data as { error?: unknown }).error;
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m.trim();
  }
  return null;
}

function extractMessage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: { content?: unknown } };
  const content = first.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as { text: unknown }).text)
          : ""
      )
      .join("");
    return text.trim() || null;
  }
  return null;
}

export async function POST(request: NextRequest) {
  let body: { repoUrl?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const repoUrl = body.repoUrl;
  if (typeof repoUrl !== "string") {
    return NextResponse.json(
      { error: "repoUrl is required (string)" },
      { status: 400 }
    );
  }

  const parsed = parseGitHubRepoInput(repoUrl);
  if (!parsed) {
    return NextResponse.json(
      {
        error:
          "Could not parse a GitHub repo. Use a URL like https://github.com/owner/repo or owner/repo.",
      },
      { status: 400 }
    );
  }

  const { owner, repo } = parsed;

  const llm = resolveLlmTarget();
  if ("error" in llm) {
    return NextResponse.json({ error: llm.error }, { status: 500 });
  }

  const key = `${owner}/${repo}`;
  const existing = inFlight.get(key);
  if (existing) {
    const out = await existing;
    return out instanceof NextResponse
      ? out
      : NextResponse.json({ prompt: out.prompt }, { status: 200 });
  }

  const promise = (async () => {
    const supabase = getSupabase();
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from("prompt_cache")
          .select("prompt")
          .eq("owner", owner)
          .eq("repo", repo)
          .maybeSingle();
        if (!error && data?.prompt) {
          return { prompt: data.prompt as string };
        }
      } catch {
        // cache miss — continue to GitHub + LLM
      }
    }

    let meta: Awaited<ReturnType<typeof getRepoMeta>>;
    try {
      meta = await getRepoMeta(owner, repo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.toLowerCase().includes("not found") ? 404 : 500;
      return NextResponse.json({ error: message }, { status });
    }

    const branch = meta.default_branch;

    let tree: { tree: Array<{ path: string; type: string }>; truncated: boolean };
    let readme: string;
    let aiFiles: Record<string, string>;
    let packageJsons: Record<string, string>;
    try {
      [tree, readme] = await Promise.all([
        getFileTree(owner, repo, branch),
        getReadme(owner, repo, branch),
      ]);
      [aiFiles, packageJsons] = await Promise.all([
        getAiInstructionFiles(owner, repo, branch),
        getPackageJsonFiles(owner, repo, branch, tree.tree),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.toLowerCase().includes("not found") ? 404 : 500;
      return NextResponse.json({ error: message }, { status });
    }

    const SKIP_PREFIXES = [
      "node_modules/", "dist/", ".next/", "build/", ".nuxt/",
      "vendor/", ".yarn/", "out/", "coverage/", ".turbo/",
    ];
    const filteredTree = tree.tree.filter(
      (item) => !SKIP_PREFIXES.some((p) => item.path.startsWith(p))
    );

    const fileTree = formatAsFilteredTree(
      filteredTree,
      `${owner}/${repo}`,
      undefined,
      3
    );

    const userContent = buildUserMessage(
      owner,
      repo,
      meta,
      fileTree,
      readme,
      tree.truncated,
      aiFiles,
      packageJsons
    );

    const headers: Record<string, string> = {
      Authorization: `Bearer ${llm.apiKey}`,
      "Content-Type": "application/json",
    };
    if (llm.provider === "pollinations") {
      const referer = process.env.POLLINATIONS_HTTP_REFERER?.trim();
      if (referer) headers["HTTP-Referer"] = referer;
    }

    let res: Response;
    try {
      res = await fetch(llm.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: llm.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
        }),
      });
    } catch (e) {
      const label =
        llm.provider === "pollinations"
          ? "Pollinations"
          : "Google AI Studio";
      const message =
        e instanceof Error ? e.message : `${label} request failed`;
      return NextResponse.json(
        { error: `Generation failed: ${message}` },
        { status: 500 }
      );
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      const label =
        llm.provider === "pollinations"
          ? "Pollinations"
          : "Google AI Studio";
      return NextResponse.json(
        { error: `${label} returned invalid JSON.` },
        { status: 502 }
      );
    }

    if (!res.ok) {
      const label =
        llm.provider === "pollinations"
          ? "Pollinations"
          : "Google AI Studio";
      const msg =
        extractProviderErrorMessage(data) ??
        `${label} error ${res.status}: ${JSON.stringify(data).slice(0, 300)}`;

      const creditsExhausted =
        res.status === 429 ||
        res.status === 402 ||
        isExhaustedCreditsOrQuotaMessage(msg);

      if (creditsExhausted) {
        return NextResponse.json(
          { error: "Service is currently over capacity. Try again later." },
          { status: 429 }
        );
      }

      const lower = msg.toLowerCase();
      const isAuth =
        res.status === 401 ||
        lower.includes("unauthorized") ||
        lower.includes("invalid api key");
      const authHint =
        llm.provider === "pollinations"
          ? "Pollinations authentication failed. Check POLLINATIONS_API_KEY in .env.local."
          : "Google AI Studio authentication failed. Check GOOGLE_GENERATIVE_AI_API_KEY in .env.local.";
      return NextResponse.json(
        {
          error: isAuth ? authHint : `Generation failed: ${msg}`,
        },
        {
          status: isAuth ? 401 : res.status >= 400 && res.status < 600 ? res.status : 502,
        }
      );
    }

    const prompt = extractMessage(data);
    if (!prompt) {
      return NextResponse.json(
        { error: "Model did not return a usable text response." },
        { status: 500 }
      );
    }

    const sb = getSupabase();
    if (sb) {
      void sb
        .from("prompt_cache")
        .upsert(
          {
            owner,
            repo,
            prompt,
            cached_at: new Date().toISOString(),
          },
          { onConflict: "owner,repo" }
        )
        .then(({ error: upsertError }) => {
          if (upsertError) {
            console.error(
              "[reverse-prompt] cache upsert:",
              upsertError.message
            );
          }
        });
    }

    return { prompt };
  })();

  inFlight.set(key, promise);
  try {
    const out = await promise;
    return out instanceof NextResponse
      ? out
      : NextResponse.json({ prompt: out.prompt }, { status: 200 });
  } finally {
    inFlight.delete(key);
  }
}
