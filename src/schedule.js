"use strict";

const ZONE = process.env.PATCHY_TIMEZONE || "Europe/Berlin";
const HOUR = Number(process.env.PATCHY_POST_HOUR || 18);

/**
 * How far the given instant's wall clock in `zone` is from UTC, in ms.
 * Derived from Intl rather than hardcoded, so CET/CEST is handled for us.
 */
function zoneOffsetMs(date, zone = ZONE) {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			hour12: false,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		})
			.formatToParts(date)
			.map((part) => [part.type, part.value]),
	);

	const asUtc = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		Number(parts.hour) % 24,
		Number(parts.minute),
		Number(parts.second),
	);
	return asUtc - date.getTime();
}

/** The instant at which a given wall-clock time in `zone` occurs. */
function zonedToUtc(year, month, day, hour, zone = ZONE) {
	const naive = Date.UTC(year, month - 1, day, hour, 0, 0);
	// One correction pass is enough away from a DST boundary; two is enough
	// on one, because the offset only moves by an hour.
	let instant = naive;
	for (let i = 0; i < 2; i++) {
		instant = naive - zoneOffsetMs(new Date(instant), zone);
	}
	return new Date(instant);
}

/**
 * The next HOUR:00 in ZONE at or after `from`. A patch that lands at 09:00
 * goes out the same evening; one that lands at 20:00 waits for the next.
 */
function nextPostWindow(from = new Date(), zone = ZONE, hour = HOUR) {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			hour12: false,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		})
			.formatToParts(from)
			.map((part) => [part.type, part.value]),
	);

	const today = zonedToUtc(
		Number(parts.year),
		Number(parts.month),
		Number(parts.day),
		hour,
		zone,
	);
	if (today > from) return today;

	const tomorrow = new Date(from.getTime() + 24 * 60 * 60 * 1000);
	const next = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			hour12: false,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		})
			.formatToParts(tomorrow)
			.map((part) => [part.type, part.value]),
	);
	return zonedToUtc(
		Number(next.year),
		Number(next.month),
		Number(next.day),
		hour,
		zone,
	);
}

module.exports = { nextPostWindow, zonedToUtc, zoneOffsetMs, ZONE, HOUR };
