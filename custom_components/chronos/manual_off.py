"""Safety off after a manual turn-on (discussion #26).

A device of a schedule that someone switches on by hand is switched off
again after the schedule's `manual_off_min`, at any time of day, whether or
not a block is running. Turn-ons made by Chronos are recognised by their
context and left alone: the block's own auto-off and end action apply to
those. Nothing is persisted: at startup a device found on is handled from
its `last_changed`, which survives the restart on its own.
"""
from __future__ import annotations

import logging

from homeassistant.helpers.event import async_call_later, async_track_state_change_event
from homeassistant.util import dt as dt_util

from .const import AUTO_OFF_SERVICE
from .events import is_own_context, log_to_logbook, make_history_entry
from .gate import schedule_is_live

_LOGGER = logging.getLogger(__name__)

# States that mean "not on" for the device types that have an off service.
OFF_STATES = {"off", "closed", "unavailable", "unknown"}


class ManualOffMixin:
    """Methods of ChronosScheduler that live here for readability. They run
    on the scheduler instance and use its attributes (_hass, _store, the
    per-feature state dicts set up in ChronosScheduler.__init__)."""

    def _manual_off_minutes(self, sched: dict) -> float:
        if sched.get("device_type") not in AUTO_OFF_SERVICE:
            return 0.0
        try:
            minutes = float(sched.get("manual_off_min") or 0)
        except (TypeError, ValueError):
            return 0.0
        return min(minutes, 24 * 60) if minutes > 0 else 0.0

    def _manual_watch_map(self) -> dict[str, dict]:
        """entity_id -> the schedule watching it (the first one wins)."""
        out: dict[str, dict] = {}
        for sched in self._store.schedules:
            if not self._manual_off_minutes(sched):
                continue
            for dev_id in sched.get("device_ids") or []:
                dev = self._store.get_device(str(dev_id))
                ent = (dev or {}).get("entity_id")
                if ent and ent not in out:
                    out[ent] = sched
        return out

    def _refresh_manual_watch(self) -> None:
        """(Re)subscribe to the watched entities when the set changes.
        Called every tick: cheap, and it follows schedule edits without a
        dedicated signal."""
        ents = tuple(sorted(self._manual_watch_map()))
        if ents == self._manual_watched:
            return
        if self._unsub_manual:
            self._unsub_manual()
            self._unsub_manual = None
        self._manual_watched = ents
        if ents:
            self._unsub_manual = async_track_state_change_event(
                self._hass, list(ents), self._on_manual_state_change
            )
        for ent in [e for e in self._manual_timers if e not in ents]:
            self._cancel_manual_timer(ent)

    async def _on_manual_state_change(self, event) -> None:
        new_state = event.data.get("new_state")
        old_state = event.data.get("old_state")
        ent = event.data.get("entity_id")
        if new_state is None or not ent:
            return
        if new_state.state in OFF_STATES:
            # Off by anyone: the timer has nothing left to do.
            self._cancel_manual_timer(ent)
            return
        if old_state is not None and old_state.state not in OFF_STATES:
            return  # on -> on (brightness, mode): not a turn-on
        if is_own_context(getattr(event.context, "id", None)):
            return  # Chronos did it: the block's own mechanisms apply
        sched = self._manual_watch_map().get(ent)
        if sched is None:
            return
        minutes = self._manual_off_minutes(sched)
        if not minutes or schedule_is_live(sched, dt_util.now(), mode=self._mode()):
            return
        self._arm_manual_off(sched, ent, minutes * 60)

    def _arm_manual_off(self, sched: dict, ent: str, delay_s: float) -> None:
        self._cancel_manual_timer(ent)
        sid = str(sched.get("id", ""))

        async def _fire(_now) -> None:
            self._manual_timers.pop(ent, None)
            await self._fire_manual_off(sid, ent)

        unsub = async_call_later(self._hass, max(0.0, delay_s), _fire)
        self._manual_timers[ent] = {"unsub": unsub, "schedule_id": sid}
        _LOGGER.info(
            "Chronos: safety off armed for %s in %.0f s (schedule=%s)",
            ent, max(0.0, delay_s), sched.get("name"),
        )

    def _cancel_manual_timer(self, ent: str) -> None:
        rec = self._manual_timers.pop(ent, None)
        if rec:
            rec["unsub"]()

    def _cancel_manual_timers(self) -> None:
        for ent in list(self._manual_timers):
            self._cancel_manual_timer(ent)
        if self._unsub_manual:
            self._unsub_manual()
            self._unsub_manual = None
        self._manual_watched = ()

    async def _fire_manual_off(self, sid: str, ent: str) -> None:
        sched = self._store.get_schedule(sid)
        # The gate is asked again at the deadline: a schedule paused or
        # disabled meanwhile must not act.
        if sched is None or schedule_is_live(sched, dt_util.now(), mode=self._mode()):
            return
        state = self._hass.states.get(ent)
        if state is None or state.state in OFF_STATES:
            return
        off_service = AUTO_OFF_SERVICE.get(sched.get("device_type", ""))
        if not off_service:
            return
        minutes = self._manual_off_minutes(sched)
        sent = await self._off_or_arm(sched, ent, off_service, "manual_off")
        if sent:
            self._store.append_history(make_history_entry(
                sched, kind="block", action_id="manual_off", entity_id=ent,
                value=f"{minutes:g} min after a manual turn-on",
            ))
            await log_to_logbook(
                self._hass, sched, action_id="manual_off", entity_id=ent, extra="safety off",
            )
            _LOGGER.info("Chronos: safety off sent to %s (schedule=%s)", ent, sched.get("name"))
        try:
            await self._store.flush_history()
        except Exception:
            _LOGGER.exception("Chronos: history flush failed after safety off")

    async def _manual_off_catch_up(self) -> None:
        """At startup, devices found on are handled from their last_changed:
        the remaining time is armed, or the switch-off is sent at once if it
        is already due. A device inside a running block is left to the
        block: its own auto-off and end action take care of it."""
        now = dt_util.now()
        hour = now.hour + now.minute / 60
        for ent, sched in self._manual_watch_map().items():
            state = self._hass.states.get(ent)
            if state is None or state.state in OFF_STATES:
                continue
            if schedule_is_live(sched, now, mode=self._mode()):
                continue
            block, _idx = self._block_at(self._effective_blocks(sched), hour)
            if block is not None:
                continue
            elapsed = (now - state.last_changed).total_seconds()
            self._arm_manual_off(sched, ent, self._manual_off_minutes(sched) * 60 - elapsed)
