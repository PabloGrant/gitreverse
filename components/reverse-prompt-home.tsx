"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { parseGitHubRepoInput } from "@/lib/parse-github-repo";

type ReversePromptHomeProps = {
  initialRepoInput?: string;
  autoSubmit?: boolean;
  initialPrompt?: string;
  owner?: string;
  repo?: string;
};

export function ReversePromptHome({
  initialRepoInput = "",
  autoSubmit = false,
  initialPrompt,
}: ReversePromptHomeProps) {
  const [repoUrl, setRepoUrl] = useState(initialRepoInput);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [copied, setCopied] = useState(false);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const autoSubmitStartedRef = useRef(false);

  const runReversePrompt = useCallback(async (input: string) => {
    setError(null);
    setPrompt("");
    setCopied(false);
    setLoading(true);
    try {
      const res = await fetch("/api/reverse-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl: input }),
      });
      const data = (await res.json()) as { prompt?: string; error?: string };
      if (!res.ok) {
        setError(data.error ?? `Request failed (${res.status})`);
        return;
      }
      if (typeof data.prompt === "string") {
        setPrompt(data.prompt);
        const parsed = parseGitHubRepoInput(input);
        if (parsed && typeof window !== "undefined") {
          window.history.replaceState(
            null,
            "",
            `/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`
          );
        }
      } else {
        setError("No result returned.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }, []);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = repoUrl.trim();
    if (trimmed) void runReversePrompt(trimmed);
  }

  useEffect(() => {
    if (!autoSubmit || autoSubmitStartedRef.current) return;
    const trimmed = initialRepoInput?.trim() ?? "";
    if (!trimmed || !parseGitHubRepoInput(trimmed)) return;
    autoSubmitStartedRef.current = true;
    void runReversePrompt(trimmed);
  }, [autoSubmit, initialRepoInput, runReversePrompt]);

  useEffect(() => {
    if (!prompt) return;
    const id = requestAnimationFrame(() => {
      resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => cancelAnimationFrame(id);
  }, [prompt]);

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
    <div className="flex min-h-screen flex-col items-center bg-[#0c1409] px-4 py-16 text-white">
      <div className="flex w-full max-w-2xl flex-col items-center gap-10">

        {/* Logo + Title */}
        <div className="flex flex-col items-center gap-4">
          <div className="h-28 w-28 overflow-hidden rounded-xl">
            <Image
              src="/pablogrant-logo.png"
              alt="PabloGrant"
              width={112}
              height={112}
              className="h-full w-full object-cover"
              priority
            />
          </div>
          <div className="flex flex-col items-center gap-1">
            <span className="text-xs font-semibold tracking-[0.3em] text-[#D4820A] uppercase">
              GitHub Analysis
            </span>
          </div>
        </div>

        {/* Input form */}
        <form onSubmit={onSubmit} className="flex w-full flex-col gap-3">
          <input
            name="repoUrl"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-white/10 bg-white/5 px-5 py-4 text-base text-white placeholder-white/30 outline-none transition focus:border-[#D4820A]/60 focus:bg-white/[0.08] focus:ring-0"
            placeholder="github.com/owner/repo"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            required
          />
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[#D4820A] py-4 text-sm font-semibold tracking-widest text-white uppercase transition hover:bg-[#bf7209] disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg
                  className="h-4 w-4 animate-spin"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  aria-hidden
                >
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Analyzing…
              </span>
            ) : (
              "Tell me the truth"
            )}
          </button>

          {error && (
            <p className="text-center text-sm text-red-400" role="alert">
              {error}
            </p>
          )}
        </form>

        {/* Result */}
        {prompt && (
          <div
            ref={resultsRef}
            className="w-full scroll-mt-8 rounded-xl border border-white/10 bg-white/5 p-6"
          >
            <div className="mb-4 flex items-center justify-between">
              <span className="text-xs font-semibold tracking-widest text-white/40 uppercase">
                Analysis
              </span>
              <button
                type="button"
                onClick={copyPrompt}
                className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/60 transition hover:border-[#D4820A]/40 hover:text-[#D4820A]"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-white/80">
              {prompt}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
