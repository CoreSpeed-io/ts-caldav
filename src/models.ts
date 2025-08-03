import { RRule } from "rrule";

export interface CalDAVOptions {
  baseUrl: string;
  auth: AuthOptions;
  requestTimeout?: number;
  logRequests?: boolean;
  prodId?: string;
}

export type AuthOptions =
  | { type: "basic"; username: string; password: string }
  | { type: "oauth"; accessToken: string };

export type SupportedComponent =
  | "VEVENT"
  | "VTODO"
  | "VJOURNAL"
  | "VFREEBUSY"
  | "VTIMEZONE";

export type Alarm =
  | {
      action: "DISPLAY";
      trigger: string;
      description?: string;
    }
  | {
      action: "EMAIL";
      trigger: string;
      description?: string;
      summary?: string;
      attendees: string[];
    }
  | {
      action: "AUDIO";
      trigger: string;
    };

export interface EventRef {
  href: string;
  etag: string;
}

export interface SyncChangesResult {
  changed: boolean;
  newCtag: string;
  newEvents: string[];
  updatedEvents: string[];
  deletedEvents: string[];
}

export interface Calendar {
  displayName: string;
  url: string;
  ctag?: string;
  supportedComponents: SupportedComponent[];
}

export interface Event {
  uid: string;
  summary: string;
  start: Date;
  end: Date;
  description?: string;
  location?: string;
  etag: string;
  href: string;
  wholeDay?: boolean;
  recurrenceRule?: RRule;
  startTzid?: string;
  endTzid?: string;
  alarms?: Alarm[];
}

export interface VTimezone {
  tzid: string;
  raw: string;
}

export type CalDAVResponse<T> = {
  status: number;
  data: T;
};
