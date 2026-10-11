# Split

A minimal, mobile-friendly expense splitter for trips, dinners and outings. Create an event, add participants, record who paid for what, and get a simplified plan for who should pay whom.

Plain HTML, CSS and JavaScript — no build step, no dependencies, no backend. Data is saved as JSON in your browser's `localStorage` (key `split-data`), so it survives refreshes on the same device and browser. Clear site data to reset.

## Sharing an event

Tap **Share** on an event to get a link (via your phone's share sheet, or copied to the clipboard). The whole event is compressed into the part of the URL after `#`, which is never sent to any server.

Opening the link adds the event to that browser. Opening a newer link for the same event offers to replace the local copy. Copies don't sync: after editing, share a fresh link.

## Run locally

Open `index.html` directly in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy to GitHub Pages

1. Create a GitHub repository and push these files to the `main` branch (at the repository root).
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, select `main` and `/ (root)`, then **Save**.
4. After a minute the app is live at `https://<username>.github.io/<repository>/`.

All asset paths are relative, so the app works from a project subpath.

## How amounts are calculated

- Amounts are stored as integer paise to avoid floating-point errors.
- When an expense doesn't divide evenly, the leftover paise go one each to the first people in the split, so shares always add up exactly to the total.
- Each person's balance = what they paid − their shares. The settlement plan repeatedly matches the person who owes the most with the person owed the most, keeping the number of payments small.
