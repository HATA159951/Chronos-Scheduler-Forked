"""Safety off after a manual turn-on (discussion #26)."""
from __future__ import annotations

from datetime import timedelta

from pytest_homeassistant_custom_component.common import async_fire_time_changed

from custom_components.chronos.scheduler import ChronosScheduler

from .conftest import local, make_device, make_schedule, names, tick_at


def _coffee(store, hass, *, minutes=60, enabled=True):
    store.devices = [make_device("d1", "switch.coffee")]
    sched = make_schedule("s1", ["d1"], [
        {"start": 6.5, "end": 7.5, "action": {"id": "turn_on"}},
    ], enabled=enabled)
    sched["manual_off_min"] = minutes
    store.schedules = [sched]
    hass.states.async_set("switch.coffee", "off")
    return sched


async def _advance(hass, clock, minutes):
    clock.tick(timedelta(minutes=minutes))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()


async def test_manual_turn_on_is_switched_off_after_the_delay(hass, store, scheduler, calls, clock):
    _coffee(store, hass)
    await tick_at(scheduler, hass, clock, 15, 0)
    hass.states.async_set("switch.coffee", "on")
    await hass.async_block_till_done()
    assert "switch.coffee" in scheduler._manual_timers
    await _advance(hass, clock, 59)
    assert calls == [], "not yet"
    await _advance(hass, clock, 2)
    assert names(calls) == ["switch.turn_off"]
    assert any(e.get("action_id") == "manual_off" for e in store.history)


async def test_chronos_own_turn_on_does_not_arm_the_timer(hass, store, scheduler, calls, clock):
    _coffee(store, hass)
    await tick_at(scheduler, hass, clock, 6, 30)
    assert names(calls)[:1] == ["switch.turn_on"], "the block turned it on"
    hass.states.async_set("switch.coffee", "on", context=calls[0].context)
    await hass.async_block_till_done()
    assert scheduler._manual_timers == {}, "a turn-on carrying a Chronos context is not manual"


async def test_switching_off_before_the_deadline_cancels(hass, store, scheduler, calls, clock):
    _coffee(store, hass)
    await tick_at(scheduler, hass, clock, 15, 0)
    hass.states.async_set("switch.coffee", "on")
    await hass.async_block_till_done()
    hass.states.async_set("switch.coffee", "off")
    await hass.async_block_till_done()
    assert scheduler._manual_timers == {}
    await _advance(hass, clock, 90)
    assert calls == []


async def test_disabled_or_paused_schedule_never_fires(hass, store, scheduler, calls, clock):
    sched = _coffee(store, hass, enabled=False)
    await tick_at(scheduler, hass, clock, 15, 0)
    hass.states.async_set("switch.coffee", "on")
    await hass.async_block_till_done()
    assert scheduler._manual_timers == {}
    # Enabled when the timer is armed, paused before it fires: still silent.
    sched["enabled"] = True
    hass.states.async_set("switch.coffee", "off")
    hass.states.async_set("switch.coffee", "on")
    await hass.async_block_till_done()
    assert "switch.coffee" in scheduler._manual_timers
    sched["paused_until"] = local(23).isoformat()
    await _advance(hass, clock, 61)
    assert calls == []


async def test_restart_resumes_from_last_changed(hass, store, calls, clock):
    _coffee(store, hass)
    clock.move_to(local(14, 0))
    hass.states.async_set("switch.coffee", "on")
    await hass.async_block_till_done()
    # 40 of the 60 minutes passed while Home Assistant was down.
    clock.move_to(local(14, 40))
    fresh = ChronosScheduler(hass, store)
    fresh._refresh_manual_watch()
    await fresh._manual_off_catch_up()
    assert "switch.coffee" in fresh._manual_timers
    await _advance(hass, clock, 19)
    assert calls == []
    await _advance(hass, clock, 2)
    assert names(calls) == ["switch.turn_off"], "the remaining 20 minutes were honoured"


async def test_restart_past_the_deadline_switches_off_at_once(hass, store, calls, clock):
    _coffee(store, hass)
    clock.move_to(local(14, 0))
    hass.states.async_set("switch.coffee", "on")
    await hass.async_block_till_done()
    clock.move_to(local(16, 0))
    fresh = ChronosScheduler(hass, store)
    fresh._refresh_manual_watch()
    await fresh._manual_off_catch_up()
    await _advance(hass, clock, 0)
    assert names(calls) == ["switch.turn_off"]


async def test_no_field_means_no_watch(hass, store, scheduler, calls, clock):
    sched = _coffee(store, hass)
    del sched["manual_off_min"]
    await tick_at(scheduler, hass, clock, 15, 0)
    hass.states.async_set("switch.coffee", "on")
    await hass.async_block_till_done()
    await _advance(hass, clock, 120)
    assert calls == [] and scheduler._manual_timers == {}
