# Shashogo workflow module: setup

## 1. Install
```
npm init -y
npm i express pg jsonwebtoken dotenv
```

## 2. .env
```
DATABASE_URL=postgres://user:password@localhost:5432/shashogo_test
JWT_SECRET=use-the-same-secret-as-your-existing-login
PORT=3000
```

## 3. Database (TEST copy first!)
```
pg_dump shashogo > backup_before_workflow.sql
psql shashogo_test -f schema.sql
```

## 4. Run
```
node server.js
```

## Endpoints
| Who | Method | Path | Purpose |
|---|---|---|---|
| Anyone | GET | /api/services | List services and required documents |
| Citizen | POST | /api/applications | Apply (returns tracking number) |
| Citizen | GET | /api/my/applications | My applications |
| Any login | GET | /api/applications/:tracking | Status and history |
| Staff | GET | /api/inbox?status=&overdue=true&kebele= | Work queue |
| Staff/Citizen | POST | /api/applications/:id/action | Change status |
| Head/Admin | GET | /api/reports/summary | Dashboard totals |
| Head/Admin | GET | /api/reports/officers | Officer performance |

## Status flow
submitted → in_review → approved → issued
in_review → needs_info → in_review (citizen answers)
in_review → rejected (reason required)

## Test with curl
```
curl -X POST localhost:3000/api/applications \
  -H "Authorization: Bearer <citizen token>" -H "Content-Type: application/json" \
  -d '{"service_id":1,"form_data":{"child_name":"Test"}}'
```

## Next steps
1. Connect your dashboard "inbox" screen to /api/inbox and the action endpoint.
2. Add SMS/push where the TODO is in server.js.
3. Add the citizen apply/track screens in the Android app.
