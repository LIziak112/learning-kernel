import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createDemoServer } from "./demo.ts";

const directory = resolve("data");
mkdirSync(directory, { recursive: true });
const server = createDemoServer(resolve(directory, "demo.sqlite"));
server.listen(3000, "127.0.0.1", () => {
  console.log("两步阅读 http://127.0.0.1:3000/demo/reading");
  console.log("教师评阅 http://127.0.0.1:3000/demo/teacher");
});
