import { XMLParser } from "fast-xml-parser";
import {
  Alarm,
  Calendar,
  Event,
  SupportedComponent,
} from "../models";
import ICAL from "node-ical";

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
      const jcalData = ICAL.sync.parseICS(cleanedCalendarData);

      const event = Object.values(jcalData).find(
        (v) => v.type === "VEVENT",
      );

      if (!event) continue;

      const alarms: Alarm[] = [];

      if (event.alarms) {
        for (const valarm of event.alarms) {
          const action = valarm.action;
          const trigger = valarm.trigger;
  
          if (action === "DISPLAY" && trigger) {
            alarms.push({
              action: "DISPLAY",
              trigger,
              description: valarm.description,
            });
          } else if (action === "EMAIL" && trigger) {
  
            alarms.push({
              action: "EMAIL",
              trigger,
              description: valarm.description,
              summary: valarm.summary,
              attendees: valarm.attendee ? [valarm.attendee.toString()] : [],
            });
          } else if (action === "AUDIO" && trigger) {
            alarms.push({
              action: "AUDIO",
              trigger,
            });
          }
        }
      }

      events.push({
        uid: event.uid,
        summary: event.summary || "Untitled Event",
        start: event.start,
        end: event.end,
        description: event.description,
        location: event.location,
        etag: eventData["getetag"] || "",
        href: baseUrl ? new URL(obj["href"], baseUrl).toString() : obj["href"],
        wholeDay: event.datetype === "date",
        recurrenceRule: event.rrule,
        startTzid: event.start.tz,
        endTzid: event.end.tz,
        alarms,
      });
    } catch (error) {
      console.error("Error parsing event data:", error);
    }
  }

  return events;
};
