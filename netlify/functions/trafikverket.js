// Netlify Function: CORS proxy for Trafikverket API
// Frontend POSTs here → we forward to Trafikverket with the API key → return JSON

export async function handler(event) {
  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const apiKey = process.env.TRAFIKVERKET_API_KEY || "4135d9b931704bf99d40ca7f84fcf9ad";
    const { objectType = "TrainAnnouncement", filter, includes } = JSON.parse(event.body);

    const response = await fetch("https://api.trafikinfo.trafikverket.se/v2/data.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        REQUEST: {
          LOGIN: { authenticationkey: apiKey },
          QUERY: [{
            objecttype: objectType,
            schemaversion: "1.8",
            FILTER: filter,
            INCLUDE: includes,
          }],
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        statusCode: response.status,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Trafikverket API error", details: text }),
      };
    }

    const data = await response.json();
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=30",
      },
      body: JSON.stringify(data),
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
