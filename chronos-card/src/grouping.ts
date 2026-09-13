import type { Schedule } from "./types";
import { DEVICE_TYPES } from "./utils";
import { deviceTypeLabel, t } from "./i18n";

export type GroupBy = "none" | "group" | "type";

/** Bucket key for schedules without a group: sorts last and cannot collide
 * with a name a user could type. */
export const UNGROUPED = "\u0000";

export interface ScheduleGroup {
  key: string;
  label: string;
  items: Schedule[];
  ungrouped: boolean;
}

/** Distinct user groups in use, sorted. A group exists as long as one
 * schedule carries it; there is no separate list to maintain. */
export function knownGroups(schedules: Schedule[]): string[] {
  return [...new Set(schedules.map((s) => (s.group || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

/** Split the schedules into the groups the overview shows. Groups are
 * sorted by label, the ungrouped bucket last; inside a group the store order
 * is kept. A single bucket carries no information, so the caller renders it
 * flat: a setup that never assigned a group looks exactly as before. */
export function groupSchedules(schedules: Schedule[], by: GroupBy): ScheduleGroup[] {
  if (by === "none") return [{ key: "all", label: "", items: schedules, ungrouped: true }];
  const buckets = new Map<string, Schedule[]>();
  for (const s of schedules) {
    const key = by === "type" ? s.device_type : (s.group || "").trim() || UNGROUPED;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(s);
  }
  const groups: ScheduleGroup[] = [...buckets.entries()].map(([key, items]) => ({
    key,
    items,
    ungrouped: key === UNGROUPED,
    label: key === UNGROUPED
      ? t("overview.group.ungrouped")
      : by === "type" ? deviceTypeLabel(key, DEVICE_TYPES[key]?.label || key) : key,
  }));
  groups.sort((a, b) => Number(a.ungrouped) - Number(b.ungrouped) || a.label.localeCompare(b.label));
  return groups;
}

const STORAGE_KEY = "chronos.overview.collapsed";

/** Collapsed group keys, per browser. Storage can be missing or throw
 * (private mode, embedded views): fall back to nothing collapsed. */
export function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsed(keys: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Not persisted: the state still lives for this page.
  }
}

/** The colours offered for a group tag, close to Home Assistant's label
 * palette. Fixed set rather than a free picker: the tags must stay legible
 * with white text and read as one family across the card. */
export const GROUP_PALETTE = [
  "#e53935", "#d81b60", "#8e24aa", "#3949ab", "#1e88e5", "#00897b",
  "#43a047", "#7cb342", "#fdd835", "#fb8c00", "#6d4c41", "#546e7a",
];

export function groupColor(settings: { group_colors?: Record<string, string> } | null | undefined, group: string | undefined): string | null {
  const name = (group || "").trim();
  if (!name) return null;
  const hex = settings?.group_colors?.[name];
  return typeof hex === "string" && /^#[0-9a-f]{6}$/i.test(hex) ? hex : null;
}

/** Text colour that reads on a palette colour: dark on the two light ones. */
export function groupInk(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? "#1a1a1a" : "#ffffff";
}
