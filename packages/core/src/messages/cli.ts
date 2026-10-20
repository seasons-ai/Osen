import { defineMessages } from "../i18n/catalog.ts";
import { MAX_TURN_TIMEOUT_SEC } from "../protocol/schema.ts";
import { PDF_LIMITS } from "../pdf/extract.ts";
import { URL_LIMITS } from "../url/fetch.ts";

// Output, help and refusals of the council command. Exit codes, commands, flags, identifiers and numbers do not depend on the language.
const MIB = 2 ** 20;
const EXAMPLE_P = "--participant scripted:packages/core/scenarios/consensus/p1.json --participant scripted:packages/core/scenarios/consensus/p2.json --max-rounds 3";

export const cliMessages = defineMessages({
  en: {
    help: `Usage:
  council --topic <text> --participant <participant> --participant <participant> …
          [--max-rounds <n>] [--framing <text>] [--turn-timeout <sec>] [--context-chars <n>]
          [--template <id>] [--attach <path>]… [--include <path>]… [--no-ignore] [--url <address>]… [--materials-chars <n>]
          [--preview-materials] [--prepared-materials <id>]
          [--max-tokens <n> | --no-max-tokens]
          [--pause-after-round] [--wait-for-owner] [--owner-wait-sec <N>] [--lineup <id>]
          [--drafts [--synthesizer <pN>]]
  council --preview-materials [--attach <path>]… [--include <path>]… [--no-ignore] [--url <address>]… [--materials-chars <n>]
  council providers [--json]
  council templates [--json]
  council lineups [--json]
  council lineups save <name> --from-session <id>
  council list [--json]
  council show <id> [--json]
  council stop <id>
  council say <id> [--answer <qN>] <text>
  council status <id> [--json]
  council continue <id>
  council resume <id> [--rounds <n>] [--max-tokens <n> | --no-max-tokens] [--replace <pN>=<entry>]… [--message <text>]
  council doctor [--json]
  council cli install <agent> [--version <X>] [--candidate]
  council cli list
  council cli use <agent> <version>
  council cli rollback <agent>
  council cli candidates [--agent <agent>] [--json]
  council cli accept <agent> <version> [--candidate] [--model <id>] [--max-calls <N>] [--save-fixture <folder>]
  council home
  council --help

Subcommands:
  providers  providers from config.json: availability, version, path or address, key, models
  templates  discussion templates: identifier, category, title, source; load errors listed separately
  lineups    list of named participant lineups
  lineups save <name> --from-session <id>  save a session's participants as a named lineup
  list       sessions, newest first
  show <id>  turns and state of a session; the owner's choice, if made in the app
  stop <id>  request a running session to stop (from another terminal)
  say <id> [--answer <qN>] <text>  send an owner message to a running session or answer a participant's question (from another terminal)
  status <id>  session state and the current owner wait
  continue <id>  release the current owner wait of a running session (from another terminal)
  resume <id>  continue a saved session (interrupted, no_consensus, stopped; consensus — only with --message; failed — only after the "fewer than two active participants" failure and with --replace)
  doctor     diagnostics: binary, version, runtime, data folder, config, providers; no model calls
  cli install <agent> [--version <X>] [--candidate]  install a pinned claude or codex into the data folder (needs npm and network; the newest verified version by default; --candidate does not activate it)
  cli list   pinned installs, the active one and the previous one
  cli use <agent> <version>  make an installed verified version active
  cli rollback <agent>  return to the previous active version (one step)
  cli accept <agent> <version> [--candidate] [--model <id>] [--max-calls <N>] [--save-fixture <folder>]  check an installed version with the real probes; without --max-calls only the plan and the exact bound of model calls are printed, no call is made; the version is recorded as real only when all probes pass; --save-fixture saves the anonymized valid turn to the folder
  home       data folder path

Flags:
  --topic <text>           discussion topic (required)
  --participant <entry>    participant; repeatable, the order sets the turn order (at least 2 required);
                           if omitted — default participants from config.json
  --max-rounds <n>         round limit, integer of at least 1 (default from the template, otherwise from config.json)
  --framing <text>         discussion framing (default — the template's framing, without a template — the neutral framing)
  --turn-timeout <sec>     turn timeout in seconds, integer from 1 to ${MAX_TURN_TIMEOUT_SEC} (default from the template, otherwise from config.json)
  --context-chars <n>      context size in characters, integer of at least 1 (default from the template, otherwise from config.json)
  --attach <path>          file or folder with materials; a large folder is saved as a snapshot; repeatable (see "Materials")
  --include <path>         bring back a file or folder excluded by the .gitignore rules of an attached folder; repeatable (see "Materials")
  --no-ignore              do not apply the .gitignore rules of attached folders; incompatible with --include
  --materials-chars <n>    limit of the initial materials set included in every request, in characters, integer of at least 1 (default defaults.materialsChars from config.json)
  --url <address>          public http(s) link as a material; repeatable (see "Links")
  --preview-materials      only prepare and show the materials, without a session or model calls
  --prepared-materials <id>  start with the set shown by the preview
  --template <id>          discussion template: framing, participant roles in order and default limits; list — council templates
  --lineup <id>            lineup instead of --participant; incompatible with --participant; list — council lineups
  --from-session <id>      only for lineups save: the session whose participants are saved to the lineup
  --drafts                 "independent drafts" experiment: each participant first writes their own version without seeing the others (see "Independent drafts")
  --synthesizer <pN>       only with --drafts: the participant who starts the regular discussion (default p1, the first participant)
  --max-tokens <n>         session token cap (sum of input and output tokens of all model calls), integer of at least 1
                           (without the flag — defaults.maxTotalTokens from config.json, if set); for resume — the new cap
  --no-max-tokens          no token cap (also disables the value from config.json); for resume — remove the cap; incompatible with --max-tokens
  --pause-after-round      after every round without an outcome wait for the owner (see "Owner wait")
  --wait-for-owner         wait for the answer to a question to the owner before the next turn
  --owner-wait-sec <N>     wait period in seconds, integer from 1 to 86400 (default 300); requires one of the two modes above
  --answer <qN>            only for say: the message answers question qN addressed to the owner
  --rounds <n>             only for resume: how many more rounds to run, counting the unfinished one, integer of at least 1
                           (without the flag — the rest of the previous limit)
  --replace <pN>=<entry>   only for resume, repeatable: replace the dropped or unavailable participant pN; the entry is as for --participant;
                           the new participant gets the next identifier, the place and role of the previous one, agreements are reset
  --message <text>         only for resume: owner message written before the first turn of the resume; resets agreements;
                           required for a session with consensus
  --json                   print one JSON document to stdout (status, list, show, providers, templates, lineups, doctor)
  --help                   this help

Participant entry: [name=]<provider>[:<model>]
  Provider — an identifier from config.json (by default claude, codex); without a model — the CLI's default model.
  For an openai-http provider the model is required, colons in its name are allowed: openrouter:vendor/model:free
  Examples: claude · codex:<model> · Ann=claude:haiku · scripted:<path to the scenario file>
  Default name: the provider's label (with the model, if given); for scripted — "Participant N".
  scripted participants are available only with COUNCIL_DEV=1.

config.json is created in the data folder on the first run from the CLIs found (claude, codex) and is never overwritten.

Materials: the engine reads the files and folders from --attach once before the start, and the initial set goes into the request of every turn; participants have no tools and no disk access, files from the snapshot are served by the engine. In a folder, hidden names, names from defaults.materialsIgnore in config.json (initially node_modules, dist, build), non-text files and symbolic links are skipped with the reason shown. .gitignore files inside the attached folder (the root one and nested ones) work as in git, including the "!" negation: paths they exclude go neither into the initial set, nor into the snapshot, nor into the folder listing, and are printed in the summary under "Excluded by rules" — a whole folder on one line, with the rule. Rules above the attached folder and global git settings are not read; a file named explicitly in --attach is never excluded by rules. --include <path> brings back an excluded file or folder (a folder — whole): a file system path or the name as printed in that section; a path the rules did not exclude rejects the start. --no-ignore turns the rules off entirely. The start is rejected if a path is not found or not readable, an explicitly named file is non-text or a symbolic link, or any .env or .env.* file is met. From a PDF the text layer is taken (per file no more than ${PDF_LIMITS.bytes / MIB} MiB, ${PDF_LIMITS.pages} pages, ${PDF_LIMITS.ms / 1000} seconds, ${PDF_LIMITS.rssBytes / MIB} MiB of memory and ${PDF_LIMITS.chars} characters); an encrypted, damaged PDF and a PDF without a text layer are rejected when named explicitly and skipped with a reason in a folder, images are not recognized. The --materials-chars limit (default defaults.materialsChars, initially 60000) counts text characters (UTF-16 units, like --context-chars); explicitly named files are never truncated, and their exceeding the limit rejects the start. A folder is saved in the session whole as a snapshot with its own bound of 20000000 characters (more — refusal). If a folder is larger than the limit, the initial set takes descriptions (md, markdown, mdx, txt, rst, adoc, pdf) closer to the root, or, if there are none, files closer to the root, while they fit; the other files participants read from the snapshot on request (up to 5 names and 40000 characters per request, no more than 3 calls per turn). The source folder is not read after the start, resume uses the snapshot.

Links: only an address named in --url is loaded (links from the topic and materials are not loaded); only public http and https addresses without a login and password are accepted, internal addresses and redirects to them are rejected; no more than ${URL_LIMITS.ms / 1000} seconds, ${URL_LIMITS.redirects} redirects and ${URL_LIMITS.bytes / MIB} MiB per link; text/plain, text/markdown and text/html in UTF-8 are accepted, from HTML the text is taken without scripts, styles and hidden elements, JavaScript is not executed. The text is saved as a snapshot, turns and resume do not use the network; the snapshot keeps the scheme, site name and path, query parameters are neither saved nor printed. --preview-materials shows the full text and gives a set identifier valid for 24 hours for --prepared-materials; a refusal of any link — code 2 without a session.

Owner message: say queues the text for a running session, the engine applies it after the current turn, the running turn is not interrupted. Everyone who agreed must speak again: agreement requires a new agreement of every active participant. Participants see all messages in every following request and know that the owner's message outweighs the participants' opinions. A finished, interrupted or unknown session rejects the message. Text starting with a hyphen goes after --: council say <id> -- "-text".

Questions to the owner: a participant can address a question to the owner — in the output it is a "Question to the owner" line with the identifier qN. Answer: council say <id> --answer <qN> <text>. An answer is an owner message: it resets those who agreed, and the question is closed as answered. Without --wait-for-owner the discussion does not wait for the answer: an unanswered question is closed before the asking participant's next turn, and the participants decide on their own. An unknown question, one addressed to a participant or already closed, rejects the answer.

Owner wait: --pause-after-round stops the discussion after every round without an outcome, --wait-for-owner — before the next turn while a question to the owner is unanswered. --owner-wait-sec sets the period (default 300 s); when it expires the discussion continues on its own within the round limit. A regular message (say) does not release the pause, an answer to a question (say --answer) releases the question, continue releases the whole wait and closes unanswered questions without an answer. continue does not start new participants and does not add rounds, unlike resume. During the wait models are not called; the session status stays "running"; state — council status <id>.

Resume: resume continues a session with the status interrupted, no_consensus or stopped from the same place; the topic, framing, template and limits do not change, the other start flags are not accepted. The lineup changes only with the --replace <pN>=<entry> flag: the previous participant keeps their identifier and history, the new one gets the next identifier, the place and role of the previous one, all agreements are reset and every active participant confirms the version again. A session with the status consensus can be continued only with an owner message (--message <text>): it is written before the first turn of the resume, resets the agreements, and every active participant speaks again. A session with the status failed can be continued only after the "fewer than two active participants" failure and only with a replacement after which there are at least two active participants. A refusal (session not found, running, consensus reached, a different failure, no rounds left, unavailable provider, material snapshot, invalid replacement: a repeat or unknown pN, an available active participant, an unavailable new participant, too many participants) gives the reason and code 2.

Independent drafts (experiment): off by default. With --drafts each participant first writes their own version of the solution without seeing the others; then the synthesizer starts the regular discussion (by default the first participant). Model call bound — participants × (rounds + 1) × 3. Drafts do not count as agreement. All drafts are passed whole into every regular turn and must fit into --context-chars, otherwise the session fails before the discussion. Check the benefit of the mode for decision quality yourself — it is not proven.

Token cap: counted as the sum of input and output tokens of all model calls of the session that reported them, including failed attempts, file requests and drafts (calls without data are not counted, the accounting is marked incomplete). Checked between turns and may be exceeded by one turn: a running turn is not cut off. A reached cap stops the session with the status stopped and the reason token_cap, code 4; if the turn that exceeded the cap gave everyone's agreement, agreement wins (consensus). After every turn a "Usage" line is printed. Resuming a session stopped by the cap requires --max-tokens greater than already spent or --no-max-tokens.

Templates are JSON files: built-in ones and the user's own from the templates/ folder of the data folder; a user template with a built-in identifier overrides it. The neutral framing for a topic without a template is the neutral.md file in the same place. Templates can be created and edited in the app (the "New" section: the template editor and "Save as template" in session setup); council has no new commands for this; a template's round limit can be above 20, while the start form in the app accepts 1 to 20.

Lineups: named participant lineups are stored in lineups.json of the data folder separately from templates (identifier, name, ordered provider, model and role), without keys and topic; they are saved only by the explicit lineups save command from a session's participants; the name is a single line of up to 100 characters, a repeated name is rejected. A start by lineup (--lineup) takes the participants, models, roles and order from the lineup, and the framing and limits from the template and flags; the template's roles are not applied in this case. Before the start the lineup is checked against the current registry: a missing or unavailable provider rejects the start with code 2, a model missing from the current list gives a warning; there is no substitution. scripted participants in a lineup are available only with COUNCIL_DEV=1.

HTTP provider keys come from environment variables; the environment is supplemented from the .env of the data folder and the .env of the current folder (an environment variable wins over a file).

Data: the \`model-council\` folder in the system application folder; overridden by the COUNCIL_HOME variable.
history-pins.json in it holds the pins of the app's "History" screen; the council command does not read it.

Language: the COUNCIL_LANG variable (en or ru), then the language setting of the app (preferences.json of the data folder), by default English.

Exit codes:
  0  consensus
  1  internal error
  2  invalid arguments, unknown session, rejected stop, rejected message, rejected wait release, error in config.json, unavailable provider, unknown template, unknown or unavailable lineup, lineup save refusal, materials refusal, link or set refusal, resume refusal
  3  no_consensus
  4  stopped
  5  failed

Example:
  COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council --topic "What to name the cat" ${EXAMPLE_P}
  COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council --topic "What to improve in the template format" --attach docs/templates.md ${EXAMPLE_P}`,
    error: (m: string) => `Error: ${m}`,
    internalError: (m: string) => `Internal error: ${m}`,
    warning: (m: string) => `Warning: ${m}`,
    intRange: (flag: string, min: number, max: number) => `${flag}: an integer from ${min} to ${max} is required.`,
    intRequired: (flag: string) => `${flag}: an integer of at least 1 is required.`,
    // parsing a participant record
    badEntry: (raw: string) => `Invalid participant entry «${raw}»: expected [name=]<provider>[:<model>].`,
    scriptedNeedsPath: (raw: string) => `Invalid participant entry «${raw}»: scripted needs a path — scripted:<path>.`,
    noProvidersWord: "no providers",
    unknownProvider: (id: string, known: string) => `Unknown provider «${id}»: the registry has ${known}; a scripted participant — scripted:<path>.`,
    httpNeedsModel: (raw: string, id: string) => `Invalid participant entry «${raw}»: provider «${id}» needs a model — ${id}:<model>.`,
    modelNoColons: (raw: string) => `Invalid participant entry «${raw}»: the model name contains no colons.`,
    includeAmbiguous: (g: string) => `--include «${g}»: the name matches several attached folders, give an absolute path.`,
    // materials
    materials: (n: number, total: number, limit: number) => `Materials: ${n}, size ${total} characters (limit ${limit}).`,
    folderSnapshot: (files: number, chars: number, bound: number) => `Folder snapshot: files ${files}, size ${chars} characters (bound ${bound}).`,
    leftOut: (n: number) => `Not in the initial set: ${n} (participants read on request)`,
    andMore: (n: number) => `  … and ${n} more`,
    excludedByRules: (n: number) => `Excluded by rules: ${n}`,
    skipped: (n: number) => `Skipped: ${n}`,
    linkSources: (n: number) => `Link sources: ${n}`,
    linkSourcesUnreadable: (file: string) => `Link sources: could not read ${file}`,
    materialsRejected: (reasons: string) => `Materials not accepted:\n${reasons}`,
    preparedNotCreated: (m: string) => `Prepared set not created: ${m}`,
    preparedNotAccepted: (m: string) => `Prepared set not accepted: ${m}`,
    preparedSet: (id: string) => `Prepared set: ${id}`,
    preparedSaved: (id: string) => `Prepared set: ${id} (valid for 24 hours; no model calls were made)`,
    preparedRun: (id: string) => `Start: council --topic "<topic>" --participant <participant> --participant <participant> --prepared-materials ${id}`,
    // usage
    spendNoTokens: (cap: number | undefined) => `Usage: participants do not report tokens, accounting incomplete${cap !== undefined ? `; cap ${cap} is not checked` : ""}`,
    spendIncompleteNote: " (accounting incomplete: not all turns reported tokens)",
    spendOfCap: (total: number, cap: number, note: string) => `Usage: spent ${total} of ${cap} tokens${note}`,
    spendNoCap: (total: number, note: string) => `Usage: ${total} tokens, no cap${note}`,
    filesRead: (list: string) => `Read from the folder: ${list}`,
    fileChars: (chars: number) => `${chars} characters`,
    fileCharsOf: (shown: number, chars: number) => `${shown} of ${chars} characters`,
    // session events
    sessionHeader: (id: string, n: number, rounds: number) => `Session ${id} · participants: ${n} · round limit: ${rounds}`,
    topic: (t: string) => `Topic: ${t}`,
    template: (id: string) => `Template: ${id}`,
    toVersion: (v: number) => ` → version ${v}`,
    normalized: " (agree with questions counted as object)",
    turn: (turn: number, round: number, pid: string, name: string, stance: string, notes: string) => `── Turn ${turn} · round ${round} · ${pid} «${name}» · ${stance}${notes}`,
    reasoning: (r: string) => `Arguments: ${r}`,
    answers: "Answers:",
    questions: "Questions:",
    ownerQuestion: (qid: string, pid: string, name: string, text: string) => `Question to the owner · ${qid} · ${pid} «${name}»: ${text}`,
    answerHint: (id: string, qid: string) => `  answer: council say ${id} --answer ${qid} "<text>"`,
    continueHint: (id: string) => `  continue: council continue ${id}`,
    turnFailed: (turn: number, pid: string, name: string, attempt: number, kind: string, m: string) => `✗ Turn ${turn} · ${pid} «${name}» · attempt ${attempt} · ${kind}: ${m}`,
    draft: (pid: string, name: string, attempts: number, chars: number) => `── Draft ${pid} «${name}» · attempts ${attempts} · ${chars} characters`,
    rationale: (r: string) => `Rationale: ${r}`,
    draftTextLabel: "Text:",
    draftTextUnavailable: "(draft text unavailable)",
    draftFailed: (pid: string, name: string, attempt: number, kind: string, m: string) => `✗ Draft ${pid} «${name}» · attempt ${attempt} · ${kind}: ${m}`,
    draftsFinished: (done: number, total: number, synth: string, name: string) => `── Drafts ready: ${done} of ${total}. The synthesizer ${synth} «${name}» starts the regular discussion.`,
    dropped: (pid: string, name: string, reason: string) => `✗ ${pid} «${name}» dropped out: ${reason}`,
    resumedCapRemoved: ", cap removed",
    resumedCap: (n: number) => `, token cap ${n}`,
    resumed: (rounds: number, cap: string) => `— Resumed: total round limit ${rounds}${cap} —`,
    replacementLine: (oldId: string, newId: string, name: string) => `  replacement: ${oldId} → ${newId} «${name}»`,
    ownerMessage: (id: string, after: number, answers: string) => `── Owner · ${id} · after turn ${after}${answers ? ` · answer to ${answers}` : ""}`,
    ownerSelected: (v: number, status: string) => `── The owner chose version ${v} · outcome at the moment of choice: ${status}`,
    note: (n: string) => `Note: ${n}`,
    waitStarted: (waitId: string, reasons: string, deadline: string) => `⏸ Owner wait ${waitId} · ${reasons} · until ${deadline}`,
    waitUpdated: (waitId: string, reasons: string) => `  wait ${waitId}: remaining — ${reasons}`,
    waitFinished: (waitId: string, how: string) => `▶ Wait ${waitId} released: ${how}`,
    questionUnanswered: (qid: string) => `  question ${qid} was left unanswered`,
    waitRoundBoundary: "pause after the round",
    waitQuestion: (ids: string) => `question to the owner${ids ? ` (${ids})` : ""}`,
    waitContinued: "the owner continued",
    waitAnswered: "answer received",
    waitExpired: "the period expired, the discussion continues on its own",
    waitStopped: "stop",
    // outcome
    summary: (status: string) => `══ Outcome: ${status}`,
    reason: (r: string) => `Reason: ${r}`,
    reasonCoded: (code: string, text: string) => `Reason: ${code} (${text})`,
    tokenCapCode: "token cap",
    tokenCapReason: (total: number, cap: number | undefined) => `Reason: token cap — spent ${total} of ${cap}`,
    synthUnavailable: (synth: string, name: string) => `the synthesizer ${synth} «${name}» dropped out without creating version 1; there is no replacement — start a new session with a different synthesizer (--synthesizer).`,
    draftsTooLong: (chars: number, limit: number | undefined) => `the drafts do not fit into the context limit (${chars} characters of ${limit} allowed by --context-chars); the joint discussion has not started.`,
    canReplace: (id: string) => `The session can be continued with a replacement of the dropped participant: council resume ${id} --replace <pN>=<provider>:<model>`,
    tokensIncomplete: (cap: number) => `Token accounting incomplete: cap ${cap} may not have triggered`,
    versionBy: (v: number, author: string) => `Version ${v}, author ${author}`,
    agreed: (list: string) => `Agreed: ${list}`,
    none: "none",
    objectors: "Objecting:",
    silent: "did not speak",
    decision: "Decision:",
    noDecision: "No decision.",
    // state and show
    running: "running",
    undetermined: "state undetermined",
    updateAdvice: "Update the app to read the whole session.",
    statusLine: (id: string, label: string) => `Session ${id}: ${label}`,
    roundOf: (round: number, max: number, turns: number) => `Round ${round} of ${max}, turns: ${turns}`,
    draftsPhase: (done: number, total: number, synth: string) => `Independent drafts phase: accepted ${done} of ${total}, synthesizer ${synth}`,
    noWait: "No owner wait.",
    waitLine: (waitId: string, reasons: string) => `Owner wait ${waitId}: ${reasons}`,
    questionNotFound: "question not found",
    deadline: (deadline: string, left: number) => `Deadline: ${deadline}, ${left > 0 ? `${left} s left` : "expired"}`,
    executorDown: (id: string) => `The executor is not running: the wait will continue after council resume ${id}.`,
    showStatus: (label: string) => `Status: ${label}`,
    currentVersion: (v: number, author: string) => `Current version ${v}, author ${author}:`,
    waitUntil: (waitId: string, reasons: string, deadline: string) => `Owner wait ${waitId}: ${reasons} · until ${deadline}`,
    draftsRunning: (done: number, total: number) => `Independent drafts phase in progress: accepted ${done} of ${total}.`,
    currentTurn: (turn: number, round: number, pid: string) => `Now turn ${turn} · round ${round} · ${pid}`,
    ownerChoice: (v: number) => `══ Owner's choice: version ${v} (not the models' agreement)`,
    chosenAt: (ts: string, status: string) => `Chosen: ${ts}, outcome at the moment of choice: ${status}`,
    versionText: (v: number) => `Version ${v} text:`,
    totals: (turns: number, drafts: string, sec: string) => `Total: turns ${turns}${drafts}, duration ${sec} s`,
    totalsDrafts: (n: number) => `, drafts ${n}`,
    totalsTokens: (i: string, o: string) => `, tokens ${i} / ${o}`,
    totalsCost: (usd: string) => `, cost $${usd}`,
    totalsCap: (cap: number) => `, cap ${cap}`,
    totalsIncomplete: " (usage accounting incomplete)",
    // argument parsing
    answerOnlySay: "The --answer flag applies only to the say command.",
    unknownCommand: (cmd: string) => `Unknown command «${cmd}».`,
    launchBadId: (id: string) => `Launch file: invalid session id «${id}».`,
    launchMissing: (path: string) => `Launch file not found: ${path}.`,
    launchUnreadable: (path: string, reason: string) => `Launch file cannot be read (${path}): ${reason}.`,
    launchDamaged: (path: string) => `Launch file is damaged (not valid JSON): ${path}.`,
    launchInvalid: (path: string, reason: string) => `Launch file has an unexpected content (${path}): ${reason}.`,
    launchExpired: (deadline: string) => `Launch file is stale: its deadline ${deadline} has passed.`,
    launchUsage: "council run-prepared <launch-file>",
    noArgs: (cmd: string) => `Command ${cmd} takes no arguments.`,
    cliUsage: "Command cli: install <agent> [--version <X>] [--candidate] | list | use <agent> <version> | rollback <agent> | candidates [--agent <agent>] [--json] | accept <agent> <version> [--candidate] [--model <id>] [--max-calls <N>] [--save-fixture <folder>].",
    cliUnknownSub: (sub: string) => `Unknown cli subcommand «${sub}». Expected: install, list, use, rollback, candidates, accept.`,
    cliWrongArgs: (sub: string, usage: string) => `Command cli ${sub} takes: ${usage}.`,
    cliFlagNotAllowed: (flag: string, sub: string) => `The ${flag} flag is not allowed for cli ${sub}.`,
    cliFlagOnlyCli: (flag: string) => `The ${flag} flag applies only to the command cli install.`,
    cliFlagOnlyInstallAccept: (flag: string) => `The ${flag} flag applies only to the commands cli install and cli accept.`,
    cliFlagOnlyAccept: (flag: string) => `The ${flag} flag applies only to the command cli accept.`,
    maxCallsRange: (value: string) => `--max-calls must be an integer of at least 1, got «${value}».`,
    flagNeedsValue: (flag: string) => `The ${flag} flag needs a value.`,
    agentOnlyCandidates: "The --agent flag applies only to the command cli candidates.",
    candidatesInterrupted: "The check was interrupted; temporary installs were removed, nothing was recorded.",
    candidatesHeader: (agent: string, base: string) => `${agent} (base ${base})`,
    candidatesNone: "no newer versions",
    candidatesFits: "fits",
    candidatesViolates: "violates the contract",
    candidatesAlreadyRecorded: "already recorded",
    candidatesNotRecorded: "not recorded",
    cliUnknownAgent: (agent: string, known: string) => `Unknown agent «${agent}». Expected: ${known}.`,
    unknown: "unknown",
    doctorBinary: (exec: string, entry: string) => `Binary: ${exec} (${entry})`,
    doctorVersion: (v: string) => `Version: ${v}`,
    doctorRuntimeNode: (v: string) => `Runtime: node ${v}`,
    doctorRuntimePackaged: (v: string) => `Runtime: packaged app (Node ${v})`,
    doctorLanguage: (l: string) => `Language: ${l}`,
    doctorDataDir: (p: string, existed: boolean, writable: boolean) => `Data folder: ${p} — ${existed ? "existed" : "created"}, ${writable ? "writable" : "not writable"}`,
    doctorConfig: (p: string, created: boolean) => `Config: ${p}${created ? " (created now)" : ""}`,
    doctorProviders: (n: number) => `Providers: ${n}`,
    jsonNotSupported: (cmd: string) => `The --json flag is not supported by the command ${cmd}.`,
    lineupsUsage: "Command lineups: without arguments — the list of lineups; save <name> --from-session <id> — saving.",
    lineupsSaveNeedsSession: "Command lineups save requires --from-session <id>.",
    sayArgs: "Command say takes two arguments: <id> and <text>.",
    oneArg: (cmd: string) => `Command ${cmd} takes exactly one argument: <id>.`,
    resumeFlag: (flag: string) => `the resume command does not change the lineup, framing, template and limits: the --${flag} flag is not accepted.`,
    roundsOnlyResume: "the --rounds flag is accepted only by the resume command.",
    replaceOnlyResume: "the --replace flag is accepted only by the resume command.",
    messageOnlyResume: "the --message flag is accepted only by the resume command.",
    messageRepeated: "the --message flag is given more than once: pass one owner message.",
    messageNeedsText: "the --message flag needs a non-empty owner message.",
    consensusNeedsMessage: (id: string) => `Add an owner message: council resume ${id} --message "<text>"`,
    urlFlagsOnlyRun: "the --url, --include, --no-ignore, --preview-materials and --prepared-materials flags are accepted only by a new start.",
    includeNoIgnore: "--include and --no-ignore are incompatible: without rules there is nothing to bring back.",
    includeNeedsPath: "--include: a path to an excluded file or folder is required.",
    includeNeedsAttach: "--include works only together with --attach: a path from an attached folder is brought back.",
    urlNeedsAddress: "--url: an http(s) address is required.",
    preparedNeedsId: "--prepared-materials: a set identifier is required.",
    preparedWithAttach: "--prepared-materials cannot be combined with --attach and --url: the set is already prepared.",
    preparedWithInclude: "--prepared-materials cannot be combined with --include and --no-ignore: the set is already prepared, bringing back is set in --preview-materials.",
    preparedWithChars: "--prepared-materials: the materials limit is taken from the set, --materials-chars is not accepted.",
    preparedWithPreview: "--prepared-materials and --preview-materials are incompatible: the set is already prepared.",
    previewNeedsInput: "--preview-materials: at least one --attach or --url is required.",
    previewFlag: (flag: string) => `--preview-materials only prepares materials: the --${flag} flag is not accepted.`,
    synthNeedsDrafts: "--synthesizer works only together with --drafts.",
    draftsOnlyRun: "the --drafts and --synthesizer flags are accepted only by a new start.",
    fromSessionOnlySave: "the --from-session flag is accepted only by the lineups save command.",
    lineupOnlyRun: "the --lineup flag is accepted only by a start.",
    lineupWithParticipant: "the --lineup and --participant flags are incompatible: the lineup sets all participants.",
    lineupNeedsId: "--lineup: a lineup identifier is required.",
    tokenFlagsOnlyRun: "the --max-tokens and --no-max-tokens flags are accepted only by a start and the resume command.",
    tokenFlagsConflict: "the --max-tokens and --no-max-tokens flags are incompatible.",
    waitFlagsOnlyRun: "the --pause-after-round, --wait-for-owner and --owner-wait-sec flags are accepted only by a start.",
    waitSecRange: (max: number) => `--owner-wait-sec: an integer from 1 to ${max} is required.`,
    waitSecNeedsMode: "the --owner-wait-sec flag requires --pause-after-round or --wait-for-owner.",
    replaceFormat: (raw: string) => `--replace: expected <pN>=<entry>, got «${raw}».`,
    topicRequired: "The topic is required: specify --topic.",
    templateNeedsId: "--template: a template identifier is required.",
    attachNeedsPath: "--attach: a path to a file or folder is required.",
    noParticipants: (config: string) => `There is nowhere to take participants from: the registry has no providers. Specify --participant or describe a provider in ${config}.`,
    templatesHint: (m: string) => `${m} List and load errors: council templates.`,
    // subcommands
    noProviders: (config: string) => `No providers: the claude and codex CLIs were not found. Install a CLI or describe a provider in ${config}.`,
    available: "available",
    unavailable: (reason: string) => `unavailable: ${reason}`,
    version: (v: string) => `version ${v}`,
    verified: (level: string, checkedAt: string | null) => `  verified: ${level}${checkedAt === null ? "" : `, ${checkedAt}`}`, // identical in en and ru: field name and values are not translated
    providerWarning: (w: string) => `  warning: ${w}`,
    key: (env: string, set: boolean) => `  key: ${env} — ${set ? "set" : "not set"}`,
    keyNotRequired: "  key: not required",
    models: (list: string) => `  models: ${list}`,
    modelsManual: (id: string) => `the list was not received — the model is specified manually: ${id}:<model>`,
    modelsUnconfirmed: (reason: string) => `  model list not confirmed: ${reason}`,
    userSource: "user",
    builtinSource: "built-in",
    noTemplates: "No templates.",
    loadErrors: "Load errors:",
    noLineups: "No lineups.",
    sessionNotFoundOrDamaged: (id: string) => `Session ${id} not found or its journal is corrupted.`,
    lineupSaved: (id: string, name: string, n: number) => `Lineup ${id} «${name}» saved: participants ${n}.`,
    lineupRun: (id: string) => `Start: council --topic "<topic>" --lineup ${id}`,
    noSessions: "No sessions.",
    sessionNotFound: (id: string) => `Session ${id} not found.`,
    stopRequested: (id: string) => `Stop of session ${id} requested.`,
    requestWriteFailed: (m: string) => `Error: could not write the request — ${m}`,
    continueRequested: (id: string, waitId: string) => `Continuation of session ${id} requested: wait ${waitId} will be released.`,
    messageWriteFailed: (m: string) => `Error: could not write the message — ${m}`,
    messageRequested: (id: string) => `Message for session ${id} requested: participants will see it from the next turn.`,
    answerRequested: (qid: string, id: string) => `Answer to question ${qid} for session ${id} requested: participants will see it from the next turn.`,
    // continuation
    resumePlan: (id: string, added: number, max: number, calls: number, active: number, drafts: number) =>
      `Continuation of session ${id}: ${added} more rounds (total limit ${max}), no more than ${calls} model calls (active participants ${active} × ${added} × 3${drafts > 0 ? ` + remaining draft calls ${drafts}` : ""}).`,
    replacementWhyUnavailable: (r: string) => `unavailable: ${r}`,
    replacementWhyDropped: (r: string) => `dropped out: ${r}`,
    replacement: (oldId: string, oldName: string, newId: string, newName: string, provider: string, model: string, why: string) => `Replacement: ${oldId} «${oldName}» → ${newId} «${newName}» (${provider}:${model}) — reason: ${why}`,
    agreementsReset: "Agreements reset: all active participants confirm the current version again.",
    activeLineup: (list: string) => `Active lineup: ${list}.`,
    waitContinues: (waitId: string, deadline: string, id: string) => `Owner wait ${waitId} continues until ${deadline}: council continue ${id} or an answer will release it earlier.`,
    waitExpiredResume: (waitId: string) => `Owner wait ${waitId} has expired: the discussion will continue right away.`,
    tokenCapResume: (cap: string, spent: number) => `Token cap: ${cap}, already spent ${spent}`,
    noCap: "no cap",
    droppedRequests: (n: number, id: string) => `Unapplied owner messages removed: ${n}. Send them again with council say ${id} "<text>":`,
    // launch
    lineup: (name: string, id: string) => `Lineup: «${name}» (${id})`,
    lineupNotFound: (id: string) => `Lineup «${id}» not found. List: council lineups.`,
    lineupUnavailable: (name: string) => `Error: lineup «${name}» is unavailable:`,
    providerWarn: (id: string, w: string) => `Warning: provider «${id}»: ${w}`,
    positionWarn: (n: number, provider: string, model: string, note: string) => `Warning: position ${n} (${provider}:${model}): ${note}`,
    scenarioNotFound: (path: string) => `Scenario file «${path}» not found.`,
    providerUnavailable: (id: string, reason: string) => `Error: provider «${id}» is unavailable: ${reason}`,
    capLine: (cap: number, fromRegistry: boolean) => `Token cap: ${cap}${fromRegistry ? " (from the registry)" : ""}`,
    capNone: "Token cap: no cap",
    draftsExperiment: (synth: string, name: string, byDefault: boolean, calls: number, n: number, rounds: number) =>
      `"Independent drafts" experiment: synthesizer ${synth} «${name}»${byDefault ? " (by default — the first participant)" : ""}, no more than ${calls} model calls (participants ${n} × (rounds ${rounds} + 1) × 3).`,
    waitModePause: "pause after every round",
    waitModeAnswer: "answer to a question to the owner",
    ownerWait: (modes: string, sec: number) => `Owner wait: ${modes}, period ${sec} s. When it expires the discussion will continue on its own within the round limit.`,
  },
  ru: {
    help: `Использование:
  council --topic <текст> --participant <участник> --participant <участник> …
          [--max-rounds <n>] [--framing <текст>] [--turn-timeout <сек>] [--context-chars <n>]
          [--template <id>] [--attach <путь>]… [--include <путь>]… [--no-ignore] [--url <адрес>]… [--materials-chars <n>]
          [--preview-materials] [--prepared-materials <id>]
          [--max-tokens <n> | --no-max-tokens]
          [--pause-after-round] [--wait-for-owner] [--owner-wait-sec <N>] [--lineup <id>]
          [--drafts [--synthesizer <pN>]]
  council --preview-materials [--attach <путь>]… [--include <путь>]… [--no-ignore] [--url <адрес>]… [--materials-chars <n>]
  council providers [--json]
  council templates [--json]
  council lineups [--json]
  council lineups save <название> --from-session <id>
  council list [--json]
  council show <id> [--json]
  council stop <id>
  council say <id> [--answer <qN>] <текст>
  council status <id> [--json]
  council continue <id>
  council resume <id> [--rounds <n>] [--max-tokens <n> | --no-max-tokens] [--replace <pN>=<запись>]… [--message <текст>]
  council doctor [--json]
  council cli install <agent> [--version <X>] [--candidate]
  council cli list
  council cli use <agent> <version>
  council cli rollback <agent>
  council cli candidates [--agent <agent>] [--json]
  council cli accept <agent> <version> [--candidate] [--model <id>] [--max-calls <N>] [--save-fixture <папка>]
  council home
  council --help

Подкоманды:
  providers  провайдеры из config.json: доступность, версия, путь или адрес, ключ, модели
  templates  шаблоны обсуждений: идентификатор, категория, название, источник; отдельно — ошибки загрузки
  lineups    список именованных составов участников
  lineups save <название> --from-session <id>  сохранить состав участников сессии под названием
  list       список сессий, от новых к старым
  show <id>  ход и состояние сессии; выбор владельца, если он сделан в приложении
  stop <id>  запросить остановку идущей сессии (из другого терминала)
  say <id> [--answer <qN>] <текст>  отправить реплику владельца идущей сессии или ответить на вопрос участника (из другого терминала)
  status <id>  состояние сессии и текущее ожидание владельца
  continue <id>  снять текущее ожидание владельца у идущей сессии (из другого терминала)
  resume <id>  продолжить сохранённую сессию (interrupted, no_consensus, stopped; consensus — только с --message; failed — только при сбое «меньше двух активных участников» и с --replace)
  doctor     диагностика: бинарь, версия, рантайм, папка данных, конфиг, провайдеры; без вызовов моделей
  cli install <agent> [--version <X>] [--candidate]  установить закреплённый claude или codex в папку данных (нужны npm и сеть; по умолчанию новейшая проверенная версия; --candidate не делает её активной)
  cli list   закреплённые установки, активная и предыдущая версии
  cli use <agent> <version>  сделать активной установленную проверенную версию
  cli rollback <agent>  вернуться к предыдущей активной версии (один шаг)
  cli accept <agent> <version> [--candidate] [--model <id>] [--max-calls <N>] [--save-fixture <папка>]  проверить установленную версию реальными пробами; без --max-calls печатаются только план и точная граница вызовов модели, вызовов не делается; версия записывается как real, только если пройдены все пробы; --save-fixture сохраняет обезличенный валидный ход в папку
  home       путь папки данных

Флаги:
  --topic <текст>          тема обсуждения (обязательно)
  --participant <запись>   участник; повторяется, порядок задаёт очередь (нужно не меньше 2);
                           не указан — участники по умолчанию из config.json
  --max-rounds <n>         лимит кругов, целое не меньше 1 (по умолчанию из шаблона, иначе из config.json)
  --framing <текст>        рамка обсуждения (по умолчанию — рамка шаблона, без шаблона — нейтральная рамка)
  --turn-timeout <сек>     таймаут хода в секундах, целое от 1 до ${MAX_TURN_TIMEOUT_SEC} (по умолчанию из шаблона, иначе из config.json)
  --context-chars <n>      размер контекста в символах, целое не меньше 1 (по умолчанию из шаблона, иначе из config.json)
  --attach <путь>          файл или папка с материалами; большая папка сохраняется снимком; повторяется (см. «Материалы»)
  --include <путь>         вернуть в набор файл или папку, исключённые правилами .gitignore приложенной папки; повторяется (см. «Материалы»)
  --no-ignore              не применять правила .gitignore приложенных папок; с --include несовместим
  --materials-chars <n>    лимит исходного набора материалов, входящего в каждый запрос, в символах, целое не меньше 1 (по умолчанию defaults.materialsChars из config.json)
  --url <адрес>            публичная ссылка http(s) как материал; повторяется (см. «Ссылки»)
  --preview-materials      только подготовить и показать материалы, без сессии и вызовов моделей
  --prepared-materials <id>  запуск с набором, показанным предпросмотром
  --template <id>          шаблон обсуждения: рамка, роли участников по порядку и лимиты по умолчанию; список — council templates
  --lineup <id>            состав вместо --participant; с --participant несовместим; список — council lineups
  --from-session <id>      только для lineups save: сессия, участники которой сохраняются в состав
  --drafts                 эксперимент «независимые черновики»: каждый участник сначала пишет свой вариант, не видя чужих (см. «Независимые черновики»)
  --synthesizer <pN>       только с --drafts: участник, который начинает обычное обсуждение (по умолчанию p1, первый участник)
  --max-tokens <n>         потолок токенов сессии (сумма входных и выходных токенов всех вызовов моделей), целое не меньше 1
                           (без флага — defaults.maxTotalTokens из config.json, если задан); для resume — новый потолок
  --no-max-tokens          без потолка токенов (отключает и значение из config.json); для resume — снять потолок; с --max-tokens несовместим
  --pause-after-round      после каждого круга без итога ждать владельца (см. «Ожидание владельца»)
  --wait-for-owner         ждать ответа на вопрос владельцу перед ближайшим следующим ходом
  --owner-wait-sec <N>     срок ожидания в секундах, целое от 1 до 86400 (по умолчанию 300); требует один из двух режимов выше
  --answer <qN>            только для say: реплика отвечает на вопрос qN, адресованный владельцу
  --rounds <n>             только для resume: сколько ещё кругов пройти, считая незавершённый, целое не меньше 1
                           (без флага — остаток прежнего лимита)
  --replace <pN>=<запись>  только для resume, повторяется: заменить выбывшего или недоступного участника pN; запись как у --participant;
                           новый участник получает следующий идентификатор, место и роль прежнего, согласия сбрасываются
  --message <текст>        только для resume: реплика владельца, записанная до первого хода продолжения; сбрасывает согласия;
                           обязательна для сессии с согласием (consensus)
  --json                   напечатать в stdout один JSON-документ (status, list, show, providers, templates, lineups, doctor)
  --help                   эта справка

Запись участника: [имя=]<провайдер>[:<модель>]
  Провайдер — идентификатор из config.json (по умолчанию claude, codex); модель не указана — модель по умолчанию CLI.
  Для провайдера вида openai-http модель обязательна, двоеточия в её имени допустимы: openrouter:vendor/model:free
  Примеры: claude · codex:<модель> · Аня=claude:haiku · scripted:<путь к файлу сценария>
  Имя по умолчанию: название провайдера (с моделью, если она указана); для scripted — «Участник N».
  Участники scripted доступны только при COUNCIL_DEV=1.

config.json создаётся в папке данных при первом запуске по найденным CLI (claude, codex) и не перезаписывается.

Материалы: файлы и папки из --attach движок читает один раз перед стартом, исходный набор входит в запрос каждого хода; у участников нет инструментов и доступа к диску, файлы из снимка отдаёт движок. В папке скрытые имена, имена из defaults.materialsIgnore в config.json (изначально node_modules, dist, build), нетекстовые файлы и символические ссылки пропускаются с указанием причины. Файлы .gitignore внутри приложенной папки (корневой и вложенные) действуют как в git, включая отрицание «!»: исключённые ими пути не входят ни в исходный набор, ни в снимок, ни в перечень папки и печатаются в сводке разделом «Исключено правилами» — папка целиком одной строкой, с правилом. Правила выше приложенной папки и общие настройки git не читаются; явно указанный в --attach файл правилами не исключается. --include <путь> возвращает исключённый файл или папку (папку — целиком): путь файловой системы либо имя, как оно напечатано в разделе; путь, который правила не исключали, отклоняет запуск. --no-ignore отключает правила целиком. Старт отклоняется, если путь не найден или не читается, явно указанный файл нетекстовый или является символической ссылкой, либо попался любой файл .env или .env.*. Из PDF берётся текстовый слой (на файл не больше ${PDF_LIMITS.bytes / MIB} МиБ, ${PDF_LIMITS.pages} страниц, ${PDF_LIMITS.ms / 1000} секунд, ${PDF_LIMITS.rssBytes / MIB} МиБ памяти и ${PDF_LIMITS.chars} знаков); зашифрованный, повреждённый PDF и PDF без текстового слоя отклоняются как явно указанные и пропускаются с причиной в папке, распознавание изображений не выполняется. Лимит --materials-chars (по умолчанию defaults.materialsChars, изначально 60000) считает символы текста (единицы UTF-16, как --context-chars); явно указанные файлы никогда не обрезаются, их превышение лимита отклоняет старт. Папка сохраняется в сессии целиком как снимок со своей границей 20000000 символов (больше — отказ). Если папка больше лимита, в исходный набор берутся описания (md, markdown, mdx, txt, rst, adoc, pdf) ближе к корню, а при их отсутствии — файлы ближе к корню, пока они помещаются; остальные файлы участники читают из снимка по запросу (до 5 имён и 40000 знаков за запрос, не более 3 вызовов на ход). Исходная папка после старта не читается, resume использует снимок.

Ссылки: загружается только адрес, названный в --url (ссылки из темы и материалов не загружаются); принимаются только публичные адреса http и https без логина и пароля, внутренние адреса и перенаправления на них отклоняются; не больше ${URL_LIMITS.ms / 1000} секунд, ${URL_LIMITS.redirects} перенаправлений и ${URL_LIMITS.bytes / MIB} МиБ на ссылку; принимаются text/plain, text/markdown и text/html в UTF-8, из HTML берётся текст без скриптов, стилей и скрытых элементов, JavaScript не исполняется. Текст сохраняется снимком, при ходах и resume сеть не используется; в снимке остаются схема, имя сайта и путь, параметры запроса не сохраняются и не печатаются. --preview-materials показывает полный текст и выдаёт идентификатор набора на 24 часа для --prepared-materials; отказ любой ссылки — код 2 без сессии.

Реплика владельца: say ставит текст в очередь идущей сессии, движок применяет его после текущего хода, идущий ход не прерывается. Все, кто был согласен, должны высказаться заново: для согласия нужно новое согласие каждого действующего участника. Участники видят все реплики в каждом следующем запросе и знают, что реплика владельца главнее мнений участников. Завершённая, прерванная или неизвестная сессия реплику отклоняет. Текст, начинающийся с дефиса, указывается после --: council say <id> -- "-текст".

Вопросы владельцу: участник может адресовать вопрос владельцу — в выводе это строка «Вопрос владельцу» с идентификатором qN. Ответ: council say <id> --answer <qN> <текст>. Ответ — это реплика владельца: она сбрасывает согласных, а вопрос закрывается как отвеченный. Без --wait-for-owner обсуждение ответа не ждёт: вопрос без ответа закрывается перед следующим ходом задавшего участника, и участники решают сами. Неизвестный, адресованный участнику или уже закрытый вопрос ответ отклоняет.

Ожидание владельца: --pause-after-round останавливает обсуждение после каждого круга без итога, --wait-for-owner — перед ближайшим ходом, пока вопрос владельцу без ответа. Срок задаёт --owner-wait-sec (по умолчанию 300 с); по истечении срока обсуждение продолжается само в пределах лимита кругов. Обычная реплика (say) паузу не снимает, ответ на вопрос (say --answer) снимает вопрос, continue снимает ожидание целиком и закрывает неотвеченные вопросы без ответа. continue не запускает новых участников и не добавляет кругов, в отличие от resume. Во время ожидания модели не вызываются; статус сессии остаётся «идёт»; состояние — council status <id>.

Продолжение: resume продолжает сессию со статусом interrupted, no_consensus или stopped с того же места; тема, рамка, шаблон и лимиты не меняются, остальные флаги запуска не принимаются. Состав меняется только флагом --replace <pN>=<запись>: прежний участник сохраняет идентификатор и историю, новый получает следующий идентификатор, место и роль прежнего, все согласия сбрасываются и каждый действующий участник подтверждает версию заново. Сессия со статусом consensus продолжается только с репликой владельца (--message <текст>): она записывается до первого хода продолжения, сбрасывает согласия, и каждый действующий участник высказывается заново. Сессия со статусом failed продолжается только при сбое «меньше двух активных участников» и только с заменой, после которой активных не меньше двух. Отказ (сессия не найдена, идёт, согласие достигнуто, иной сбой, нет остатка кругов, недоступный провайдер, снимок материала, неверная замена: повтор или неизвестный pN, доступный действующий участник, недоступный новый участник, превышение числа участников) даёт причину и код 2.

Независимые черновики (эксперимент): выключены по умолчанию. С --drafts каждый участник сначала пишет свой вариант решения, не видя чужих; затем обычное обсуждение начинает синтезатор (по умолчанию первый участник). Граница вызовов моделей — участники × (круги + 1) × 3. Черновики не считаются согласием. Все черновики целиком передаются в каждый обычный ход и должны помещаться в --context-chars, иначе сессия завершается сбоем до обсуждения. Пользу режима для качества решения проверяйте сами — она не доказана.

Потолок токенов: считается по сумме входных и выходных токенов всех вызовов моделей сессии, которые их сообщили, включая неудачные попытки, запросы файлов и черновики (вызовы без данных в сумму не входят, учёт помечается неполным). Проверяется между ходами и может быть превышен на один ход: идущий ход не обрывается. Достигнутый потолок останавливает сессию со статусом stopped и причиной token_cap, код 4; если ход, превысивший потолок, дал согласие всех, важнее согласие (consensus). После каждого хода печатается строка «Расход». Продолжение сессии, остановленной потолком, требует --max-tokens больше уже израсходованного или --no-max-tokens.

Шаблоны — файлы JSON: встроенные и пользовательские из папки templates/ папки данных; пользовательский с идентификатором встроенного перекрывает его. Нейтральная рамка для темы без шаблона — файл neutral.md там же. Шаблоны можно создавать и править в приложении (раздел «Новое»: редактор шаблона и «Сохранить как шаблон» в настройке сессии); новых команд для этого в council нет; лимит кругов шаблона может быть больше 20, тогда как форма запуска в приложении принимает от 1 до 20.

Составы: именованные составы участников хранятся в lineups.json папки данных отдельно от шаблонов (идентификатор, название, упорядоченные провайдер, модель и роль), без ключей и темы; сохраняются только явной командой lineups save из участников сессии; название — одна строка до 100 знаков, повтор названия отклоняется. Запуск по составу (--lineup) берёт участников, модели, роли и порядок из состава, а рамку и лимиты — из шаблона и флагов; роли шаблона при этом не подставляются. Перед запуском состав проверяется по текущему реестру: исчезнувший или недоступный провайдер отклоняет запуск с кодом 2, модель, которой нет в текущем перечне, даёт предупреждение; подмены нет. Сценарные участники в составе доступны только при COUNCIL_DEV=1.

Ключи HTTP-провайдеров берутся из переменных окружения; окружение дополняется из .env папки данных и .env текущей папки (переменная окружения главнее файла).

Данные: папка \`model-council\` в системной папке приложений; переопределяется переменной COUNCIL_HOME.
history-pins.json в ней — закрепления экрана «История» приложения; команда council его не читает.

Язык: переменная COUNCIL_LANG (en или ru), затем настройка языка в приложении (preferences.json папки данных), по умолчанию English.

Коды возврата:
  0  consensus
  1  внутренняя ошибка
  2  ошибка аргументов, неизвестная сессия, отклонённая остановка, отклонённая реплика, отклонённое снятие ожидания, ошибка в config.json, недоступный провайдер, неизвестный шаблон, неизвестный или недоступный состав, отказ сохранения состава, отказ материалов, отказ ссылки или набора, отказ продолжения
  3  no_consensus
  4  stopped
  5  failed

Пример:
  COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council --topic "Как назвать кота" ${EXAMPLE_P}
  COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council --topic "Что улучшить в формате шаблонов" --attach docs/templates.md ${EXAMPLE_P}`,
    error: (m: string) => `Ошибка: ${m}`,
    internalError: (m: string) => `Внутренняя ошибка: ${m}`,
    warning: (m: string) => `Предупреждение: ${m}`,
    intRange: (flag: string, min: number, max: number) => `${flag}: нужно целое число от ${min} до ${max}.`,
    intRequired: (flag: string) => `${flag}: нужно целое число не меньше 1.`,
    badEntry: (raw: string) => `Неверная запись участника «${raw}»: ожидается [имя=]<провайдер>[:<модель>].`,
    scriptedNeedsPath: (raw: string) => `Неверная запись участника «${raw}»: для scripted нужен путь — scripted:<путь>.`,
    noProvidersWord: "провайдеров нет",
    unknownProvider: (id: string, known: string) => `Неизвестный провайдер «${id}»: в реестре есть ${known}; сценарный участник — scripted:<путь>.`,
    httpNeedsModel: (raw: string, id: string) => `Неверная запись участника «${raw}»: для провайдера «${id}» нужна модель — ${id}:<модель>.`,
    modelNoColons: (raw: string) => `Неверная запись участника «${raw}»: имя модели не содержит двоеточий.`,
    includeAmbiguous: (g: string) => `--include «${g}»: название подходит к нескольким приложенным папкам, укажите абсолютный путь.`,
    materials: (n: number, total: number, limit: number) => `Материалы: ${n}, объём ${total} символов (лимит ${limit}).`,
    folderSnapshot: (files: number, chars: number, bound: number) => `Снимок папки: файлов ${files}, объём ${chars} знаков (граница ${bound}).`,
    leftOut: (n: number) => `Не вошло в исходный набор: ${n} (участники читают по запросу)`,
    andMore: (n: number) => `  … и ещё ${n}`,
    excludedByRules: (n: number) => `Исключено правилами: ${n}`,
    skipped: (n: number) => `Пропущено: ${n}`,
    linkSources: (n: number) => `Источники ссылок: ${n}`,
    linkSourcesUnreadable: (file: string) => `Источники ссылок: не удалось прочитать ${file}`,
    materialsRejected: (reasons: string) => `Материалы не приняты:\n${reasons}`,
    preparedNotCreated: (m: string) => `Подготовленный набор не создан: ${m}`,
    preparedNotAccepted: (m: string) => `Подготовленный набор не принят: ${m}`,
    preparedSet: (id: string) => `Подготовленный набор: ${id}`,
    preparedSaved: (id: string) => `Подготовленный набор: ${id} (действует 24 часа; вызовов моделей не было)`,
    preparedRun: (id: string) => `Запуск: council --topic "<тема>" --participant <участник> --participant <участник> --prepared-materials ${id}`,
    spendNoTokens: (cap: number | undefined) => `Расход: участники не сообщают токены, учёт неполный${cap !== undefined ? `; потолок ${cap} не проверяется` : ""}`,
    spendIncompleteNote: " (учёт неполный: не все ходы сообщили токены)",
    spendOfCap: (total: number, cap: number, note: string) => `Расход: израсходовано ${total} из ${cap} токенов${note}`,
    spendNoCap: (total: number, note: string) => `Расход: ${total} токенов, потолка нет${note}`,
    filesRead: (list: string) => `Прочитано из папки: ${list}`,
    fileChars: (chars: number) => `${chars} знаков`,
    fileCharsOf: (shown: number, chars: number) => `${shown} из ${chars} знаков`,
    sessionHeader: (id: string, n: number, rounds: number) => `Сессия ${id} · участников: ${n} · лимит кругов: ${rounds}`,
    topic: (t: string) => `Тема: ${t}`,
    template: (id: string) => `Шаблон: ${id}`,
    toVersion: (v: number) => ` → версия ${v}`,
    normalized: " (agree с вопросами засчитано как object)",
    turn: (turn: number, round: number, pid: string, name: string, stance: string, notes: string) => `── Ход ${turn} · круг ${round} · ${pid} «${name}» · ${stance}${notes}`,
    reasoning: (r: string) => `Аргументы: ${r}`,
    answers: "Ответы:",
    questions: "Вопросы:",
    ownerQuestion: (qid: string, pid: string, name: string, text: string) => `Вопрос владельцу · ${qid} · ${pid} «${name}»: ${text}`,
    answerHint: (id: string, qid: string) => `  ответить: council say ${id} --answer ${qid} "<текст>"`,
    continueHint: (id: string) => `  продолжить: council continue ${id}`,
    turnFailed: (turn: number, pid: string, name: string, attempt: number, kind: string, m: string) => `✗ Ход ${turn} · ${pid} «${name}» · попытка ${attempt} · ${kind}: ${m}`,
    draft: (pid: string, name: string, attempts: number, chars: number) => `── Черновик ${pid} «${name}» · попыток ${attempts} · ${chars} знаков`,
    rationale: (r: string) => `Обоснование: ${r}`,
    draftTextLabel: "Текст:",
    draftTextUnavailable: "(текст черновика недоступен)",
    draftFailed: (pid: string, name: string, attempt: number, kind: string, m: string) => `✗ Черновик ${pid} «${name}» · попытка ${attempt} · ${kind}: ${m}`,
    draftsFinished: (done: number, total: number, synth: string, name: string) => `── Черновики готовы: ${done} из ${total}. Обычное обсуждение начинает синтезатор ${synth} «${name}».`,
    dropped: (pid: string, name: string, reason: string) => `✗ ${pid} «${name}» выбыл: ${reason}`,
    resumedCapRemoved: ", потолок снят",
    resumedCap: (n: number) => `, потолок токенов ${n}`,
    resumed: (rounds: number, cap: string) => `— Продолжено: общий лимит кругов ${rounds}${cap} —`,
    replacementLine: (oldId: string, newId: string, name: string) => `  замена: ${oldId} → ${newId} «${name}»`,
    ownerMessage: (id: string, after: number, answers: string) => `── Владелец · ${id} · после хода ${after}${answers ? ` · ответ на ${answers}` : ""}`,
    ownerSelected: (v: number, status: string) => `── Владелец выбрал версию ${v} · исход на момент выбора: ${status}`,
    note: (n: string) => `Заметка: ${n}`,
    waitStarted: (waitId: string, reasons: string, deadline: string) => `⏸ Ожидание владельца ${waitId} · ${reasons} · до ${deadline}`,
    waitUpdated: (waitId: string, reasons: string) => `  ожидание ${waitId}: остаётся — ${reasons}`,
    waitFinished: (waitId: string, how: string) => `▶ Ожидание ${waitId} снято: ${how}`,
    questionUnanswered: (qid: string) => `  вопрос ${qid} остался без ответа`,
    waitRoundBoundary: "пауза после круга",
    waitQuestion: (ids: string) => `вопрос владельцу${ids ? ` (${ids})` : ""}`,
    waitContinued: "владелец продолжил",
    waitAnswered: "получен ответ",
    waitExpired: "срок истёк, обсуждение продолжается само",
    waitStopped: "остановка",
    summary: (status: string) => `══ Итог: ${status}`,
    reason: (r: string) => `Причина: ${r}`,
    reasonCoded: (code: string, text: string) => `Причина: ${code} (${text})`,
    tokenCapCode: "потолок токенов",
    tokenCapReason: (total: number, cap: number | undefined) => `Причина: потолок токенов — израсходовано ${total} из ${cap}`,
    synthUnavailable: (synth: string, name: string) => `синтезатор ${synth} «${name}» выбыл, не создав версию 1; замены нет — запустите новую сессию с другим синтезатором (--synthesizer).`,
    draftsTooLong: (chars: number, limit: number | undefined) => `черновики не помещаются в лимит контекста (${chars} знаков из ${limit} допустимых по --context-chars); общее обсуждение не начато.`,
    canReplace: (id: string) => `Сессию можно продолжить с заменой выбывшего участника: council resume ${id} --replace <pN>=<провайдер>:<модель>`,
    tokensIncomplete: (cap: number) => `Учёт токенов неполный: потолок ${cap} мог не сработать`,
    versionBy: (v: number, author: string) => `Версия ${v}, автор ${author}`,
    agreed: (list: string) => `Согласны: ${list}`,
    none: "нет",
    objectors: "Возражают:",
    silent: "не высказался",
    decision: "Решение:",
    noDecision: "Решения нет.",
    running: "идёт",
    undetermined: "состояние не определено",
    updateAdvice: "Обновите приложение, чтобы прочитать сессию целиком.",
    statusLine: (id: string, label: string) => `Сессия ${id}: ${label}`,
    roundOf: (round: number, max: number, turns: number) => `Круг ${round} из ${max}, ходов: ${turns}`,
    draftsPhase: (done: number, total: number, synth: string) => `Фаза независимых черновиков: принято ${done} из ${total}, синтезатор ${synth}`,
    noWait: "Ожидания владельца нет.",
    waitLine: (waitId: string, reasons: string) => `Ожидание владельца ${waitId}: ${reasons}`,
    questionNotFound: "вопрос не найден",
    deadline: (deadline: string, left: number) => `Срок: ${deadline}, ${left > 0 ? `осталось ${left} с` : "истёк"}`,
    executorDown: (id: string) => `Исполнитель не работает: ожидание продолжится после council resume ${id}.`,
    showStatus: (label: string) => `Статус: ${label}`,
    currentVersion: (v: number, author: string) => `Текущая версия ${v}, автор ${author}:`,
    waitUntil: (waitId: string, reasons: string, deadline: string) => `Ожидание владельца ${waitId}: ${reasons} · до ${deadline}`,
    draftsRunning: (done: number, total: number) => `Идёт фаза независимых черновиков: принято ${done} из ${total}.`,
    currentTurn: (turn: number, round: number, pid: string) => `Сейчас ход ${turn} · круг ${round} · ${pid}`,
    ownerChoice: (v: number) => `══ Выбор владельца: версия ${v} (не согласие моделей)`,
    chosenAt: (ts: string, status: string) => `Выбрано: ${ts}, исход на момент выбора: ${status}`,
    versionText: (v: number) => `Текст версии ${v}:`,
    totals: (turns: number, drafts: string, sec: string) => `Всего: ходов ${turns}${drafts}, длительность ${sec} с`,
    totalsDrafts: (n: number) => `, черновиков ${n}`,
    totalsTokens: (i: string, o: string) => `, токены ${i} / ${o}`,
    totalsCost: (usd: string) => `, стоимость $${usd}`,
    totalsCap: (cap: number) => `, потолок ${cap}`,
    totalsIncomplete: " (учёт расхода неполный)",
    answerOnlySay: "Флаг --answer относится только к команде say.",
    unknownCommand: (cmd: string) => `Неизвестная команда «${cmd}».`,
    launchBadId: (id: string) => `Файл запуска: недопустимый идентификатор сессии «${id}».`,
    launchMissing: (path: string) => `Файл запуска не найден: ${path}.`,
    launchUnreadable: (path: string, reason: string) => `Файл запуска не читается (${path}): ${reason}.`,
    launchDamaged: (path: string) => `Файл запуска повреждён (не JSON): ${path}.`,
    launchInvalid: (path: string, reason: string) => `Файл запуска имеет неожиданное содержимое (${path}): ${reason}.`,
    launchExpired: (deadline: string) => `Файл запуска устарел: срок ${deadline} прошёл.`,
    launchUsage: "council run-prepared <launch-file>",
    noArgs: (cmd: string) => `Команда ${cmd} не принимает аргументов.`,
    cliUsage: "Команда cli: install <agent> [--version <X>] [--candidate] | list | use <agent> <version> | rollback <agent> | candidates [--agent <agent>] [--json] | accept <agent> <version> [--candidate] [--model <id>] [--max-calls <N>] [--save-fixture <папка>].",
    cliUnknownSub: (sub: string) => `Неизвестная подкоманда cli «${sub}». Ожидается: install, list, use, rollback, candidates, accept.`,
    cliWrongArgs: (sub: string, usage: string) => `Команда cli ${sub} принимает: ${usage}.`,
    cliFlagNotAllowed: (flag: string, sub: string) => `Флаг ${flag} не допускается у cli ${sub}.`,
    cliFlagOnlyCli: (flag: string) => `Флаг ${flag} относится только к команде cli install.`,
    cliFlagOnlyInstallAccept: (flag: string) => `Флаг ${flag} относится только к командам cli install и cli accept.`,
    cliFlagOnlyAccept: (flag: string) => `Флаг ${flag} относится только к команде cli accept.`,
    maxCallsRange: (value: string) => `--max-calls должен быть целым числом не меньше 1, получено «${value}».`,
    flagNeedsValue: (flag: string) => `Флаг ${flag} требует значение.`,
    agentOnlyCandidates: "Флаг --agent применяется только у команды cli candidates.",
    candidatesInterrupted: "Проверка прервана; временные установки удалены, ничего не записано.",
    candidatesHeader: (agent: string, base: string) => `${agent} (база ${base})`,
    candidatesNone: "версий новее нет",
    candidatesFits: "подходит",
    candidatesViolates: "нарушает контракт",
    candidatesAlreadyRecorded: "уже записана",
    candidatesNotRecorded: "не записана",
    cliUnknownAgent: (agent: string, known: string) => `Неизвестный агент «${agent}». Ожидается: ${known}.`,
    unknown: "неизвестно",
    doctorBinary: (exec: string, entry: string) => `Бинарь: ${exec} (${entry})`,
    doctorVersion: (v: string) => `Версия: ${v}`,
    doctorRuntimeNode: (v: string) => `Рантайм: node ${v}`,
    doctorRuntimePackaged: (v: string) => `Рантайм: упакованное приложение (Node ${v})`,
    doctorLanguage: (l: string) => `Язык: ${l}`,
    doctorDataDir: (p: string, existed: boolean, writable: boolean) => `Папка данных: ${p} — ${existed ? "существовала" : "создана"}, ${writable ? "доступна для записи" : "недоступна для записи"}`,
    doctorConfig: (p: string, created: boolean) => `Конфиг: ${p}${created ? " (создан сейчас)" : ""}`,
    doctorProviders: (n: number) => `Провайдеров: ${n}`,
    jsonNotSupported: (cmd: string) => `Флаг --json не поддерживается командой ${cmd}.`,
    lineupsUsage: "Команда lineups: без аргументов — список составов; save <название> --from-session <id> — сохранение.",
    lineupsSaveNeedsSession: "Команда lineups save требует --from-session <id>.",
    sayArgs: "Команда say принимает два аргумента: <id> и <текст>.",
    oneArg: (cmd: string) => `Команда ${cmd} принимает ровно один аргумент: <id>.`,
    resumeFlag: (flag: string) => `команда resume не меняет состав, рамку, шаблон и лимиты: флаг --${flag} не принимается.`,
    roundsOnlyResume: "флаг --rounds принимается только командой resume.",
    replaceOnlyResume: "флаг --replace принимается только командой resume.",
    messageOnlyResume: "флаг --message принимается только командой resume.",
    messageRepeated: "флаг --message указан больше одного раза: передайте одну реплику владельца.",
    messageNeedsText: "флагу --message нужна непустая реплика владельца.",
    consensusNeedsMessage: (id: string) => `Добавьте реплику владельца: council resume ${id} --message "<текст>"`,
    urlFlagsOnlyRun: "флаги --url, --include, --no-ignore, --preview-materials и --prepared-materials принимаются только новым запуском.",
    includeNoIgnore: "--include и --no-ignore несовместимы: без правил возвращать нечего.",
    includeNeedsPath: "--include: нужен путь к исключённому файлу или папке.",
    includeNeedsAttach: "--include работает только вместе с --attach: возвращается путь из приложенной папки.",
    urlNeedsAddress: "--url: нужен адрес http(s).",
    preparedNeedsId: "--prepared-materials: нужен идентификатор набора.",
    preparedWithAttach: "--prepared-materials нельзя совмещать с --attach и --url: набор уже подготовлен.",
    preparedWithInclude: "--prepared-materials нельзя совмещать с --include и --no-ignore: набор уже подготовлен, возврат задаётся в --preview-materials.",
    preparedWithChars: "--prepared-materials: лимит материалов взят из набора, --materials-chars не принимается.",
    preparedWithPreview: "--prepared-materials и --preview-materials несовместимы: набор уже подготовлен.",
    previewNeedsInput: "--preview-materials: нужен хотя бы один --attach или --url.",
    previewFlag: (flag: string) => `--preview-materials только готовит материалы: флаг --${flag} не принимается.`,
    synthNeedsDrafts: "--synthesizer работает только вместе с --drafts.",
    draftsOnlyRun: "флаги --drafts и --synthesizer принимаются только новым запуском.",
    fromSessionOnlySave: "флаг --from-session принимается только командой lineups save.",
    lineupOnlyRun: "флаг --lineup принимается только запуском.",
    lineupWithParticipant: "флаги --lineup и --participant несовместимы: состав задаёт участников целиком.",
    lineupNeedsId: "--lineup: нужен идентификатор состава.",
    tokenFlagsOnlyRun: "флаги --max-tokens и --no-max-tokens принимаются только запуском и командой resume.",
    tokenFlagsConflict: "флаги --max-tokens и --no-max-tokens несовместимы.",
    waitFlagsOnlyRun: "флаги --pause-after-round, --wait-for-owner и --owner-wait-sec принимаются только запуском.",
    waitSecRange: (max: number) => `--owner-wait-sec: нужно целое число от 1 до ${max}.`,
    waitSecNeedsMode: "флаг --owner-wait-sec требует --pause-after-round или --wait-for-owner.",
    replaceFormat: (raw: string) => `--replace: ожидается <pN>=<запись>, получено «${raw}».`,
    topicRequired: "Тема обязательна: укажите --topic.",
    templateNeedsId: "--template: нужен идентификатор шаблона.",
    attachNeedsPath: "--attach: нужен путь к файлу или папке.",
    noParticipants: (config: string) => `Участников взять неоткуда: в реестре нет провайдеров. Укажите --participant или опишите провайдера в ${config}.`,
    templatesHint: (m: string) => `${m} Список и ошибки загрузки: council templates.`,
    noProviders: (config: string) => `Провайдеров нет: CLI claude и codex не найдены. Установите CLI или опишите провайдера в ${config}.`,
    available: "доступен",
    unavailable: (reason: string) => `недоступен: ${reason}`,
    version: (v: string) => `версия ${v}`,
    verified: (level: string, checkedAt: string | null) => `  verified: ${level}${checkedAt === null ? "" : `, ${checkedAt}`}`, // identical in en and ru: field name and values are not translated
    providerWarning: (w: string) => `  предупреждение: ${w}`,
    key: (env: string, set: boolean) => `  ключ: ${env} — ${set ? "задан" : "не задан"}`,
    keyNotRequired: "  ключ: не требуется",
    models: (list: string) => `  модели: ${list}`,
    modelsManual: (id: string) => `перечень не получен — модель указывается вручную: ${id}:<модель>`,
    modelsUnconfirmed: (reason: string) => `  перечень моделей не подтверждён: ${reason}`,
    userSource: "пользовательский",
    builtinSource: "встроенный",
    noTemplates: "Шаблонов нет.",
    loadErrors: "Ошибки загрузки:",
    noLineups: "Составов нет.",
    sessionNotFoundOrDamaged: (id: string) => `Сессия ${id} не найдена или её журнал повреждён.`,
    lineupSaved: (id: string, name: string, n: number) => `Состав ${id} «${name}» сохранён: участников ${n}.`,
    lineupRun: (id: string) => `Запуск: council --topic "<тема>" --lineup ${id}`,
    noSessions: "Сессий нет.",
    sessionNotFound: (id: string) => `Сессия ${id} не найдена.`,
    stopRequested: (id: string) => `Остановка сессии ${id} запрошена.`,
    requestWriteFailed: (m: string) => `Ошибка: не удалось записать запрос — ${m}`,
    continueRequested: (id: string, waitId: string) => `Продолжение сессии ${id} запрошено: ожидание ${waitId} будет снято.`,
    messageWriteFailed: (m: string) => `Ошибка: не удалось записать реплику — ${m}`,
    messageRequested: (id: string) => `Реплика для сессии ${id} запрошена: участники увидят её со следующего хода.`,
    answerRequested: (qid: string, id: string) => `Ответ на вопрос ${qid} для сессии ${id} запрошен: участники увидят его со следующего хода.`,
    resumePlan: (id: string, added: number, max: number, calls: number, active: number, drafts: number) =>
      `Продолжение сессии ${id}: ещё кругов ${added} (общий лимит ${max}), не более ${calls} вызовов моделей (активных участников ${active} × ${added} × 3${drafts > 0 ? ` + остаток вызовов черновиков ${drafts}` : ""}).`,
    replacementWhyUnavailable: (r: string) => `недоступен: ${r}`,
    replacementWhyDropped: (r: string) => `выбыл: ${r}`,
    replacement: (oldId: string, oldName: string, newId: string, newName: string, provider: string, model: string, why: string) => `Замена: ${oldId} «${oldName}» → ${newId} «${newName}» (${provider}:${model}) — причина: ${why}`,
    agreementsReset: "Согласия сброшены: все активные участники подтверждают текущую версию заново.",
    activeLineup: (list: string) => `Активный состав: ${list}.`,
    waitContinues: (waitId: string, deadline: string, id: string) => `Ожидание владельца ${waitId} продолжается до ${deadline}: council continue ${id} или ответ снимут его раньше.`,
    waitExpiredResume: (waitId: string) => `Срок ожидания владельца ${waitId} истёк: обсуждение продолжится сразу.`,
    tokenCapResume: (cap: string, spent: number) => `Потолок токенов: ${cap}, уже израсходовано ${spent}`,
    noCap: "потолка нет",
    droppedRequests: (n: number, id: string) => `Удалено неприменённых реплик владельца: ${n}. Отправьте заново командой council say ${id} "<текст>":`,
    lineup: (name: string, id: string) => `Состав: «${name}» (${id})`,
    lineupNotFound: (id: string) => `Состав «${id}» не найден. Список: council lineups.`,
    lineupUnavailable: (name: string) => `Ошибка: состав «${name}» недоступен:`,
    providerWarn: (id: string, w: string) => `Предупреждение: провайдер «${id}»: ${w}`,
    positionWarn: (n: number, provider: string, model: string, note: string) => `Предупреждение: позиция ${n} (${provider}:${model}): ${note}`,
    scenarioNotFound: (path: string) => `Файл сценария «${path}» не найден.`,
    providerUnavailable: (id: string, reason: string) => `Ошибка: провайдер «${id}» недоступен: ${reason}`,
    capLine: (cap: number, fromRegistry: boolean) => `Потолок токенов: ${cap}${fromRegistry ? " (из реестра)" : ""}`,
    capNone: "Потолок токенов: потолка нет",
    draftsExperiment: (synth: string, name: string, byDefault: boolean, calls: number, n: number, rounds: number) =>
      `Эксперимент «независимые черновики»: синтезатор ${synth} «${name}»${byDefault ? " (по умолчанию — первый участник)" : ""}, не более ${calls} вызовов моделей (участников ${n} × (кругов ${rounds} + 1) × 3).`,
    waitModePause: "пауза после каждого круга",
    waitModeAnswer: "ответ на вопрос владельцу",
    ownerWait: (modes: string, sec: number) => `Ожидание владельца: ${modes}, срок ${sec} с. По истечении срока обсуждение продолжится само в пределах лимита кругов.`,
  },
});
