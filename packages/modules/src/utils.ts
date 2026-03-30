export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value), null, 2);
}

export function summarizeForStorage(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return "[MaxDepthExceeded]";
  }

  if (
    value == null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "string") {
    return value.length > 2048
      ? `${value.slice(0, 2048)}...[truncated ${value.length - 2048} chars]`
      : value;
  }

  if (value instanceof URL) {
    return value.toString();
  }

  if (value instanceof Uint8Array) {
    return { type: "Uint8Array", byteLength: value.byteLength };
  }

  if (value instanceof ArrayBuffer) {
    return { type: "ArrayBuffer", byteLength: value.byteLength };
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, 50)
      .map((item) => summarizeForStorage(item, depth + 1));
    if (value.length > 50) {
      items.push(`[Truncated ${value.length - 50} items]`);
    }
    return items;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 50);

    const objectEntries = entries.map(([key, entryValue]) => [
      key,
      summarizeForStorage(entryValue, depth + 1)
    ]);

    if (Object.keys(value as Record<string, unknown>).length > 50) {
      objectEntries.push(["__truncated__", "Additional keys omitted"]);
    }

    return Object.fromEntries(objectEntries);
  }

  return String(value);
}

export function stringifyForStorage(value: unknown): string {
  return JSON.stringify(summarizeForStorage(value));
}

export function serializeError(error: unknown): string {
  return stringifyForStorage(
    error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack
        }
      : { message: String(error) }
  );
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sortValue(value: unknown): unknown {
  if (value == null || typeof value !== "object") {
    return value;
  }

  if (value instanceof URL) {
    return value.toString();
  }

  if (value instanceof Uint8Array) {
    return { type: "Uint8Array", byteLength: value.byteLength };
  }

  if (value instanceof ArrayBuffer) {
    return { type: "ArrayBuffer", byteLength: value.byteLength };
  }

  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortValue(entryValue)])
  );
}
