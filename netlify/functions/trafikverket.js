// Netlify Function: CORS proxy for Trafikverket API
// Frontend POSTs {station, type} → we build the query, forward to Trafikverket, return {trains:[...]}

const TV_API = "https://api.trafikinfo.trafikverket.se/v2/data.json";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Returns today's date (YYYY-MM-DD) and UTC offset string (+01:00 / +02:00) in Stockholm timezone
function getStockholmDate() {
  const now = new Date();
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(now);
  const isCEST = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Stockholm", timeZoneName: "short" }).format(now).includes("CEST");
  return { date, tz: isCEST ? "+02:00" : "+01:00" };
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS_HEADERS, body: "Method Not Allowed" };
  }

  try {
    const apiKey = process.env.TRAFIKVERKET_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "TRAFIKVERKET_API_KEY env var not set" }),
      };
    }

    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return {
        statusCode: 400,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Invalid JSON body" }),
      };
    }

    const { station, type = "Avgang" } = body;

    if (!station) {
      return {
        statusCode: 400,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Missing required field: station" }),
      };
    }

    // Use Stockholm date/timezone so the query covers the right calendar day year-round (CET/CEST).
    // Fetch today AND tomorrow so the ticker still has upcoming departures late in the evening
    // and across midnight. Matches the oracle's behavior in oracle.mjs.
    const { date: today, tz } = getStockholmDate();
    const tomorrow = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" })
      .format(new Date(Date.now() + 86400000));

    const fetchDay = (dateStr) => fetch(TV_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        REQUEST: {
          LOGIN: { authenticationkey: apiKey },
          QUERY: [{
            objecttype: "TrainAnnouncement",
            schemaversion: "1.8",
            FILTER: {
              AND: [
                { EQ: [{ name: "ActivityType",             value: type    }] },
                { EQ: [{ name: "LocationSignature",        value: station }] },
                { GT: [{ name: "AdvertisedTimeAtLocation", value: dateStr + "T00:00:00.000" + tz }] },
                { LT: [{ name: "AdvertisedTimeAtLocation", value: dateStr + "T23:59:59.000" + tz }] },
              ],
            },
            INCLUDE: [
              "AdvertisedTrainIdent",
              "AdvertisedTimeAtLocation",
              "TimeAtLocation",
              "EstimatedTimeAtLocation",
              "Canceled",
              "Deviation",
              "TrackAtLocation",
              "ToLocation",
              "ProductInformation",
              "LocationSignature",
            ],
            LIMIT: 200,
          }],
        },
      }),
    });

    const [todayRes, tomorrowRes] = await Promise.all([fetchDay(today), fetchDay(tomorrow)]);

    for (const r of [todayRes, tomorrowRes]) {
      if (!r.ok) {
        const text = await r.text();
        console.error("[trafikverket proxy] API error", r.status, text.slice(0, 500));
        return {
          statusCode: r.status,
          headers: { "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ error: "Trafikverket API error", status: r.status }),
        };
      }
    }

    const [todayData, tomorrowData] = await Promise.all([todayRes.json(), tomorrowRes.json()]);

    // Surface any API-level errors from Trafikverket
    for (const d of [todayData, tomorrowData]) {
      const apiError = d?.RESPONSE?.RESULT?.[0]?.ERROR;
      if (apiError) {
        console.error("[trafikverket proxy] Trafikverket query error:", JSON.stringify(apiError));
        return {
          statusCode: 502,
          headers: { "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ error: "Trafikverket query error", details: apiError }),
        };
      }
    }

    const announcements = [
      ...(todayData?.RESPONSE?.RESULT?.[0]?.TrainAnnouncement ?? []),
      ...(tomorrowData?.RESPONSE?.RESULT?.[0]?.TrainAnnouncement ?? []),
    ];

    // Map raw TrainAnnouncement objects to clean train objects
    const trains = announcements.map(a => {
      const schedMs   = new Date(a.AdvertisedTimeAtLocation).getTime();
      const actualMs  = a.TimeAtLocation     ? new Date(a.TimeAtLocation).getTime()     : null;
      const estMs     = a.EstimatedTimeAtLocation ? new Date(a.EstimatedTimeAtLocation).getTime() : null;

      let delay = 0;
      if (actualMs != null)  delay = Math.round((actualMs - schedMs) / 60000);
      else if (estMs != null) delay = Math.round((estMs   - schedMs) / 60000);

      // First ToLocation entry that is a "real" destination (Priority 1 or just first)
      const toStation = (a.ToLocation ?? [])
        .slice()
        .sort((x, y) => (x.Order ?? 0) - (y.Order ?? 0))
        .slice(-1)[0]?.LocationName ?? "";

      const product   = a.ProductInformation?.[0]?.Description ?? "Tåg";
      const deviation = (a.Deviation ?? [])
        .map(d => d.Description ?? d.Code ?? "")
        .filter(Boolean);

      return {
        trainId:       a.AdvertisedTrainIdent,
        scheduledTime: a.AdvertisedTimeAtLocation,
        actualTime:    a.TimeAtLocation ?? null,
        delay:         Math.max(0, delay),
        canceled:      a.Canceled === true,
        toStation,
        toLocations:   (a.ToLocation ?? []).map(l => l.LocationName),
        product,
        deviation,
        track:         a.TrackAtLocation ?? null,
      };
    });

    console.log(`[trafikverket proxy] ${station} ${type} (${today}+${tomorrow}): ${trains.length} announcements`);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=55",
      },
      body: JSON.stringify({ trains }),
    };

  } catch (err) {
    console.error("[trafikverket proxy]", err.message);
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: err.message }),
    };
  }
}
