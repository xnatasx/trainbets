// Netlify Function: CORS proxy for Trafikverket API
// Frontend POSTs {station, type} → we build the query, forward to Trafikverket, return {trains:[...]}

const TV_API = "https://api.trafikinfo.trafikverket.se/v2/data.json";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const apiKey = process.env.TRAFIKVERKET_API_KEY || "4135d9b931704bf99d40ca7f84fcf9ad";

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

    // Use CET date so it matches what Trafikverket serves
    const dateStr = new Date().toLocaleDateString("sv-SE"); // "YYYY-MM-DD" in sv-SE locale

    const tvResponse = await fetch(TV_API, {
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
                { GT: [{ name: "AdvertisedTimeAtLocation", value: dateStr + "T00:00:00.000+01:00" }] },
                { LT: [{ name: "AdvertisedTimeAtLocation", value: dateStr + "T23:59:59.000+01:00" }] },
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

    if (!tvResponse.ok) {
      const text = await tvResponse.text();
      console.error("[trafikverket proxy] API error", tvResponse.status, text.slice(0, 500));
      return {
        statusCode: tvResponse.status,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Trafikverket API error", status: tvResponse.status }),
      };
    }

    const data = await tvResponse.json();

    // Surface any API-level errors from Trafikverket
    const apiError = data?.RESPONSE?.RESULT?.[0]?.ERROR;
    if (apiError) {
      console.error("[trafikverket proxy] Trafikverket query error:", JSON.stringify(apiError));
      return {
        statusCode: 502,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Trafikverket query error", details: apiError }),
      };
    }

    const announcements = data?.RESPONSE?.RESULT?.[0]?.TrainAnnouncement ?? [];

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

    console.log(`[trafikverket proxy] ${station} ${type}: ${trains.length} announcements`);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=30",
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
