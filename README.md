![Shashogo Woreda Integrated Digital System banner (Boyo Lake)](boyo-lake.jpg)

# Shashogo Woreda Integrated Digital System (SWIDS)

> An e-government platform for Shashogo Woreda, Hadiya Zone, Central Ethiopia. It brings woreda sector offices, rural kebeles, and citizens into one online system for records, reporting, performance evaluation, and public services.

**Website:** [shashogo.gov.et](https://shashogo.gov.et)

## Overview

The Shashogo Woreda Integrated Digital System (SWIDS) is a unified e-government platform that brings all sectors of Shashogo Woreda, including rural kebeles, into one digital system. It modernizes local service delivery by combining record keeping, reporting, performance evaluation, and citizen services in a single online platform.

## About Shashogo Woreda

Shashogo is a woreda (district) in the Hadiya Zone of Central Ethiopia, about 224 km from Addis Ababa and about 125 km from Hawassa. It borders the Kembata Tembaro Zone to the south, Limo to the west, Ana Lemo to the northwest, the Silt'e Zone to the northeast, and Alaba special woreda to the southeast.

The woreda is made up of 36 kebeles, mostly rural. The 2007 national census counted about 104,000 residents, and more recent estimates are higher. Local livelihoods depend largely on agriculture.

SWIDS was built to help the woreda administration coordinate its sector offices and kebeles, serve citizens faster, and base decisions on up-to-date data.

## Key Features

- **Sector and kebele integration:** all woreda sector offices and rural kebeles work in one system.
- **Records management:** create, search, edit, and delete records with details such as category, kebele, sector, profession, job role, and experience.
- **Performance evaluation:** rate records from 1 to 5 per period, with outcomes (Resolved, Ongoing, Escalated, No Action Needed).
- **Online reporting:** officer reports, periodic reports, and head feedback.
- **Citizen services:** citizens can submit reports (with up to 3 photos) and read announcements and news.
- **Summaries and exports:** dashboard summaries and CSV export of records and evaluations (Excel-friendly, supports Amharic text).
- **Managed lists:** the administrator maintains the Kebele and Sector lists. Renaming an item updates every record that uses it.
- **Installable web app:** includes a manifest and service worker (PWA).
- **Public summary:** an open, anonymous endpoint with aggregate counts only (no names or personal details).

## Roles and Access

Each user sees only the data in their scope. A scoped user with no kebele or sector assigned sees nothing.

| Role | Can see | Notes |
|---|---|---|
| `admin` | Everything | Manages users, kebeles, and sectors |
| `sector_head` | Their sector, across all kebeles | Needs a sector assigned |
| `sector_officer` | Their sector | Needs a sector assigned |
| `kebele_officer` | Their kebele only | Needs a kebele assigned |
| Citizen | Public pages only | Can submit reports without an account |

## Goals

- Improve transparency and accountability across woreda administration.
- Reduce the time and cost for citizens to access government services.
- Strengthen coordination between the woreda and rural kebeles.
- Provide data-driven insight for monitoring and decision-making.

## Target Users

- Woreda sector offices
- Rural kebele administrations
- Citizens of Shashogo Woreda
- Regional oversight bodies

## Technology Stack

- **Frontend:** HTML, CSS, JavaScript (served from `public/`)
- **Backend:** Node.js with Express (`server.js`)
- **Database:** PostgreSQL
- **Security:** helmet, express-rate-limit, bcryptjs, signed HttpOnly session cookies
- **Containerization:** Docker
- **Deployment:** Render-ready (`swids-render-ready.zip`)

## Getting Started

### Prerequisites

- Node.js 18 or higher
- npm
- A PostgreSQL database (local or hosted)
- Docker (optional)

### 1. Install

```bash
git clone https://github.com/handinosirgaga08-ux/shashogo-woreda-integrated-digital-system.git
cd shashogo-woreda-integrated-digital-system
npm install
```

### 2. Configure

Create a file named `.env` in the project folder:

```
DATABASE_URL=postgres://user:password@localhost:5432/swids
SESSION_SECRET=put-a-long-random-value-here-at-least-32-characters
ADMIN_EMAIL=admin@yourdomain.gov.et
ADMIN_PASSWORD=choose-a-strong-password
PORT=5000
```

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | Random secret for signing sessions (32+ characters) |
| `ADMIN_EMAIL` | Yes | Login email of the main administrator |
| `ADMIN_PASSWORD` | Yes | Password of the main administrator (8+ characters) |
| `PORT` | No | Server port (default `5000`) |
| `NODE_ENV` | No | Set to `production` when deployed |
| `DATA_FILE`, `EVAL_FILE` | No | Old JSON files, used only for a one-time import into an empty database |

The server refuses to start if `DATABASE_URL` is missing, or if `SESSION_SECRET` or `ADMIN_PASSWORD` are still default or too weak.

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 3. Run

```bash
node server.js
```

Open `http://localhost:5000`. Tables are created automatically on first start. Sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`, then add kebeles, sectors, and users from the admin panel.

Health check: `GET /api/health`

## Docker

```bash
docker build -t swids .
docker run -p 5000:5000 --env-file .env swids
```

The database must be reachable from the container. Use your host or cloud address in `DATABASE_URL`, not `localhost`.

## Deploying on Render

1. Create a **PostgreSQL** database on Render and copy its connection string.
2. Create a **Web Service** from this repository (or the Docker image).
3. Add the environment variables above, with `NODE_ENV=production`.
4. Set the start command to `node server.js`.
5. Point the domain `shashogo.gov.et` to the service and enable HTTPS.

## Project Structure

```
server.js            Main Express server, auth, records, evaluations, reports
citizen-reports.js   Citizen reports and announcements
officer-reports.js   Officer reports and head feedback
news.js              News
public/              Frontend pages and scripts
manifest.json        Web app manifest
sw.js                Service worker
Dockerfile           Container build
```

## Security

- Passwords are hashed with bcrypt, never stored in plain text.
- Sessions use signed, HttpOnly cookies that expire after 8 hours.
- Login attempts are rate limited.
- All database queries are parameterized.
- Data access is limited by role, kebele, and sector.
- CSV exports are protected against spreadsheet formula injection.
- Always run behind HTTPS in production.
- Never commit `.env` or real tokens to GitHub.

Records can contain personal data (ID numbers, birth dates, phone numbers). Give accounts only the access they need, deactivate accounts of people who leave, and keep database backups secure.

## Install as a Package

This package is hosted on GitHub Packages.

1. Create a GitHub personal access token with the `read:packages` scope.
2. Add this to your project's `.npmrc` file:

```
@handinosirgaga08-ux:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_TOKEN
```

3. Install:

```
npm install @handinosirgaga08-ux/swids
```

Never commit your `.npmrc` with a real token.

## Contributing

Issues and pull requests are welcome. Please describe the problem or change clearly and test locally before submitting.

## License

Add a license here (for example MIT), or state that all rights are reserved.

## Contact

Shashogo Woreda Administration, [shashogo.gov.et](https://shashogo.gov.et)

- Email: [Sirgagahandino946@gmail.com](mailto:Sirgagahandino946@gmail.com)
- Phone: 0920991644
