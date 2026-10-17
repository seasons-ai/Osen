# result-usage: token tile on the "Result" screen

Scripted participants for a live check: the spend of failed attempts counts toward the session's token total.

- `p1.json`, `p3.json` — correct `amend` replies, 300 + 200 tokens per turn.
- `p2.json` — two invalid replies in a row (400 + 300 each): the engine drops the participant (`participant_dropped`) on the first turn.
- Round 1: p1 500, p2 two failed attempts of 700 each (1400), p3 500 = 2400 ≥ 2000: status `stopped`, reason `token_cap`.
- Completed turns give 1000 tokens; together with p2's failed attempts — 2400.

Command (0 model calls):

`COUNCIL_DEV=1 COUNCIL_HOME=.council-data/result-usage-X npx council --topic "Какой формат выбрать для еженедельного отчёта?" --participant scripted:packages/core/scenarios/result-usage/p1.json --participant scripted:packages/core/scenarios/result-usage/p2.json --participant scripted:packages/core/scenarios/result-usage/p3.json --max-rounds 3 --max-tokens 2000`
