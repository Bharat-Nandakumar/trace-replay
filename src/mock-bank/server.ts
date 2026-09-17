import { app } from "./app.js";

const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer from 1 to 65535");
}

app.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Mock bank app: http://127.0.0.1:${port}/start\n`);
});
