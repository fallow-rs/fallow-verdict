#!/usr/bin/env node
try {
  const { main } = await import("../dist/cli/main.js");
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error && error.code === "ERR_MODULE_NOT_FOUND") {
    console.error("fallow-verdict is not built. Run `npm run build` first.");
    process.exitCode = 2;
  } else {
    throw error;
  }
}
