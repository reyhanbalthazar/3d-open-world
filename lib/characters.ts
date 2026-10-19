// Playable characters: Quaternius' Ultimate Modular Men/Women packs (CC0), one glTF each.
// Plain data, shared by the browser and server/game.ts (which validates the choice).

const MEN = "/ultimate_modular_men_feb_2022/individual_characters/gltf";
const WOMEN = "/ultimate_modular_women_april_2022/individual_characters/gltf";

export const CHARACTERS = [
  { id: "m_adventurer", label: "Adventurer", group: "Men", url: `${MEN}/adventurer.gltf` },
  { id: "m_beach", label: "Beach", group: "Men", url: `${MEN}/beach.gltf` },
  { id: "m_casual", label: "Casual", group: "Men", url: `${MEN}/casual_2.gltf` },
  { id: "m_hoodie", label: "Hoodie", group: "Men", url: `${MEN}/casual_hoodie.gltf` },
  { id: "m_farmer", label: "Farmer", group: "Men", url: `${MEN}/farmer.gltf` },
  { id: "m_king", label: "King", group: "Men", url: `${MEN}/king.gltf` },
  { id: "m_punk", label: "Punk", group: "Men", url: `${MEN}/punk.gltf` },
  { id: "m_spacesuit", label: "Spacesuit", group: "Men", url: `${MEN}/spacesuit.gltf` },
  { id: "m_suit", label: "Suit", group: "Men", url: `${MEN}/suit.gltf` },
  { id: "m_swat", label: "SWAT", group: "Men", url: `${MEN}/swat.gltf` },
  { id: "m_worker", label: "Worker", group: "Men", url: `${MEN}/worker.gltf` },
  { id: "w_adventurer", label: "Adventurer", group: "Women", url: `${WOMEN}/adventurer.gltf` },
  { id: "w_casual", label: "Casual", group: "Women", url: `${WOMEN}/casual.gltf` },
  { id: "w_formal", label: "Formal", group: "Women", url: `${WOMEN}/formal.gltf` },
  { id: "w_medieval", label: "Medieval", group: "Women", url: `${WOMEN}/medieval.gltf` },
  { id: "w_punk", label: "Punk", group: "Women", url: `${WOMEN}/punk.gltf` },
  { id: "w_sci_fi", label: "Sci-Fi", group: "Women", url: `${WOMEN}/sci_fi.gltf` },
  { id: "w_soldier", label: "Soldier", group: "Women", url: `${WOMEN}/soldier.gltf` },
  { id: "w_suit", label: "Suit", group: "Women", url: `${WOMEN}/suit.gltf` },
  { id: "w_witch", label: "Witch", group: "Women", url: `${WOMEN}/witch.gltf` },
  { id: "w_worker", label: "Worker", group: "Women", url: `${WOMEN}/worker.gltf` },
] as const;

export type Character = (typeof CHARACTERS)[number];
export type CharacterId = Character["id"];

export const DEFAULT_CHARACTER: CharacterId = "m_adventurer";

export function isCharacterId(value: unknown): value is CharacterId {
  return typeof value === "string" && CHARACTERS.some((character) => character.id === value);
}

export function getCharacter(id: CharacterId): Character {
  return CHARACTERS.find((character) => character.id === id)!;
}
