for await (const _ of process.stdin);
process.kill(process.pid, "SIGTERM");
