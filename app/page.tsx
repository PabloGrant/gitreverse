"use client";

import { useState } from "react";
import { UnoReverseLogo } from "@/components/uno-reverse-logo";

const EXAMPLES = [
  "https://github.com/vercel/next.js",
  "https://github.com/shadcn-ui/ui",
  "https://github.com/facebook/react",
  "https://github.com/supabase/supabase",
] as const;

export default function Home() {
  const [repoUrl, setRepoUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [copied, setCopied] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPrompt("");
    setCopied(false);
    setLoading(true);
    try {
      const res = await fetch("/api/reverse-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl: repoUrl.trim() }),
      });
      const data = (await res.json()) as { prompt?: string; error?: string };
      if (!res.ok) {
        setError(data.error ?? `Request failed (${res.status})`);
        return;
      }
      if (typeof data.prompt === "string") {
        setPrompt(data.prompt);
      } else {
        setError("No prompt in response.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  async function copyPrompt() {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy to clipboard.");
    }
  }

  return (
    <div className="min-h-full bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <main className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-12 sm:px-6">
        <header className="space-y-2">
          <div className="flex items-center gap-4">
            <UnoReverseLogo
              className="h-[4.25rem] w-[4.25rem] shrink-0 drop-shadow sm:h-[5.25rem] sm:w-[5.25rem]"
              title=""
            />
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              gitreverse
            </h1>
          </div>
          <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Paste a public GitHub repo link. We’ll turn it into one
            plain-language “vibe coding” prompt you could have used to build it.
          </p>
        </header>

        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
        >
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            GitHub repository
            <input
              name="repoUrl"
              autoComplete="off"
              className="rounded-lg border border-zinc-300 bg-white px-3 py-2 font-normal text-zinc-900 outline-none ring-zinc-400 focus:ring-2 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
              placeholder="https://github.com/owner/repo or owner/repo"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              required
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <span className="w-full text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Try an example:
            </span>
            {EXAMPLES.map((url) => (
              <button
                key={url}
                type="button"
                onClick={() => setRepoUrl(url)}
                className="rounded-lg border border-zinc-300 bg-zinc-50 px-2.5 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
              >
                {url.replace("https://github.com/", "")}
              </button>
            ))}
          </div>

          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-[#d31611] px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-[#b0120e] disabled:opacity-50"
          >
            {loading ? "Working…" : "Reverse to prompt"}
          </button>

          {error ? (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          ) : null}
        </form>

        {prompt ? (
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                Synthetic prompt
              </h2>
              <button
                type="button"
                onClick={copyPrompt}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <pre className="max-h-[min(70vh,32rem)] overflow-auto whitespace-pre-wrap rounded-xl border border-zinc-200 bg-white p-4 text-sm leading-relaxed text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
              {prompt}
            </pre>
          </section>
        ) : null}
      </main>
    </div>
  );
}
