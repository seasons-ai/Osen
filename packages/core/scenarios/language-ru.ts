// Existing stands check Russian texts, while the default process language is English: pin ru.
// The processes the stand launches (council, MCP server) inherit the environment variable.
import { setProcessLanguage } from "../src/i18n/index.ts";
process.env["COUNCIL_LANG"] = "ru";
setProcessLanguage("ru");
