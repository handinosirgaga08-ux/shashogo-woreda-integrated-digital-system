# SWIDS — Render deployment

## Render Docker deployment

The Dockerfile is configured for a Node.js service. Render provides the runtime `PORT`.

Your Node/Express server must listen on:

```js
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0");
```

Do not hard-code port 5000 for the production listener.

## Important frontend setting

If `admin_panel.html` contains:

```js
const API = "http://localhost:5000/api";
```

that address is only for local development. For production, point the frontend API to the deployed backend URL, for example:

```js
const API = `${window.location.origin}/api`;
```

when the admin panel is served by the same backend.

If the frontend and backend are deployed separately, use the backend's Render URL instead.
