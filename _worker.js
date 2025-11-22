// _worker.js — Monday write proxy for Zoom Virtual Agent (Fingerprint flow)

const MONDAY_API_URL = "https://api.monday.com/v2";

// Static board ID
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

    if (req.method === "POST" && path === "/monday/write") {
      return handleMondayWrite(req, env);
    }

    return json(
      {
        ok: false,
        message: "Not found",
      },
      404
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

  const S = (v) => (v == null ? "" : String(v).trim());

  const name = S(body.name);
  const dateTimeRaw = S(body.dateTime);
  const phone = S(body.phone);
  const email = S(body.email);
  const issue = S(body.issue);
  const division = S(body.division);
  const callerId = S(body.callerId);
  const zoomGuid = S(body.zoomGuid);

  // Defaults
  const department = "Fingerprint";
  const departmentEmail = "livescan@secureone.com";

  // ---- Normalize dateTime into YYYY-MM-DD ----
  const now = new Date();
  const defaultDate = now.toISOString().slice(0, 10);

  function normalizeDateString(input, fallback) {
    if (!input) return fallback;

    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(input)) return input;

    const d = new Date(input);
    if (Number.isNaN(d.getTime())) return fallback;

    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");

    return `${yyyy}-${mm}-${dd}`;
  }

  const dateValue = normalizeDateString(dateTimeRaw, defaultDate);

  // ---- Build Monday columnValues with correct structures ----
  const columnValues = {
    // Name (text)
    name: name || "Unknown caller",

    // Date (date column)
    date4: dateValue,

    // Phone Number (phone column)
    ...(phone && {
      phone_mktdphra: {
        phone,
        countryShortName: "",
      },
    }),

    // Email Address (email column)
    ...(email && {
      email_mktdyt3z: {
        email,
        text: email,
      },
    }),

    // Call Issue/Reason (text)
    ...(issue && {
      text_mktdb8pg: issue,
    }),

    // Division (status/color)
    ...(division && {
      color_mktd81zp: {
        label: division, // must match an existing label
      },
    }),

    // Department (status/color)
    color_mktsk31h: {
      label: department, // "Fingerprint"
    },

    // Department Email (text)
    text_mkv07gad: departmentEmail,

    // Caller ID (phone column)
    ...(callerId && {
      phone_mkv0p9q3: {
        phone: callerId,
        countryShortName: "",
      },
    }),

    // Zoom Call GUID (text)
    ...(zoomGuid && {
      text_mkv7j2fq: zoomGuid,
    }),
  };

  // Remove empty values
  const cleanedColumnValues = {};
  for (const [key, value] of Object.entries(columnValues)) {
    if (value !== undefined && value !== null && value !== "") {
      cleanedColumnValues[key] = value;
    }
  }

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
    columnValues: JSON.stringify(cleanedColumnValues),
  };

  console.log("[MONDAY_WORKER] variables:", D(variables));

  let mondayRes;
  try {
    mondayRes = await fetch(MONDAY_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: env.MONDAY_API_KEY,
        "API-Version": "2023-10",
      },
      body: JSON.stringify({
        query: graphqlQuery,
        variables,
      }),
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
      columnValuesSent: cleanedColumnValues,
      mondayRaw: data,
    },
    200
  );
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
