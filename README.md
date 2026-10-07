![Shashogo Woreda Integrated Digital System](boyo-lake.jpg)

# Shashogo Woreda Integrated Digital System

**Domain:** [shashogo.gov.et](https://shashogo.gov.et)

## Overview

The Shashogo Woreda Integrated Digital System is a unified e-government platform that brings together all sectors of Shashogo Woreda — including rural kebeles — into a single digital domain. It is designed to modernize local government service delivery by consolidating reporting, performance evaluation, and citizen services into one accessible online system.

## Key Features

- **Sector Integration** — Connects all woreda sector offices and rural kebeles under one unified digital platform.
- **Online Reporting** — Enables sectors and kebeles to submit reports digitally, reducing paperwork and delays.
- **Performance Evaluation** — Provides tools to track, measure, and evaluate the performance of sectors and kebeles against set targets.
- **Online Service Delivery** — Allows citizens to access and request government services online, without needing to visit offices in person.
- **Single Domain Access** — All services and information are centralized under `shashogo.gov.et` for ease of access and consistency.

## Goals

- Improve transparency and accountability across woreda administration.
- Reduce the time and cost required for citizens to access government services.
- Strengthen coordination between the woreda level and rural kebeles.
- Provide data-driven insights for performance monitoring and decision-making.

## Target Users

- Woreda sector offices
- Rural kebele administrations
- Citizens of Shashogo Woreda
- Regional oversight bodies

## Technology Stack

- **Frontend:** HTML, CSS, JavaScript
- **Backend:** Node.js (Express-style server via `server.js`)
- **Containerization:** Docker
- **Deployment:** Render-ready build (`swids-render-ready.zip`)
- **Hosting/Domain:** shashogo.gov.et

## Getting Started

Follow the steps below to set up the project locally.

### Prerequisites

- Node.js (v18 or higher)
- npm
- Docker (optional, for containerized deployment)

### Installation

```bash
git clone https://github.com/handinosirgaga08-ux/shashogo-woreda-integrated-digital-system.git
cd shashogo-woreda-integrated-digital-system
# install dependencies
npm install
# run the project
node server.js
```

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
