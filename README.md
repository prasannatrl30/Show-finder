# Show Finder

A mood-based show and film recommendation app powered by the Google Gemini API. Describe how you're feeling or what kind of story you're in the mood for, and get personalised picks instantly.

## Setup

**1. Clone and install**

```bash
git clone <your-repo-url>
cd show-finder
npm install
```

**2. Add your Gemini API key**

Get a free key at [aistudio.google.com](https://aistudio.google.com), then:

```bash
cp .env.example .env
# Edit .env and replace the placeholder with your key
```

**3. Start the server**

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Development

```bash
npm run dev   # auto-restarts on file changes
```

## Stack

- **Frontend** — Vanilla HTML/CSS/JS (single file)
- **Backend** — Node.js + Express
- **AI** — Google Gemini API (`gemini-flash-lite-latest`)
