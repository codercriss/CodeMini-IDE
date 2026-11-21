# CodeMini Content and Usage Rules

Rules version: **v1** (2026-11-21)

CodeMini is an offline-first IDE that runs in your browser. Your files stay on your device. These rules say what content CodeMini is meant to host, and what it treats as unacceptable when content is **imported, shared, installed or run**.

They are not legal terms. The [LICENSE](LICENSE) covers the software. These rules cover the content brought into it, and they are what the project's checks point at, so that a warning can say *which* rule it is about. They are also not a security boundary: the boundaries are the ones described in [SECURITY.md](SECURITY.md) (Isolation, Workspace Trust, escaping). The rules say what to look for.

## What CodeMini is meant to host

- Source code, notebooks, data files, documents and assets for your own projects.
- Web pages and scripts you write or have chosen to run, previewed or run in the isolated runner.
- Projects, snippets, themes and extensions that people share with each other on purpose.

## The rules

| Id | Rule | Default response |
| --- | --- | --- |
| P1 | Do not target CodeMini itself | Held by policy |
| P2 | Do not bypass protections | Held by policy |
| P3 | Do not collect or send out private data | Suspicious |
| P4 | No malicious or deceptive content | Held by policy |
| P5 | No abuse of the user's device or of other people's services | Suspicious |
| P6 | Content CodeMini cannot use | Notice |

Ids are stable. A rule keeps its id for as long as it exists, and an id is never reused for a different rule.

### P1. Do not target CodeMini itself

**Rule.** Content must not read or change CodeMini's own data or internals.

**Covers.** Code that reads or writes CodeMini's own storage (its IndexedDB databases, `localStorage` entries that start with `codemini_`, the My Keys vault, the Shield database), calls the app's own functions or globals, or registers a service worker for the app's origin.

**Does not cover.** Your own workspace files, handled through CodeMini's own features. Tutorials and examples that use IndexedDB or `localStorage` with their own names.

**Default response:** Held by policy

### P2. Do not bypass protections

**Rule.** Content must not try to get around Isolation, Workspace Trust or the app's checks.

**Covers.** Code that tries to reach the page that embeds it (`parent`, `top`), forges or replays the runner's control messages or nonces, switches off or weakens Isolation or Workspace Trust, or tries to disable or tamper with a check.

**Does not cover.** You changing your own settings in Settings > Security.

**Default response:** Held by policy

### P3. Do not collect or send out private data

**Rule.** Content must not gather private data and send it somewhere the user did not choose.

**Covers.** Reading cookies, storage, the clipboard or key presses and sending them to another host; hidden forms or frames that submit data; keys, tokens or passwords left inside a package that is being shared.

**Does not cover.** A page that handles its own form data for its own purpose, or code that calls an API with a key you chose to give it.

**Default response:** Suspicious

### P4. No malicious or deceptive content

**Rule.** Content must not be built to harm or deceive.

**Covers.** Phishing pages (a login form that posts to another host, or one that imitates another service), cryptocurrency miners, loaders and droppers that fetch and run hidden payloads, ransomware-like behaviour (bulk encrypting or deleting files), and deliberately obfuscated code whose purpose is to hide any of these.

**Does not cover.** Clearly labelled teaching or research material. A person who has reviewed such an item can choose to trust that exact item; CodeMini still holds it by default, because a check looks at patterns and cannot read intent.

**Default response:** Held by policy

### P5. No abuse of the user's device or of other people's services

**Rule.** Content must not be built to overload a device or to attack other services.

**Covers.** Unbounded loops or memory use meant to freeze the page, floods of requests against one host, and scanning of other hosts or ports.

**Does not cover.** Ordinary heavy computation, benchmarks, and requests to your own services.

**Default response:** Suspicious

### P6. Content CodeMini cannot use

**Rule.** Content that CodeMini cannot open or run is reported, because it can be risky elsewhere.

**Covers.** Installers, disk images and native programs (for example `.exe`, `.msi`, `.dmg`, `.apk`, `.jar`), archives that expand to extreme sizes or are nested many levels deep, and files whose real type does not match their extension.

**Does not cover.** Normal images, fonts, documents, data and archives.

**Default response:** Notice

## How the rules are applied

- **Findings name the rule.** A finding shows its id (for example P3), what was matched and where, and why it matters.
- **Verdict words.** *Clean* means "no known risky patterns were found". It never means "safe". The others are *Notice*, *Suspicious*, *Held by policy* and *Not fully checked* (a scan that could not finish, for example a very large file).
- **Held by policy.** An item with this response is not brought in with a single click. It goes to a quarantine where it can be reviewed or deleted.
- **Your choice.** You can trust a specific item you have reviewed. Workspace configuration (`.codemini/`) can never relax a rule.
- **Nothing is deleted for you.** A check holds or warns; it does not remove your files.

## Status: what enforces these rules today

- **In the app today:** Workspace Trust (Restricted Mode), Isolation (code runs on the separate runner origin), escaping and sanitising of text and HTML the app shows, locked files, and your own review. These limit what content can do. They do **not** read content against P1 to P6.
- **Planned, not built:** CodeMini Guard, a built-in checker that screens content against these rules and shows the rule id next to each finding, and a review step in CodeMini Share that uses it. Until those exist, this document is guidance for users, contributors and anyone who shares a package.

## If you share or import content

- Share only what you are happy for the other person to have, and remove keys and tokens first.
- Treat an unknown sender's package like any download. The sender's name is whatever they typed.
- Keep Isolation on, and open projects you do not recognise in Restricted Mode.

## Reporting

- **A security problem** (a way around Isolation, Workspace Trust or encryption): report it privately as described in [SECURITY.md](SECURITY.md). Do not open a public issue.
- **A question about a rule, a wrongly flagged item, or a rule that is missing:** open an issue at <https://github.com/codercriss/CodeMini-IDE/issues>.

Privacy is covered in [PRIVACY.md](PRIVACY.md).

## Changes to these rules

| Version | Date | Change |
| --- | --- | --- |
| v1 | 2026-11-21 | First version: rules P1 to P6. |
