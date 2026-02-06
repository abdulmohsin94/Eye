# Eye - Session Replay

A self-hosted session replay platform. Record user interactions on your site, then replay them to understand exactly what users experienced.

## Features

- **Full session recording** - mouse movements, clicks, scrolls, input changes, DOM mutations
- **Rage click detection** - automatically flags frustrated users (3+ clicks within 1 second)
- **Privacy-first** - passwords and sensitive fields are masked automatically
- **JS error capture** - records console errors tied to the session timeline
- **Replay dashboard** - play/pause, scrub, speed control (0.5x - 8x), event timeline
- **Zero dependencies on the client** - the recorder snippet is a single vanilla JS file

## Quick Start

```bash
npm install
npm start
```

The dashboard is at `http://localhost:3000`.

## Adding the Snippet to Your Site

Add this single script tag before `</body>` on any page you want to record:

```html
<script>
  window.__EYE_ENDPOINT = "https://your-eye-server.com/api/events";
</script>
<script src="https://your-eye-server.com/snippet/eye-recorder.js"></script>
```

Or copy `snippet/eye-recorder.js` into your own assets and serve it yourself.

### Self-hosted snippet (recommended)

```html
<script src="/assets/eye-recorder.js"></script>
```

The snippet will default to `http://localhost:3000/api/events` if `__EYE_ENDPOINT` is not set.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/events` | Ingest recorded events |
| GET | `/api/sessions` | List all sessions (paginated) |
| GET | `/api/sessions/:id` | Get session details |
| GET | `/api/sessions/:id/events` | Get all events for a session |
| DELETE | `/api/sessions/:id` | Delete a session |

## Architecture

```
snippet/eye-recorder.js   Client-side recorder (add to your site)
server/index.js           Express API server
server/db.js              SQLite storage layer
public/                   Replay dashboard (HTML/CSS/JS)
```

## Client SDK API

The snippet exposes `window.__eye` with these methods:

```js
// Identify the current user
__eye.identify("user-123", { plan: "pro", email: "..." });

// Track custom events
__eye.track("add_to_cart", { product: "Widget", price: 29.99 });

// Access session ID
console.log(__eye.sessionId);
```
