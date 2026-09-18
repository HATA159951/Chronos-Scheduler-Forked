import { LitElement, html, css, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { chronosStyles, chronosTokens } from "./styles";
import { icon } from "./icons";
import { t, setLang, actionDefLabel, actionValueLabel } from "./i18n";
import { actionLabel, getActionDef, setColorSettings, setActionsMap } from "./actions";
import { resolveBlockTime, fmtHour, computeRepeat, setHassRef, pausedUntil, fmtWhen } from "./utils";
import {
  fetchSchedules, fetchDevices, fetchRules, fetchHistory, fetchForecast,
  fetchSettings, fetchActions, saveSchedule, type HistoryEntry,
} from "./ws";
import type { Schedule, ChronosDevice, WeatherRule, Settings, ScheduleCardConfig, Block } from "./types";
import "./timeline";

const CARD_VERSION = "chronos-interactive-card";

/** Read a `show_*` flag, defaulting to `d` when unset. */
const flag = (v: boolean | undefined, d = true): boolean => (v === undefined ? d : v);

/** Combination of the read-only status recap (chronos-schedule-card) and the
 * editing card (chronos-card): it shows every section the view card shows,
 * but its timeline stays interactive so block times can be dragged around
 * the clock and the selected block's numeric value (e.g. temperature) can
 * be changed from a slider. The schedule is persisted via the same WS save
 * call the full editor uses. */
@customElement("chronos-interactive-card")
export class ChronosInteractiveCard extends LitElement {
  @property({ attribute: false }) hass: any;
  @property({ attribute: false }) config: ScheduleCardConfig = { type: "custom:chronos-interactive-card" };

  @state() private _schedule: Schedule | null = null;
  /** Every schedule, kept only so `compare_with` can resolve its blocks. */
  @state() private _schedules: Schedule[] = [];
  @state() private _devices: ChronosDevice[] = [];
  @state() private _rules: WeatherRule[] = [];
  @state() private _history: HistoryEntry[] = [];
  @state() private _forecast: any[] = [];
  @state() private _settings: Settings | null = null;
  @state() private _loaded = false;
  @state() private _tick = 0;
  /** Index of the block highlighted on the timeline; its details (time
   * range + value editor) are shown in the small editor strip below. */
  @state() private _selectedIdx = 0;
  /** Brief "saved" feedback after persist. */
  @state() private _savedFlash = false;

  private _refreshTimer?: number;
  private _clockTimer?: number;
  private _loadingOnce = false;
  /** Snapshot of the last persisted blocks, for dirty tracking. */
  private _savedBlocks: Block[] = [];
  private _lang = "en";

  private _applyLang(): void {
    const override = (this._settings as any)?.language;
    const lang = !override || override === "auto" ? this.hass?.language : override;
    this._lang = lang || "en";
    setLang(this._lang);
  }

  static styles = [
    chronosTokens,
    chronosStyles,
    css`
      :host { display: block; }
      .scard { position: relative; }
      .scard--alarm { border-color: var(--danger); animation: scard-alarm 1.5s ease-in-out infinite; }
      @keyframes scard-alarm {
        0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--danger) 0%, transparent); }
        50% { box-shadow: 0 0 20px 3px color-mix(in srgb, var(--danger) 55%, transparent); }
      }
      @media (prefers-reduced-motion: reduce) {
        .scard--alarm { animation: none; box-shadow: 0 0 0 2px color-mix(in srgb, var(--danger) 45%, transparent); }
      }
      .scard__head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
      .scard__name { font-size: 16px; font-weight: 650; letter-spacing: -0.01em; flex: 1; min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .scard__line { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-soft); margin: 2px 0; }
      .scard__line b { color: var(--text); font-weight: 650; }
      .scard__line svg { flex: 0 0 auto; opacity: 0.8; }
      .scard__status { display: flex; flex-direction: column; gap: 0; margin-top: 12px; }
      .scard__row { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px solid var(--border-soft); font-size: 13px; }
      .scard__row:first-child { border-top: none; }
      .scard__row .k { color: var(--text-muted); min-width: 108px; display: flex; align-items: center; gap: 6px; }
      .scard__row .k svg { opacity: 0.7; }
      .scard__row .v { color: var(--text); flex: 1; min-width: 0; text-align: right;
        overflow: hidden; text-overflow: ellipsis; }
      .scard__edit { margin-top: 14px; border-top: 1px dashed var(--border-soft); padding-top: 12px; }
      .scard__edit .btn:disabled { opacity: 0.45; cursor: default; }
      .scard__log { margin-top: 12px; }
      .scard__log-h { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-muted);
        font-weight: 600; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
      .scard__log-h .count { color: var(--danger); }
      .scard__ev { display: flex; align-items: center; gap: 9px; padding: 6px 0; font-size: 12.5px; }
      .scard__ev + .scard__ev { border-top: 1px solid var(--border-soft); }
      .scard__dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
      .scard__ev .time { color: var(--text-muted); font-family: var(--font-mono); font-size: 11.5px; flex: 0 0 auto; min-width: 62px; }
      .scard__ev .lbl { color: var(--text-soft); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .scard__empty { color: var(--text-muted); font-size: 13px; padding: 18px 4px; text-align: center; }
    `,
  ];

  setConfig(config: ScheduleCardConfig) {
    this.config = config || ({ type: "custom:chronos-interactive-card" } as ScheduleCardConfig);
    if (this._loaded && this.hass) void this._load();
  }

  static getConfigElement(): HTMLElement {
    return document.createElement("chronos-schedule-card-editor");
  }

  static getStubConfig() {
    return { type: "custom:chronos-interactive-card" };
  }

  getCardSize(): number {
    return 8;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this._clockTimer = window.setInterval(() => { this._tick++; }, 60_000);
    this._refreshTimer = window.setInterval(() => { if (this.hass) void this._loadHistory(); }, 30_000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._clockTimer) clearInterval(this._clockTimer);
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this._clockTimer = this._refreshTimer = undefined;
  }

  updated(changed: PropertyValues): void {
    if (changed.has("hass") && this.hass) {
      setHassRef(this.hass);
      this._applyLang();
      if (!this._loaded && !this._loadingOnce) void this._load();
    }
  }

  private async _load(): Promise<void> {
    if (!this.hass) return;
    this._loadingOnce = true;
    try {
      const [schedules, devices, rules, settings, actions] = await Promise.all([
        fetchSchedules(this.hass).catch(() => []),
        fetchDevices(this.hass).catch(() => []),
        fetchRules(this.hass).catch(() => []),
        fetchSettings(this.hass).catch(() => null),
        fetchActions(this.hass).catch(() => ({})),
      ]);
      this._devices = devices;
      this._rules = rules;
      this._settings = settings;
      setColorSettings(settings);
      setActionsMap(actions);
      this._applyLang();
      this._schedules = schedules || [];
      this._schedule = this._schedules.find((s) => s.id === this.config.schedule) || null;
      this._selectedIdx = 0;
      this._savedBlocks = this._schedule ? JSON.parse(JSON.stringify(this._schedule.blocks)) : [];
      if (flag(this.config.show_weather_ribbon, false)) {
        this._forecast = await fetchForecast(this.hass).catch(() => []);
      }
      await this._loadHistory();
    } finally {
      this._loaded = true;
      this._loadingOnce = false;
    }
  }

  private async _loadHistory(): Promise<void> {
    if (!this.hass || !this.config.schedule) return;
    this._history = await fetchHistory(this.hass, {
      schedule_id: this.config.schedule,
      limit: Math.max(20, (this.config.log_limit ?? 6) + 12),
    }).catch(() => []);
  }

  private _inDateRange(s: Schedule): boolean {
    const dr = s.date_range;
    if (!dr) return true;
    const { start_month: sm, start_day: sd, end_month: em, end_day: ed } = dr;
    if (!(sm && sd && em && ed)) return true;
    const now = new Date();
    const cur = (now.getMonth() + 1) * 100 + now.getDate();
    const start = sm * 100 + sd;
    const end = em * 100 + ed;
    return start <= end ? start <= cur && cur <= end : cur >= start || cur <= end;
  }

  private _runsToday(s: Schedule): boolean {
    const weekday = (new Date().getDay() + 6) % 7;
    return !!(s.days?.[weekday] ?? 1) && this._inDateRange(s);
  }

  private _hourToLabel(h: number): string {
    return fmtHour(Math.min(h, 23 + 59 / 60));
  }

  private _nextChange(s: Schedule, nowHour: number, active?: any): { at: number; block?: any } | null {
    if (active) return { at: resolveBlockTime(active, "end"), block: undefined };
    const starts = s.blocks
      .map((b) => ({ at: resolveBlockTime(b, "start"), block: b }))
      .filter((x) => x.at > nowHour)
      .sort((a, b) => a.at - b.at);
    return starts.length ? starts[0] : null;
  }

  private _compareSchedule(): Schedule | null {
    const id = this.config.compare_with;
    if (!id || id === this.config.schedule) return null;
    return this._schedules.find((s) => s.id === id) || null;
  }

  private _ruledBlocks(s: Schedule): number[] {
    const out = new Set<number>();
    for (const r of this._rulesForSchedule(s.id)) {
      if (!r.active) continue;
      const bi = r.block_index;
      if (bi === null || bi === undefined) {
        s.blocks.forEach((_, i) => out.add(i));
      } else if (bi >= 0 && bi < s.blocks.length) {
        out.add(bi);
      }
    }
    return [...out];
  }

  private _rulesForSchedule(id: string): WeatherRule[] {
    const out: WeatherRule[] = [];
    for (const r of this._rules) {
      for (const tgt of r.targets || []) {
        if (tgt.schedule_id === id) out.push({ ...r, block_index: tgt.block_index ?? null });
      }
    }
    return out;
  }

  private _relTime(iso: string): string {
    const ts = new Date(iso).getTime();
    if (isNaN(ts)) return iso;
    const diff = ts - Date.now();
    const abs = Math.abs(diff);
    const rtf = new Intl.RelativeTimeFormat(this._lang, { numeric: "auto" });
    const min = 60_000, hr = 60 * min, day = 24 * hr;
    if (abs < hr) return rtf.format(Math.round(diff / min), "minute");
    if (abs < day) return rtf.format(Math.round(diff / hr), "hour");
    return rtf.format(Math.round(diff / day), "day");
  }

  private _periodLabel(s: Schedule): string {
    const dr = s.date_range;
    if (!dr || !(dr.start_month && dr.start_day && dr.end_month && dr.end_day)) return t("scard.period.always");
    const fmt = (m: number, d: number) =>
      new Date(2001, m - 1, d).toLocaleDateString(this._lang, { month: "short", day: "numeric" });
    return `${fmt(dr.start_month, dr.start_day)} → ${fmt(dr.end_month, dr.end_day)}`;
  }

  get _dirty(): boolean {
    if (!this._schedule) return false;
    return JSON.stringify(this._schedule.blocks) !== JSON.stringify(this._savedBlocks);
  }

  render() {
    const c = this.config;
    if (!c.schedule) return this._wrap(false, html`<div class="scard__empty">${t("scard.no_schedule")}</div>`);
    if (!this._loaded) return this._wrap(false, html`<div class="scard__empty">${t("common.loading")}</div>`);
    const s = this._schedule;
    if (!s) return this._wrap(false, html`<div class="scard__empty">${t("scard.not_found")}</div>`);

    void this._tick;
    const nowHour = new Date().getHours() + new Date().getMinutes() / 60;
    const runsToday = this._runsToday(s);
    const active = runsToday
      ? s.blocks.find((b) => nowHour >= resolveBlockTime(b, "start") && nowHour < resolveBlockTime(b, "end"))
      : undefined;
    const next = this._nextChange(s, nowHour, active);
    const variant = c.timeline_variant || s.timeline_variant || "linear";
    const alarm = flag(c.alarm_glow, true) && this._history[0]?.outcome === "error";

    return this._wrap(alarm, html`
      ${flag(c.show_header) ? html`
        <div class="scard__head">
          ${s.enabled && pausedUntil(s) ? html`<span class="chip chip--paused">${icon("pause", 11)} ${t("pause.badge", { when: fmtWhen(pausedUntil(s)!) })}</span>` : nothing}
          <span class="chip ${s.enabled ? "chip--on" : ""}">
            ${s.enabled ? html`<span class="chip__dot"></span>` : nothing}
            ${s.enabled ? t("schedule.active") : t("common.disabled")}
          </span>
          <span class="scard__name">${c.title || s.name}</span>
          ${flag(c.show_link, false) ? html`
            <a class="btn btn--icon btn--ghost btn--sm" href="${c.link_path || "/chronos"}"
              title="${t("scard.open_chronos")}" style="text-decoration:none">${icon("chevron-right", 14)}</a>
          ` : nothing}
        </div>
      ` : nothing}

      ${flag(c.show_now) ? html`
        <div class="scard__line">${icon("power", 14)}
          ${active
            ? html`<b>${actionLabel(s.device_type, active.action)}</b> · ${t("scard.now.until", { v: this._hourToLabel(resolveBlockTime(active, "end")) })}`
            : html`${t("scard.now.idle")}`}
        </div>` : nothing}
      ${flag(c.show_next) ? html`
        <div class="scard__line">${icon("chevron-right", 14)}
          ${next
            ? html`${this._hourToLabel(next.at)}${next.block ? html` → <b>${actionLabel(s.device_type, next.block.action)}</b>` : ""}`
            : html`${t("scard.next.none")}`}
        </div>` : nothing}

      ${flag(c.show_timeline) ? html`
        <div style="margin-top:12px">
          <chronos-timeline variant=${variant} .deviceType=${s.device_type} .blocks=${s.blocks}
            .selectedIdx=${this._selectedIdx}
            .interactive=${true} height="compact" .showWeather=${flag(c.show_weather_ribbon, false)}
            .ruleBlocks=${this._ruledBlocks(s)}
            .referenceBlocks=${this._compareSchedule()?.blocks || []}
            .referenceDeviceType=${this._compareSchedule()?.device_type || "thermostat"}
            .referenceLabel=${this._compareSchedule()?.name || ""}
            .forecast=${this._forecast} .now=${runsToday ? nowHour : null}
            @block-select=${(e: CustomEvent) => { this._selectedIdx = e.detail.index; }}
            @blocks-changed=${(e: CustomEvent) => this._applyBlocks(e.detail.blocks)}></chronos-timeline>
        </div>` : nothing}

      ${this._renderEditor(s)}
      ${this._renderStatus(s)}
      ${flag(c.show_last_activity) ? this._renderLast() : nothing}
      ${flag(c.show_log) ? this._renderLog() : nothing}
    `);
  }

  private _renderEditor(s: Schedule) {
    const block = s.blocks[this._selectedIdx];
    if (!block) return nothing;
    const def = getActionDef(s.device_type, block.action?.id || "");
    const num = def?.value?.type === "number" ? def.value : null;
    const dirty = this._dirty;
    return html`
      <div class="scard__edit">
        <div class="sp-between" style="align-items:center;gap:10px">
          <div class="row" style="gap:8px">
            <span class="chip chip--accent">${icon("clock", 11)} ${fmtHour(resolveBlockTime(block, "start"))} → ${fmtHour(resolveBlockTime(block, "end"))}</span>
            <span class="chip">${icon("power", 11)} ${actionLabel(s.device_type, block.action)}</span>
            ${dirty ? html`<span class="chip chip--paused">${t("editor.dirty.unsaved")}</span>` : nothing}
          </div>
          <button class="btn btn--sm" ?disabled=${!dirty}
            style="background:${dirty ? "var(--ok)" : "var(--bg-sunken)"};color:white;border-color:transparent;font-weight:600"
            @click=${() => this._save()}>
            ${icon("check", 12)} ${this._savedFlash ? t("editor.dirty.saved") : t("common.save")}
          </button>
        </div>
        ${num ? html`
          <div class="field" style="margin-top:10px">
            <label class="field__label">${actionValueLabel(s.device_type, block.action.id, num.label) || t("common.value")} ${num.unit ? html`<span class="text-mute">(${num.unit})</span>` : nothing}</label>
            <div class="row" style="gap:10px;align-items:center">
              <input type="range" min="${num.min}" max="${num.max}" step="${num.step}"
                .value=${String(block.action?.value ?? num.default)}
                @input=${(e: InputEvent) => this._setSelectedValue(parseFloat((e.target as HTMLInputElement).value))}
                style="flex:1;min-width:120px"/>
              <input type="number" class="input mono"
                min="${num.min}" max="${num.max}" step="${num.step}"
                .value=${String(block.action?.value ?? num.default)}
                @input=${(e: InputEvent) => {
                  const v = parseFloat((e.target as HTMLInputElement).value);
                  if (!isNaN(v)) this._setSelectedValue(v);
                }}
                style="width:90px;text-align:right;font-weight:600"/>
              <span class="mono text-mute" style="min-width:26px">${num.unit || ""}</span>
            </div>
          </div>
        ` : nothing}
      </div>
    `;
  }

  private _applyBlocks(blocks: Block[]) {
    if (!this._schedule) return;
    const sorted = [...blocks].sort((a, b) => a.start - b.start);
    this._schedule = { ...this._schedule, blocks: sorted };
    if (this._selectedIdx >= sorted.length) this._selectedIdx = Math.max(0, sorted.length - 1);
  }

  private _setSelectedValue(v: number) {
    if (!this._schedule) return;
    const blocks = this._schedule.blocks.map((b, i) => {
      if (i !== this._selectedIdx) return b;
      return { ...b, action: { ...b.action, value: v } };
    });
    this._schedule = { ...this._schedule, blocks };
  }

  private async _save() {
    if (!this.hass || !this._schedule) return;
    try {
      const saved = await saveSchedule(this.hass, this._schedule);
      this._schedule = saved;
      this._savedBlocks = JSON.parse(JSON.stringify(saved.blocks));
      this._savedFlash = true;
      setTimeout(() => { this._savedFlash = false; }, 1500);
    } catch (e) {
      console.error("Chronos interactive: save failed", e);
    }
  }

  private _wrap(alarm: boolean, inner: unknown) {
    return html`<div class="card scard ${alarm ? "scard--alarm" : ""}">${inner}</div>`;
  }

  private _renderStatus(s: Schedule) {
    const c = this.config;
    const rows: { show: boolean; ic: string; k: string; v: unknown }[] = [
      { show: flag(c.show_status_active), ic: "toggle", k: t("scard.k.active"),
        v: s.enabled ? t("schedule.active") : t("common.disabled") },
      { show: flag(c.show_status_devices), ic: "device", k: t("scard.k.devices"),
        v: this._devicesLabel(s) },
      { show: flag(c.show_status_weather), ic: "cloud", k: t("scard.k.weather"),
        v: this._weatherLabel(s) },
      { show: flag(c.show_status_days), ic: "calendar", k: t("scard.k.days"),
        v: computeRepeat(s.days) || "—" },
      { show: flag(c.show_status_period), ic: "clock", k: t("scard.k.period"),
        v: this._periodLabel(s) },
    ].filter((r) => r.show);
    if (!rows.length) return nothing;
    return html`
      <div class="scard__status">
        ${rows.map((r) => html`
          <div class="scard__row">
            <span class="k">${icon(r.ic, 13)} ${r.k}</span>
            <span class="v">${r.v}</span>
          </div>`)}
      </div>`;
  }

  private _devicesLabel(s: Schedule) {
    const ids = s.device_ids || [];
    if (!ids.length) return html`<span style="color:var(--text-muted)">${t("editor.no_devices")}</span>`;
    const names = ids.map((id) => {
      const d = this._devices.find((x) => x.id === id || x.entity_id === id);
      return d?.alias || d?.entity_id || id;
    });
    const shown = names.slice(0, 3).join(", ");
    return names.length > 3 ? `${shown} +${names.length - 3}` : shown;
  }

  private _weatherLabel(s: Schedule) {
    const rules = this._rulesForSchedule(s.id).filter((r) => r.active);
    if (!rules.length) return html`<span style="color:var(--text-muted)">—</span>`;
    return t("scard.weather.count", { n: rules.length });
  }

  private _renderLast() {
    const ok = this._history.find((e) => e.outcome === "ok" || e.outcome === "warning");
    const err = this._history.find((e) => e.outcome === "error");
    if (!ok && !err) return html`<div class="scard__line" style="margin-top:12px;color:var(--text-muted)">${icon("history", 14)} ${t("scard.last.none")}</div>`;
    return html`
      <div class="scard__line" style="margin-top:12px">${icon("history", 14)}
        ${ok ? html`${t("scard.last.run", { v: this._relTime(ok.ts) })}` : nothing}
        ${err ? html`<span style="color:var(--danger)">${ok ? " · " : ""}${t("scard.last.error", { v: this._relTime(err.ts) })}</span>` : nothing}
      </div>`;
  }

  private _renderLog() {
    const limit = this.config.log_limit ?? 6;
    const entries = this._history.slice(0, limit);
    const errCount = this._history.filter((e) => e.outcome === "error").length;
    return html`
      <div class="scard__log">
        <div class="scard__log-h">
          ${t("scard.log.title")}
          ${errCount > 0 ? html`<span class="count">${t("scard.log.errors", { n: errCount })}</span>` : nothing}
        </div>
        ${entries.length ? entries.map((e) => this._renderEvent(e)) : html`<div class="scard__empty" style="padding:10px 0">${t("scard.log.empty")}</div>`}
      </div>`;
  }

  private _renderEvent(e: HistoryEntry) {
    const color = e.outcome === "error" ? "var(--danger)" : e.outcome === "warning" ? "var(--warn)" : "var(--ok)";
    const d = new Date(e.ts);
    const time = isNaN(d.getTime()) ? "" : d.toLocaleTimeString(this._lang, { hour: "2-digit", minute: "2-digit" });
    const lbl = e.kind === "system"
      ? (t("history.system." + e.action_id) || e.action_id)
      : e.kind === "rule"
        ? `${t("history.kind.rule")}: ${actionDefLabel(e.device_type, e.action_id, e.action_id)}`
        : actionDefLabel(e.device_type, e.action_id, e.action_id);
    return html`
      <div class="scard__ev" title=${e.error || ""}>
        <span class="scard__dot" style="background:${color}"></span>
        <span class="time">${time}</span>
        <span class="lbl">${lbl}${e.entity_id ? html` <span style="color:var(--text-muted)">· ${e.entity_id}</span>` : ""}</span>
      </div>`;
  }
}

(window as any).customCards = (window as any).customCards || [];
if (!(window as any).customCards.some((c: any) => c.type === CARD_VERSION)) {
  (window as any).customCards.push({
    type: CARD_VERSION,
    name: "Chronos Interactive",
    description: "Interactive radial/linear/list timeline with drag-to-edit and value control for a single schedule",
    preview: false,
    documentationURL: "https://github.com/Pricesswg/Chronos-Scheduler",
  });
}
