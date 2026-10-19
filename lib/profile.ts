import { isCharacterId, type CharacterId } from "./characters";

// The name and character picked last time, remembered in this browser only.

const STORAGE_KEY = "3d-open-world:profile";

export interface SavedProfile {
  name: string;
  character: CharacterId;
}

export function loadSavedProfile(): SavedProfile | null {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!saved || typeof saved !== "object") return null;
    const { name, character } = saved as Record<string, unknown>;
    if (typeof name !== "string" || !isCharacterId(character)) return null;
    return { name, character };
  } catch {
    return null;
  }
}

export function saveProfile(profile: SavedProfile) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // storage blocked (private window, disabled site data): nothing to remember then
  }
}
