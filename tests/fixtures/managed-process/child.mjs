process.stdout.write("MANAGED_PROCESS_READY\n");

const timer = setInterval(() => {}, 1_000);

process.on("SIGTERM", () => {
  clearInterval(timer);
  process.stdout.write("MANAGED_PROCESS_STOPPED\n", () => process.exit(0));
});
