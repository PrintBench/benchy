export function log(level: "info" | "error", event: string, details = {}) {
  const write = level === "error" ? console.error : console.log;
  write(
    JSON.stringify({
      time: new Date().toISOString(),
      level,
      event,
      ...details,
    }),
  );
}

// Discord errors may include full HTTP request bodies. Log identifiers and status only.
export function errorDetails(error: unknown) {
  if (!(error instanceof Error)) return { error: "Unknown error" };
  const { code, status } = error as Error & {
    code?: unknown;
    status?: unknown;
  };
  return { error: error.name, code, status };
}
