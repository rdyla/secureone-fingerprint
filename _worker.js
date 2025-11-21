// _worker.js — Monday write proxy for Zoom Virtual Agent

const MONDAY_API_URL = "https://api.monday.com/v2";

// Static board ID (never changes)
const BOARD_ID = "9729411524";

// Helper for safe JSON stringify in logs
const D = (o) => {
  try {
    return JSON.stringify(
      o,
      (_k, v) =>
        typeof v === "string" && v.length > 500
          ? v.slice(0, 500) + "…"
          : v
    );
  } catch {
    return String(o);
  }
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Only handle POST /monday/write
    if (req.method === "POST" && path === "/monday/write") {
      return handleMondayWrite(req, env);
    }

    return new Response(
      JSON.stringify({
        ok: false,
        message: "Not found",
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }
    );
  },
};

async function handleMondayWrite(req, env) {
  if (!env.MONDAY_API_KEY) {
    return json(
      {
        ok: false,
        message: "MONDAY_API_KEY env var is not set on the Worker.",
      },
      500
    );
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json(
      {
        ok: false,
        message: "Invalid JSON body.",
        error: e?.message || String(e),
      },
      400
    );
  }

  // ---- Input payload from ZVA (or any client) ----
  // Expecting something like:
  // {
  //   "name": "John Doe",
  //   "dateTime": "2025-11-21T15:30:00-08:00",
  //   "phone": "17145551212",
  //   "email": "john@example.com",
  //   "issue": "Fingerprint appointment question",
  //   "division": "Arizona",
  //   "callerId": "17145551212",
  //   "zoomGuid": "abc-123-xyz"
  // }
  const S = (v) => (v == null ? "" : String(v).trim());

  const name = S(body.name);
  const dateTime = S(body.dateTime); // you can send either full datetime or date
  const phone = S(body.phone);
  const email = S(body.email);
  const issue = S(body.issue);
  const division = S(body.division);
  const callerId = S(body.callerId);
  const zoomGuid = S(body.zoomGuid);

  // Defaults / constants per your spec
  const department = "Fingerprint";
  const departmentEmail = "livescan@secureone.com";
  const emailStatus = S(body.emailStatus || "Not Sent");

  // If dateTime is blank, default to today's date (YYYY-MM-DD)
  const now = new Date();
  const defaultDate = now.toISOString().slice(0, 10);
  const dateValue = dateTime || defaultDate;

  // ---- Build Monday columnValues object ----
  // Column IDs you provided:
  //  name                  → "name"
  //  Date/Time:            → "date4"
  //  Phone Number:         → "phone_mktdphra"
  //  Email Address:        → "email_mktdyt3z"
  //  Call Issue/Reason:    → "text_mktdb8pg"
  //  Division:             → "color_mktd81zp"
  //  Department:           → "color_mktsk31h"
  //  Department Email:     → "text_mkv07gad"
  //  Email Status:         → "color_mkv0cpxc"
  //  Caller ID:            → "phone_mkv0p9q3"
  //  Item ID:              → "pulse_id_mkv6rhgy"  (we'll leave for now or fill later)
  //  Zoom Call GUID:       → "text_mkv7j2fq"

  const columnValues = {
    name: name || "Unknown caller",
    date4: dateValue,
    phone_mktdphra: phone,
    email_mktdyt3z: email,
    text_mktdb8pg: issue,
    color_mktd81zp: division,
    color_mktsk31h: department,
    text_mkv07gad: departmentEmail,
    color_mkv0cpxc: emailStatus,
    phone_mkv0p9q3: callerId,
    // pulse_id_mkv6rhgy: ""   // you may fill this later with a second mutation using the created item ID
    text_mkv7j2fq: zoomGuid,
  };

  // ---- Monday GraphQL mutation ----
  const graphqlQuery = `
    mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(
        board_id: $boardId,
        item_name: $itemName,
        column_values: $columnValues
      ) {
        id
        name
        column_values {
          id
          text
        }
      }
    }
  `;

  const itemName =
    name && issue
      ? `${name} – ${issue}`
      : name || "Zoom Virtual Agent Call";

  const variables = {
    boardId: BOARD_ID,
    itemName,
    columnValues: JSON.stringify(columnValues),
  };

  const payload = {
    query: graphqlQuery,
    variables,
  };

  // Optional debug (does NOT log the API key)
  console.log("[MONDAY_WORKER] request variables:", D(variables));

  let mondayRes;
  try {
    mondayRes = await fetch(MONDAY_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: env.MONDAY_API_KEY,
        "API-Version": "2023-10",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("[MONDAY_WORKER] fetch error:", e);
    return json(
      {
        ok: false,
        message: "Network error calling Monday.com",
        error: e?.message || String(e),
      },
      502
    );
  }

  const text = await mondayRes.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    console.error("[MONDAY_WORKER] Non-JSON response:", text);
    return json(
      {
        ok: false,
        message: "Non-JSON response from Monday.com",
        http_status: mondayRes.status,
        raw: text,
      },
      500
    );
  }

  if (!mondayRes.ok || data.error || data.errors) {
    console.error("[MONDAY_WORKER] Monday error:", D(data));
    return json(
      {
        ok: false,
        message: "Monday.com returned an error",
        http_status: mondayRes.status,
        monday: data,
      },
      mondayRes.status || 500
    );
  }

  const created = data?.data?.create_item || {};
  const itemId = created.id || "";
  const itemNameOut = created.name || "";

  return json(
    {
      ok: true,
      message: "Monday item created successfully.",
      boardId: BOARD_ID,
      mondayItemId: itemId,
      mondayItemName: itemNameOut,
      columnValuesSent: columnValues,
      mondayRaw: data,
    },
    200
  );
}

// Small helper to return JSON Responses
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
