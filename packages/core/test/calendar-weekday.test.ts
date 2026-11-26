import { expect, it } from "vitest";
import { calendarTime } from "../src/calendar-time.ts";

it.each(["2011-12-29T12:00", "2011-12-23T12:00"])("keeps a weekday restriction across a skipped local date, starting %s", from => {
  const calendar = calendarTime("Pacific/Apia");
  // Friday 2011-12-30 did not exist in this time zone.
  expect(calendar.nextDaily(calendar.parse(from).ms, "09:00", [5])).toBe(Date.parse("2012-01-06T09:00+14:00"));
});

it("retains the spring-gap shift for an allowed weekday", () => {
  const calendar = calendarTime("America/New_York");
  const start = calendar.parse("2026-03-08T01:00").ms;
  expect(calendar.nextDaily(start, "02:30", [0])).toBe(Date.parse("2026-03-08T03:30-04:00"));
});
