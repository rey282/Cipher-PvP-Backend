export type SeasonKey = "players" | "players_1" | "players_2" | "players_3" | "all";

export type SeasonDef = {
  label: string;
  table: string;
  start: string | null;
  end: string | null;
};

export const SEASONS: Record<SeasonKey, SeasonDef> = {
  players:   { label: "Season 4", table: "players",   start: "2025-12-08", end: null }, 
  players_1: { label: "Season 1", table: "players_1", start: "2025-03-31", end: "2025-06-22" },
  players_2: { label: "Season 2", table: "players_2", start: "2025-06-23", end: "2025-09-14" },
  players_3: { label: "Season 3", table: "players_3", start: "2025-09-15", end: "2025-12-07" }, 
  all:       { label: "All-Time", table: "",          start: null,         end: null },
};

export const CHARACTER_TABLE_MAP: Record<string, string> = {
  "0": "characters",
  "1": "characters_1",
  "2": "characters_2",
  "3": "characters_3",
  "4": "characters_4",
  "5": "characters_5",
  "6": "characters_6", 
  // add more as needed
};

export const seasonFromQuery = (q: any): SeasonDef => {
  const key = String(q);
  return key in SEASONS ? SEASONS[key as SeasonKey] : SEASONS.players;
};
