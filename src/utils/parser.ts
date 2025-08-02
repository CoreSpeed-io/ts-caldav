import { XMLParser } from "fast-xml-parser";
import {
  Alarm,
  Calendar,
  Event,
  RecurrenceRule,
  SupportedComponent,
} from "../models";
import ICAL from "ical.js";

const normalizeParam = (
  value: string | string[] | undefined,
): string | undefined => {
  if (Array.isArray(value)) {
    return value[0]; // pick the first one
  }
  return value;
};

function parseRecurrence(recur: ICAL.Recur): RecurrenceRule {
  const freqMap = {
    DAILY: "DAILY",
    WEEKLY: "WEEKLY",
    MONTHLY: "MONTHLY",
    YEARLY: "YEARLY",
  } as const;
  const freq = freqMap[recur.freq as keyof typeof freqMap] || undefined;

  const byday = recur.parts.BYDAY
    ? recur.parts.BYDAY.map((day: string) => day)
    : undefined;
  const bymonthday = recur.parts.BYMONTHDAY
    ? recur.parts.BYMONTHDAY.map((day: number) => day)
    : undefined;
  const bymonth = recur.parts.BYMONTH
    ? recur.parts.BYMONTH.map((month: number) => month)
    : undefined;

  return {
    freq,
    interval: recur.interval,
    count: recur.count ? recur.count : undefined,
    until: recur.until ? recur.until.toJSDate() : undefined,
    byday,
    bymonthday,
    bymonth,
  };
}

export const parseCalendars = async (
  responseData: string,
  baseUrl?: string,
): Promise<Calendar[]> => {
  const calendars: Calendar[] = [];

  const parser = new XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: false,
    attributeNamePrefix: "",
  });
  const jsonData = parser.parse(responseData);
  const response = jsonData["multistatus"]["response"];
  const responses = Array.isArray(response) ? response : [response];

  for (const res of responses) {
    const propstats = Array.isArray(res["propstat"])
      ? res["propstat"]
      : [res["propstat"]];

    const okPropstat = propstats.find(
      (p) =>
        typeof p["status"] === "string" &&
        p["status"].toLowerCase().includes("200 ok"),
    );
    if (!okPropstat) continue;

    const prop = okPropstat["prop"];
    const compData = prop?.["supported-calendar-component-set"]?.["comp"];

    // Normalize to array
    const compArray: { name: string }[] = Array.isArray(compData)
      ? compData
      : compData
        ? [compData]
        : [];

    const supportedComponents: SupportedComponent[] = compArray
      .map((c) => c.name)
      .filter((name): name is SupportedComponent =>
        [
          "VEVENT",
          "VTODO",
          "VJOURNAL",
          "VFREEBUSY",
          "VTIMEZONE",
          "VAVAILABILITY",
        ].includes(name),
      );

    if (!supportedComponents.includes("VEVENT")) continue;

    const calendar: Calendar = {
      displayName: prop["displayname"] ?? "",
      url: baseUrl ? new URL(res["href"], baseUrl).toString() : res["href"],
      ctag: prop["getctag"],
      supportedComponents,
    };
    calendars.push(calendar);
  }

  return calendars;
};

export const parseEvents = async (
  responseData: string,
  baseUrl?: string,
): Promise<Event[]> => {
  const events: Event[] = [];

  const parser = new XMLParser({ removeNSPrefix: true });
  const jsonData = parser.parse(responseData);
  let response = jsonData["multistatus"]["response"];
  if (!response) return events;
  if (!Array.isArray(response)) response = [response];

  for (const obj of response) {
    const eventData = obj["propstat"]?.["prop"];
    if (!eventData) continue;

    const rawCalendarData = eventData["calendar-data"];
    if (!rawCalendarData) continue;

    const cleanedCalendarData = rawCalendarData.replace(/&#13;/g, "\r\n");

    try {
      const jcalData = ICAL.parse(cleanedCalendarData);
      const vcalendar = new ICAL.Component(jcalData);
      const vevent = vcalendar.getFirstSubcomponent("vevent");
      if (!vevent) continue;

      const icalEvent = new ICAL.Event(vevent);

      const dtStartProp = vevent.getFirstProperty("dtstart");
      const dtEndProp = vevent.getFirstProperty("dtend");

      const isWholeDay = icalEvent.startDate.isDate;
      const startDate = new Date(icalEvent.startDate.toUnixTime() * 1000);
      const endDate = icalEvent.endDate
        ? new Date(icalEvent.endDate.toUnixTime() * 1000)
        : startDate;
      const adjustedEnd = isWholeDay
        ? new Date(endDate.getTime() - 86400000)
        : endDate;

      const startTzid =
        normalizeParam(dtStartProp?.getParameter("tzid")) || undefined;
      const endTzid =
        normalizeParam(dtEndProp?.getParameter("tzid")) || undefined;

      const rruleProp = vevent.getFirstProperty("rrule");
      let recurrenceRule: RecurrenceRule | undefined;
      if (rruleProp) {
        const rrule = rruleProp.getFirstValue();
        if (rrule) {
          const recur = ICAL.Recur.fromString(rrule.toString());
          recurrenceRule = parseRecurrence(recur);
        }
      }

      const alarms: Alarm[] = [];
      const valarms = vevent.getAllSubcomponents("valarm");

      for (const valarm of valarms) {
        const action = valarm.getFirstPropertyValue("action");
        const trigger = valarm.getFirstPropertyValue("trigger")?.toString();

        if (action === "DISPLAY" && trigger) {
          alarms.push({
            action: "DISPLAY",
            trigger,
            description:
              valarm.getFirstPropertyValue("description")?.toString() ||
              undefined,
          });
        } else if (action === "EMAIL" && trigger) {
          const attendees =
            valarm
              .getAllProperties("attendee")
              ?.map((p) => p.getFirstValue())
              .filter((v): v is string => typeof v === "string") || [];

          alarms.push({
            action: "EMAIL",
            trigger,
            description:
              valarm.getFirstPropertyValue("description")?.toString() ||
              undefined,
            summary:
              valarm.getFirstPropertyValue("summary")?.toString() || undefined,
            attendees,
          });
        } else if (action === "AUDIO" && trigger) {
          alarms.push({
            action: "AUDIO",
            trigger,
          });
        }
      }

      events.push({
        uid: icalEvent.uid,
        summary: icalEvent.summary || "Untitled Event",
        start: startDate,
        end: adjustedEnd,
        description: icalEvent.description || undefined,
        location: icalEvent.location || undefined,
        etag: eventData["getetag"] || "",
        href: baseUrl ? new URL(obj["href"], baseUrl).toString() : obj["href"],
        wholeDay: isWholeDay,
        recurrenceRule,
        startTzid,
        endTzid,
        alarms,
      });
    } catch (error) {
      console.error("Error parsing event data:", error);
    }
  }

  return events;
};
