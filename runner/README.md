# CodeMini preview runner

A tiny static site that runs CodeMini's previews on a **different origin** from the app, so a previewed page cannot
read the app's storage (My Keys vault, GitHub token record, device key) or call its functions. It has no build step,
no server code and no secrets: `shell.html` and `shell.js` (previews), `exec.html` and `exec.js` (the Console and Terminal's code-execution host), `config.js`, `index.html` and `vercel.json`. **Redeploy the runner after pulling this version**; without `exec.html` the Console and Terminal simply fall back to running inside the app.

- App: `https://codemini-ide.vercel.app`
- Runner: `https://codemini-runner.vercel.app`

## Deploy (Vercel CLI)

Run these **from inside this `runner/` folder**, not the repo root:

```
cd runner
vercel            # first time: answer the prompts, name the project  codemini-runner
vercel --prod
```

- Framework preset: **Other**. No build command, no output directory (the folder itself is served).
- The project name decides the address. If `codemini-runner` is taken and Vercel gives you another one, change
  `DEFAULT_URL` in `js/viewers/runner-client.js` to match.
- If the app's address is not `codemini-ide.vercel.app`, change it in **both** `config.js` (`allowedParents`) and
  `vercel.json` (`frame-ancestors`). The browser enforces the header; the list is a second check inside the page. Keep `'self'` in the header: the previewed page is framed by the runner's own shell, and some browsers (WebKit) apply the policy to that inner page too.
- Deploy the app from the repo root as before. `.vercelignore` keeps `runner/` out of the app deployment.

## Check it works

1. Open `https://codemini-runner.vercel.app/` in a private window. You should see a short sentence, not a Vercel
   login page. (If you see a login page, switch off Deployment Protection for the production domain in the project's
   settings; the runner holds nothing private.)
2. In CodeMini, preview an HTML file. The toolbar shows a green shield; hovering says **Isolated**. An amber warning
   icon means the runner could not be reached and the preview ran in the app's own origin.
3. In the browser console of the app, `CodeMiniRunner.status()` returns `"isolated"`.

### If the indicator is amber

Tap it (on a phone) or hover it (on a desktop) to read the reason; `CodeMiniRunner.lastError()` shows the same text.
The preview still works, just not isolated.

| Reason says | Meaning |
| --- | --- |
| the runner page did not load | the address is wrong, the project is not deployed, or the network blocks it |
| loaded but did not announce itself | the browser refused to let the app embed it: check `frame-ancestors` in `vercel.json` and `allowedParents` in `config.js` against the app's exact address |
| announced itself but did not accept this app | the app's origin is missing from `allowedParents` |
| the page did not load: the frame still shows about: / stayed empty | the runner works but the browser would not show the page inside it |
| the browser is offline | no attempt was made |


## Settings

Settings > Security > Isolation: **Isolation Mode** (Isolated, recommended, or Normal) for everything, and **Live Preview** (Use global / Isolated / Normal) to override it for previews. The preview's gear menu offers the same Live Preview choice. Console, Terminal and Notebooks are listed as not yet available. Changing it takes effect at once: an open preview rebuilds.

Escape hatches in the browser's `localStorage`:

| Key | Effect |
| --- | --- |
| `codemini_runner` = `off` | forces Normal (not isolated) everywhere, whatever Settings says; an escape hatch |
| `codemini_runner_url` | **localhost only**: use a local runner while developing, e.g. `http://localhost:8766` |

## Run it locally

```
npx http-server runner -p 8766        # or any static server
localStorage.setItem('codemini_runner_url', 'http://localhost:8766')   // in the app on http://localhost:8765
```

`config.js` allows the app on `localhost:8765` only when the runner itself is on localhost.

## Known limits

Pop-out opens `shell.html?popout=1` in a new window and the app hands it the page's files; both reload strategies (Full Navigation and Legacy in-place rewrite) work. Data a previewed page stores lives in this origin, so Factory Reset and Delete Profile ask the runner to clear it. All previews share the runner's origin (see SECURITY.md). The terminal and
notebooks still run inside the app's origin.
