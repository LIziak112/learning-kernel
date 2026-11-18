import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createDemoServer } from "./demo.ts";

const directory = resolve("data");
mkdirSync(directory, { recursive: true });
const server = createDemoServer(resolve(directory, "demo.sqlite"));
server.listen(3000, "127.0.0.1", () => {
  console.log("学生演示入口 http://127.0.0.1:3000/demo/student");
});
