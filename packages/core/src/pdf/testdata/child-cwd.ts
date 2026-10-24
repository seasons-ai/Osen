for await (const _ of process.stdin);
// one reply shape read by the PDF, document and archive callers: the working directory is the text
process.stdout.write(JSON.stringify({ ok: true, text: process.cwd(), pages: 1, format: "docx", entries: [], duplicates: [], cwd: process.cwd() }) + "\n");
