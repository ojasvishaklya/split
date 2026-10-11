# Split

A minimal expense splitter for trips and outings. Add people and expenses, and see who pays whom.

Plain HTML/CSS/JS with no build step or backend. Data is saved in the browser's `localStorage`.

**Live:** https://ojasvishaklya.github.io/split/

## Features

- Events with participants and expenses, including splits among only some participants
- Balances and a simplified settlement plan (amounts in exact paise)
- **Copy summary** for WhatsApp
- **Share** link: the event is compressed into the URL `#fragment`. Opening it imports the event. Copies don't sync, so share a fresh link after editing.

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

## Deploy

Push to `main`, then open **Settings → Pages → Deploy from a branch** and select `main` / root.
