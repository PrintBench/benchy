import { Store } from "./store.js";

const [command, id] = process.argv.slice(2);
if (
  command !== "status" &&
  (!id || !["retry-job", "reset-route"].includes(command))
) {
  console.error(
    "Usage: npm run maintenance -- status | retry-job JOB_ID | reset-route SOURCE_MESSAGE_ID",
  );
  process.exit(1);
}
const store = new Store(process.env.DATA_DIR || "./data");
try {
  if (command === "status") {
    console.log(JSON.stringify(store.status(), null, 2));
  } else {
    const changed =
      command === "retry-job" ? store.retryFailed(id) : store.clearRoute(id);
    console.log(
      changed ? "Updated." : "No matching failed job or incomplete route.",
    );
    if (!changed) process.exitCode = 1;
  }
} finally {
  store.close();
}
