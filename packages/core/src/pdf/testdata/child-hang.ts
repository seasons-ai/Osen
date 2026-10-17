import { writeFileSync } from "node:fs";

writeFileSync(process.env.PID_FILE!, String(process.pid));
setInterval(() => {}, 1000);
