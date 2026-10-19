"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CHARACTERS, DEFAULT_CHARACTER, type CharacterId } from "@/lib/characters";
import type { ConnectionStatus } from "@/lib/multiplayer";
import { loadSavedProfile } from "@/lib/profile";
import {
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  nameKey,
  normalizeName,
  type JoinErrorReason,
} from "@/lib/protocol";

const GROUPS = ["Men", "Women"] as const;

const INVALID_NAME_TEXT = "Use letters, numbers, spaces, _ . or - only.";
const TAKEN_NAME_TEXT = "That name is already taken by another player.";
const HINT_TEXT = `${NAME_MIN_LENGTH}–${NAME_MAX_LENGTH} characters, different from everyone online.`;

const SERVER_ERROR_TEXT: Record<JoinErrorReason, string> = {
  invalid_name: INVALID_NAME_TEXT,
  invalid_character: "Pick one of the characters below.",
  name_taken: TAKEN_NAME_TEXT,
  server_full: "The server is full right now. Try again in a moment.",
};

const STATUS_TEXT: Partial<Record<ConnectionStatus, string>> = {
  connecting: "Connecting to the game server…",
  offline: "Game server unreachable, retrying…",
};

interface JoinModalProps {
  status: ConnectionStatus;
  // names of everyone currently playing, for checking before the server does
  takenNames: string[];
  joining: boolean;
  serverError: JoinErrorReason | null;
  onPreview(character: CharacterId): void;
  onSubmit(name: string, character: CharacterId): void;
}

// Shown on arrival: pick a unique name and a character. The picked character is previewed
// in the world behind the panel. Mounted only after the scene is ready, so reading the
// saved profile from localStorage here never runs during hydration.
export default function JoinModal({ status, takenNames, joining, serverError, onPreview, onSubmit }: JoinModalProps) {
  const [saved] = useState(loadSavedProfile);
  const [name, setName] = useState(saved?.name ?? "");
  const [character, setCharacter] = useState<CharacterId>(saved?.character ?? DEFAULT_CHARACTER);
  const [submittedName, setSubmittedName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const normalized = normalizeName(name);
  const taken = normalized !== null && takenNames.some((other) => nameKey(other) === nameKey(normalized));

  let error: string | null = null;
  if (serverError && name === submittedName) error = SERVER_ERROR_TEXT[serverError];
  else if (name.trim().length >= NAME_MIN_LENGTH && !normalized) error = INVALID_NAME_TEXT;
  else if (taken) error = TAKEN_NAME_TEXT;

  const canSubmit = status === "online" && !joining && normalized !== null && !taken;

  function choose(id: CharacterId) {
    setCharacter(id);
    onPreview(id);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || normalized === null) return;
    setSubmittedName(name);
    onSubmit(normalized, character);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="join-title"
      className="absolute inset-x-3 bottom-3 z-10 flex max-h-[55vh] [color-scheme:dark] flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/85 text-zinc-100 shadow-2xl backdrop-blur-md sm:inset-x-auto sm:top-4 sm:bottom-4 sm:left-4 sm:max-h-none sm:w-[360px]"
    >
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <div className="px-5 pt-5">
          <h2 id="join-title" className="text-lg font-semibold">
            Join the world
          </h2>
          <p className="mt-1 text-sm text-zinc-400">Pick a name and a character. Drag the scene to look around.</p>
        </div>

        <div className="px-5 pt-4">
          <label htmlFor="player-name" className="text-sm font-medium">
            Name
          </label>
          <input
            ref={inputRef}
            id="player-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={NAME_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
            placeholder="Your name"
            aria-invalid={error !== null}
            aria-describedby="player-name-hint"
            className="mt-1.5 w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-base text-white outline-none placeholder:text-zinc-500 focus:border-emerald-400/70 focus:ring-2 focus:ring-emerald-400/30"
          />
          <p
            id="player-name-hint"
            aria-live="polite"
            className={`mt-1.5 text-sm ${error ? "text-rose-300" : "text-zinc-500"}`}
          >
            {error ?? HINT_TEXT}
          </p>
        </div>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-5 pb-2">
          {GROUPS.map((group) => (
            <fieldset key={group} className="mb-4">
              <legend className="mb-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">{group}</legend>
              <div className="grid grid-cols-2 gap-2">
                {CHARACTERS.filter((option) => option.group === group).map((option) => {
                  const selected = option.id === character;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => choose(option.id)}
                      className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                        selected
                          ? "border-emerald-400/70 bg-emerald-400/15 text-white"
                          : "border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10"
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>

        <div className="border-t border-white/10 px-5 py-4">
          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full rounded-lg bg-emerald-500 px-4 py-2.5 font-semibold text-zinc-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {joining ? "Joining…" : "Play"}
          </button>
          {STATUS_TEXT[status] && <p className="mt-2 text-center text-sm text-amber-300">{STATUS_TEXT[status]}</p>}
        </div>
      </form>
    </div>
  );
}
