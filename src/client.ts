import axios, { AxiosInstance } from "axios";
import {
  CalDAVOptions,
  Calendar,
  Event,
  EventRef,
  SyncChangesResult,
} from "./models";
import { encode } from "base-64";
import { parseCalendars, parseEvents } from "./utils/parser";
import { XMLParser } from "fast-xml-parser";
import { formatDate, formatDateOnly } from "./utils/encode";
import { v4 as uuidv4 } from "uuid";

type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;
type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export class CalDAVClient {
  private httpClient: AxiosInstance;
  private prodId: string;
  public calendarHome: string | null;
  public userPrincipal: string | null;
  public requestTimeout: number;
  public baseUrl: string;

  private resolveUrl(path: string): string {
    const basePath = new URL(this.baseUrl).pathname;
    if (path.startsWith(basePath) && basePath !== "/") {
      const stripped = path.substring(basePath.length);
      return stripped.startsWith("/") ? stripped : "/" + stripped;
    }
    return path;
  }

  private constructor(private options: CalDAVOptions) {
    this.httpClient = axios.create({
      baseURL: options.baseUrl,
      headers: {
        Authorization:
          options.auth.type === "basic"
            ? `Basic ${encode(
                `${options.auth.username}:${options.auth.password}`,
              )}`
            : `Bearer ${options.auth.accessToken}`,
        "Content-Type": "application/xml; charset=utf-8",
        "Accept-Language": "en",
      },
      timeout: options.requestTimeout || 5000,
      adapter: "fetch",
    });
    this.prodId = options.prodId || "-//ts-dav.//CalDAV Client//EN";
    this.calendarHome = null;
    this.userPrincipal = null;
    this.requestTimeout = options.requestTimeout || 5000;
    this.baseUrl = options.baseUrl;
    if (options.logRequests) {
      this.httpClient.interceptors.request.use((request) => {
        console.log("Request:", request.method, request.url);
        return request;
      });
    }
  }

  /**
   * Creates a new CalDAVClient instance and validates the provided credentials.
   * @param options - The CalDAV client options.
   * @returns A new CalDAVClient instance.
   * @throws An error if the provided credentials are invalid.
   * @example
   * ```typescript
   * const client = await CalDAVClient.create({
   *  baseUrl: "https://caldav.example.com",
   *  username: "user",
   *  password: "password",
   * });
   * ```
   */
  static async create(options: CalDAVOptions): Promise<CalDAVClient> {
    const client = new CalDAVClient(options);
    const isGoogle =
      options.baseUrl?.includes("apidata.googleusercontent.com") ?? false;
    const discoveryPath = isGoogle ? `/caldav/v2/` : "/";
    await client.validateCredentials(discoveryPath);
    await client.fetchCalendarHome();
    return client;
  }

  private async validateCredentials(discoveryPath: string): Promise<void> {
    const requestBody = `
        <d:propfind xmlns:d="DAV:">
        <d:prop>
            <d:current-user-principal />
        </d:prop>
        </d:propfind>`;

    try {
      const response = await this.httpClient.request({
        method: "PROPFIND",
        url: this.resolveUrl(discoveryPath),
        data: requestBody,
        headers: {
          Depth: "0",
          Prefer: "return=minimal",
        },
        validateStatus: (status) => status === 207,
      });

      if (!response.data.includes("current-user-principal")) {
        throw new Error(
          "User principal not found: Unable to authenticate with the server.",
        );
      }
      const parser = new XMLParser({
        removeNSPrefix: true,
      });
      const jsonData = parser.parse(response.data, {});

      const userPrincipalPath =
        jsonData["multistatus"]["response"]["propstat"]["prop"][
          "current-user-principal"
        ]["href"];

      this.userPrincipal = this.resolveUrl(userPrincipalPath);
    } catch (error) {
      throw new Error(
        "Invalid credentials: Unable to authenticate with the server." + error,
      );
    }
  }

  private async fetchCalendarHome(): Promise<string | null> {
    const requestBody = `
        <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop>
            <c:calendar-home-set />
        </d:prop>
        </d:propfind>`;

    const response = await this.httpClient.request({
      method: "PROPFIND",
      url: this.userPrincipal || "",
      data: requestBody,
      headers: {
        Depth: "0",
      },
      validateStatus: (status) => status === 207,
    });

    const parser = new XMLParser({ removeNSPrefix: true });
    const jsonData = parser.parse(response.data);

    const calendarHomePath =
      jsonData["multistatus"]["response"]["propstat"]["prop"][
        "calendar-home-set"
      ]["href"];

    this.calendarHome = this.resolveUrl(calendarHomePath);
    return this.calendarHome;
  }

  public getCalendarHome(): string | null {
    return this.calendarHome;
  }

  public async getCalendars(): Promise<Calendar[]> {
    if (!this.calendarHome) {
      throw new Error("Calendar home not found.");
    }

    const requestBody = `
      <d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop>
          <d:resourcetype />
          <d:displayname />
          <cs:getctag />
          <c:supported-calendar-component-set />
        </d:prop>
      </d:propfind>`;

    const response = await this.httpClient.request({
      method: "PROPFIND",
      url: this.calendarHome,
      data: requestBody,
      headers: {
        Depth: "1",
      },
      validateStatus: (status) => status === 207,
    });

    return parseCalendars(response.data);
  }

  private formatDate(date: Date): string {
    return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  }

  /**
   * Retrieves events from the specified calendar.
   * @param calendarUrl - The URL of the calendar to retrieve events from.
   * @param options - Optional time range filter.
   *   @param options.start - Start of the time range (inclusive).
   *   @param options.end - End of the time range (exclusive).
   * @returns An array of events.
   * @throws An error if the request fails.
   */
  public async getEvents(
    calendarUrl: string,
    options?: { start?: Date; end?: Date; all?: boolean },
  ): Promise<Event[]> {
    // use start and end from options if present, otherwise use today and today+3 weeks
    const now = new Date();
    const defaultEnd = new Date(now.getTime() + 3 * 7 * 24 * 60 * 60 * 1000); // 3 weeks from now
    const { start = now, end = defaultEnd, all } = options || {};

    const timeRangeFilter =
      start && end && !all
        ? `<c:comp-filter name="VEVENT">
             <c:time-range start="${this.formatDate(
               start,
             )}" end="${this.formatDate(end)}" />
           </c:comp-filter>`
        : `<c:comp-filter name="VEVENT" />`;

    const calendarData =
      start && end
        ? ` <c:calendar-data>
            <c:expand start="${this.formatDate(start)}" end="${this.formatDate(
              end,
            )}"/>
          </c:calendar-data>`
        : `<c:calendar-data />`;

    const requestBody = `
      <c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop>
            <d:getetag />
            ${calendarData}
        </d:prop>
        <c:filter>
            <c:comp-filter name="VCALENDAR">
            ${timeRangeFilter}
            </c:comp-filter>
        </c:filter>
      </c:calendar-query>`;

    try {
      const response = await this.httpClient.request({
        method: "REPORT",
        url: calendarUrl,
        data: requestBody,
        headers: {
          Depth: "1",
        },
        validateStatus: (status) => status === 207,
      });

      return parseEvents(response.data);
    } catch (error) {
      throw new Error(
        "Failed to retrieve events from the CalDAV server." + error,
      );
    }
  }

  private buildICSData(
    event: PartialBy<Event, "uid" | "etag" | "href">,
    uid: string,
  ): string {
    const rrule = event.recurrenceRule?.toString() ?? "";

    const dtStart =
      event.wholeDay === true
        ? `DTSTART;VALUE=DATE:${formatDateOnly(event.start)}`
        : event.startTzid
          ? `DTSTART;TZID=${event.startTzid}:${formatDate(event.start, false)}`
          : `DTSTART:${formatDate(event.start)}`;

    const dtEnd =
      event.wholeDay === true
        ? `DTEND;VALUE=DATE:${formatDateOnly(event.end)}`
        : event.endTzid
          ? `DTEND;TZID=${event.endTzid}:${formatDate(event.end, false)}`
          : `DTEND:${formatDate(event.end)}`;

    const alarmBlocks = (event.alarms || [])
      .map((alarm) => {
        switch (alarm.action) {
          case "DISPLAY":
            return [
              "BEGIN:VALARM",
              `TRIGGER:${alarm.trigger}`,
              "ACTION:DISPLAY",
              alarm.description ? `DESCRIPTION:${alarm.description}` : "",
              "END:VALARM",
            ]
              .filter(Boolean)
              .join("\r\n");

          case "EMAIL":
            return [
              "BEGIN:VALARM",
              `TRIGGER:${alarm.trigger}`,
              "ACTION:EMAIL",
              alarm.summary ? `SUMMARY:${alarm.summary}` : "",
              alarm.description ? `DESCRIPTION:${alarm.description}` : "",
              ...(alarm.attendees?.map((a) => `ATTENDEE:${a}`) || []),
              "END:VALARM",
            ]
              .filter(Boolean)
              .join("\r\n");

          case "AUDIO":
            return [
              "BEGIN:VALARM",
              `TRIGGER:${alarm.trigger}`,
              "ACTION:AUDIO",
              "END:VALARM",
            ].join("\r\n");
        }
      })
      .join("\r\n");

    return `
      BEGIN:VCALENDAR
      VERSION:2.0
      PRODID:${this.prodId}
      BEGIN:VEVENT
      UID:${uid}
      DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z
      ${dtStart}
      ${dtEnd}
      ${rrule}
      SUMMARY:${event.summary}
      DESCRIPTION:${event.description || ""}
      LOCATION:${event.location || ""}
      ${alarmBlocks}
      END:VEVENT
      END:VCALENDAR
        `.replace(/^\s+/gm, "");
  }

  /**
   * Fetches the current ETag for a given event href.
   * Useful when the server does not return an ETag on creation (e.g. Yahoo).
   * @param href - The full CalDAV event URL (ending in .ics).
   * @returns The ETag string, or throws an error if not found.
   */
  public async getETag(href: string): Promise<string> {
    try {
      const response = await this.httpClient.request({
        method: "PROPFIND",
        url: href,
        headers: {
          Depth: "0",
        },
        data: `
        <d:propfind xmlns:d="DAV:">
          <d:prop><d:getetag/></d:prop>
        </d:propfind>
      `,
        validateStatus: (status) => status === 207,
      });

      const parser = new XMLParser({ removeNSPrefix: true });
      const parsed = parser.parse(response.data);

      const etag =
        parsed?.multistatus?.response?.propstat?.prop?.getetag ||
        parsed?.multistatus?.response?.[0]?.propstat?.prop?.getetag;

      if (!etag) {
        throw new Error("ETag not found in PROPFIND response.");
      }

      return etag.replace(/^W\//, ""); // remove weak validator prefix if present
    } catch (error) {
      throw new Error(`Failed to retrieve ETag for ${href}: ${error}`);
    }
  }

  /**
   * Creates a new event in the specified calendar.
   * @param calendarUrl - The URL of the calendar to create the event in.
   * @param eventData - The event details.
   * @returns The created event UID if successful.
   */
  public async createEvent(
    calendarUrl: string,
    eventData: PartialBy<Event, "uid" | "href" | "etag">,
  ): Promise<{
    uid: string;
    href: string;
    etag: string;
    newCtag: string;
  }> {
    if (!calendarUrl) {
      throw new Error("Calendar URL is required to create an event.");
    }
    const eventUid = eventData.uid || uuidv4();

    if (calendarUrl.endsWith("/")) {
      calendarUrl = calendarUrl.slice(0, -1);
    }
    const href = `${calendarUrl}/${eventUid}.ics`;
    const vevent = this.buildICSData(eventData, eventUid);
    try {
      const response = await this.httpClient.put(href, vevent, {
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "If-None-Match": "*",
        },
        validateStatus: (status) => status === 201 || status === 204,
      });

      const etag = response.headers["etag"] || "";
      const newCtag = await this.getCtag(calendarUrl);

      return {
        uid: eventUid,
        href: `${
          calendarUrl.endsWith("/") ? calendarUrl : calendarUrl + "/"
        }${eventUid}.ics`,
        etag,
        newCtag,
      };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 412) {
        throw new Error(`Event with the specified uid already exists.`);
      }
      throw new Error(`Failed to create event: ${error}`);
    }
  }

  private isWeak(etag?: string) {
    return etag?.startsWith('W/"') || etag?.startsWith("W/");
  }

  /**
   * Updates an existing event in the specified calendar.
   * @param calendarUrl - The URL of the calendar to update the event in.
   * @param event - The event details to update.
   * @returns An object containing the updated event's UID, href, etag, and new ctag.
   */
  public async updateEvent(
    calendarUrl: string,
    event: Event,
  ): Promise<{
    uid: string;
    href: string;
    etag: string;
    newCtag: string;
  }> {
    if (!event.uid || !event.href) {
      throw new Error("Both 'uid' and 'href' are required to update an event.");
    }

    if (calendarUrl.endsWith("/")) {
      calendarUrl = calendarUrl.slice(0, -1);
    }
    const vevent = this.buildICSData(event, event.uid);
    const ifMatch = event.etag?.replace(/^W\//, "").trim();
    const ifMatchHeader = this.isWeak(ifMatch) ? null : `If-Match: ${ifMatch}`;
    try {
      const response = await this.httpClient.put(event.href, vevent, {
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          ifMatchHeader,
        },
        validateStatus: (status) => status === 200 || status === 204,
      });

      const newEtag = response.headers["etag"] || "";
      const newCtag = await this.getCtag(calendarUrl);

      return {
        uid: event.uid,
        href: event.href,
        etag: newEtag,
        newCtag,
      };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 412) {
        throw new Error(`Event with the specified uid does not match.`);
      }
      throw new Error(`Failed to update event: ${error}`);
    }
  }

  /**
   * Deletes an event from the specified calendar.
   * @param calendarUrl - The URL of the calendar to delete the event from.
   * @param eventUid - The UID of the event to delete.
   * @param etag - Optional ETag for strict deletion (required by some providers like iCloud).
   */
  public async deleteEvent(
    calendarUrl: string,
    eventUid: string,
    etag?: string,
  ): Promise<void> {
    if (calendarUrl.endsWith("/")) {
      calendarUrl = calendarUrl.slice(0, -1);
    }

    const href = `${calendarUrl}/${eventUid}.ics`;

    try {
      await this.httpClient.delete(href, {
        headers: {
          "If-Match": etag ?? "*", // Use specific ETag if provided; fallback to "*"
        },
        validateStatus: (status) => status === 204,
      });
    } catch (error) {
      throw new Error(`Failed to delete event: ${error}`);
    }
  }

  public async getCtag(calendarUrl: string): Promise<string> {
    const requestBody = `
      <d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
        <d:prop>
          <cs:getctag />
        </d:prop>
      </d:propfind>`;

    const response = await this.httpClient.request({
      method: "PROPFIND",
      url: calendarUrl,
      data: requestBody,
      headers: {
        Depth: "0",
      },
      validateStatus: (status) => status === 207,
    });

    const parser = new XMLParser({ removeNSPrefix: true });
    const jsonData = parser.parse(response.data);
    return jsonData["multistatus"]["response"]["propstat"]["prop"]["getctag"];
  }

  private async getEventRefs(calendarUrl: string): Promise<EventRef[]> {
    const requestBody = `
      <c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop>
            <d:getetag />
        </d:prop>
        <c:filter>
            <c:comp-filter name="VCALENDAR">
                <c:comp-filter name="VEVENT" />
            </c:comp-filter>
        </c:filter>
    </c:calendar-query>`;

    const response = await this.httpClient.request({
      method: "REPORT",
      url: calendarUrl,
      data: requestBody,
      headers: {
        Depth: "1",
      },
      validateStatus: (status) => status === 207,
    });

    const parser = new XMLParser({ removeNSPrefix: true });
    const jsonData = parser.parse(response.data);
    const refs: EventRef[] = [];
    const rawResponses = jsonData?.multistatus?.response;

    if (!rawResponses) {
      return [];
    }

    const responses = Array.isArray(rawResponses)
      ? rawResponses
      : [rawResponses];

    for (const obj of responses) {
      if (!obj || typeof obj !== "object") continue;

      const resultHref = obj["href"];
      const resultEtag = obj?.propstat?.prop?.getetag;

      if (resultHref && resultEtag) {
        refs.push({
          href: resultHref,
          etag: resultEtag,
        });
      }
    }

    return refs;
  }

  public async getEventsByHref(
    calendarUrl: string,
    hrefs: string[],
  ): Promise<Event[]> {
    if (!hrefs.length) {
      return [];
    }

    const filteredHrefs = hrefs.filter((href) => href.endsWith(".ics"));

    if (filteredHrefs.length === 0) {
      return [];
    }

    const requestBody = `
      <c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop>
            <d:getetag />
            <c:calendar-data />
        </d:prop>
        ${filteredHrefs.map((href) => `<d:href>${href}</d:href>`).join("")}
      </c:calendar-multiget>`;

    const response = await this.httpClient.request({
      method: "REPORT",
      url: calendarUrl,
      data: requestBody,
      headers: {
        Depth: "1",
      },
      validateStatus: (status) => status === 207,
    });

    return parseEvents(response.data);
  }

  public async syncChanges(
    calendarUrl: string,
    ctag: string,
    localEvents: EventRef[],
  ): Promise<SyncChangesResult> {
    const remoteCtag = await this.getCtag(calendarUrl);

    if (!ctag || ctag === remoteCtag) {
      return {
        changed: false,
        newCtag: remoteCtag,
        newEvents: [],
        updatedEvents: [],
        deletedEvents: [],
      };
    }

    const remoteRefs = await this.getEventRefs(calendarUrl);

    const localMap = new Map(localEvents.map((e) => [e.href, e.etag]));
    const remoteMap = new Map(remoteRefs.map((e) => [e.href, e.etag]));

    const newEvents: string[] = [];
    const updatedEvents: string[] = [];
    const deletedEvents: string[] = [];

    // Identify new and updated
    for (const { href, etag } of remoteRefs) {
      if (!localMap.has(href)) {
        newEvents.push(href);
      } else if (localMap.get(href) !== etag) {
        updatedEvents.push(href);
      }
    }

    // Identify deleted
    for (const { href } of localEvents) {
      if (!remoteMap.has(href)) {
        deletedEvents.push(href);
      }
    }

    return {
      changed: true,
      newCtag: remoteCtag,
      newEvents,
      updatedEvents,
      deletedEvents,
    };
  }
}
