export type SeasonKey = "players" | "players_1" | "all";
export type SeasonDef = {
  label: string;
  table: string;
  start: string | null;
  end: string | null;
};

export const SEASONS: Record<SeasonKey, SeasonDef> = {
  players:   { label: "Season 2", table: "players",   start: "2025-06-23", end: null },
  players_1: { label: "Season 1", table: "players_1", start: "2025-03-31", end: "2025-06-22" },
  all:       { label: "All-Time", table: "",          start: null,         end: null },
};

export const seasonFromQuery = (q: any): SeasonDef => {
  const key = String(q);
  return key in SEASONS ? SEASONS[key as SeasonKey] : SEASONS.players;
};
